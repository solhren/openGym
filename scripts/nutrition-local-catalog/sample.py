"""Bounded official viewer sampler; plan by default, explicit --fetch only.

No retries, redirects, tokens, arbitrary hosts or full dataset download. Captures
are reproducible by retained bytes/hashes, not by unstable row offsets on main.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import socket
import signal
import sys
import ssl
import errno
import http.client
import uuid
import time
import urllib.error
import urllib.parse
import urllib.request
from catalog import BASE, CatalogError, canonical, require, resources

DATASET = 'openfoodfacts/product-database'
MAX_PAGE = 8 * 1024 * 1024
MAX_TOTAL = 32 * 1024 * 1024

def plan(total, pages=10, length=100, language=None):
    require(type(total) is int and 1 <= total <= 10000000 and type(pages) is int and 1 <= pages <= 20 and type(length) is int and 1 <= length <= 100, 'invalid-sampling-budget')
    require(language is None or (type(language) is str and re.fullmatch('[a-z]{2,3}', language)), 'invalid-sampling-language')
    require(pages*length <= total, 'overlapping-sampling-plan')
    # One bounded slice per equally spaced stratum. This is systematic sampling,
    # not a random or representative sample of French purchasing behaviour.
    offsets = [0] if pages == 1 else [i*(total-length)//(pages-1) for i in range(pages)]
    result = []
    for offset in offsets:
        params = {'dataset': DATASET, 'config': 'default', 'split': 'food', 'offset': offset, 'length': length}
        if language:
            params['where'] = f'"lang"=\'{language}\''
        url = 'https://datasets-server.huggingface.co/'+('filter' if language else 'rows')+'?'+urllib.parse.urlencode(params)
        result.append({'offset': offset, 'length': length, 'populationRows': total, 'url': url})
    return result

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None

def network_error(error):
    reason = error.reason if isinstance(error, urllib.error.URLError) else error
    if isinstance(reason, socket.gaierror): return 'sample-dns-error'
    if isinstance(reason, (TimeoutError, socket.timeout)): return 'sample-timeout'
    if isinstance(reason, ssl.SSLError): return 'sample-tls-error'
    if isinstance(reason, http.client.IncompleteRead): return 'sample-truncated-response'
    if isinstance(reason, OSError) and reason.errno in (errno.EPERM, errno.EACCES): return 'sample-network-permission-denied'
    if isinstance(reason, OSError) and reason.errno in (errno.ECONNREFUSED, errno.ECONNRESET, errno.ENETUNREACH, errno.EHOSTUNREACH): return 'sample-connection-error'
    return 'sample-network-error'

def acquire(url, opener, remaining, timeout):
    require(remaining > 0, 'sample-total-size-exceeded')
    parsed = urllib.parse.urlsplit(url)
    require(parsed.scheme == 'https' and parsed.netloc == 'datasets-server.huggingface.co' and parsed.path in ('/rows', '/filter') and not parsed.fragment, 'unsafe-sample-url')
    deadline = time.monotonic()+timeout
    request = urllib.request.Request(url, headers={'User-Agent': 'openGym-catalog-prototype/1.4.1 (https://github.com/solhren/openGym)', 'Accept': 'application/json', 'Accept-Encoding': 'identity'})
    try:
        with opener.open(request, timeout=timeout) as response:
            require(response.status == 200, 'sample-http-status')
            require(response.headers.get_content_type() == 'application/json', 'sample-unexpected-content-type')
            announced = response.headers.get('Content-Length')
            require(announced is None or (announced.isdigit() and int(announced) <= min(MAX_PAGE, remaining)), 'sample-page-too-large')
            data = bytearray()
            while True:
                require(time.monotonic() < deadline, 'sample-deadline-exceeded')
                chunk = response.read(min(65536, min(MAX_PAGE, remaining)-len(data)+1))
                if not chunk:
                    break
                data.extend(chunk)
                require(len(data) <= min(MAX_PAGE, remaining), 'sample-page-too-large')
            require(announced is None or len(data) == int(announced), 'sample-truncated-response')
            return bytes(data), {'etag': response.headers.get('ETag'), 'lastModified': response.headers.get('Last-Modified')}
    except urllib.error.HTTPError as error:
        cooldown = error.headers.get('Retry-After', '')
        code = 'sample-provider-rate-limited' if error.code == 429 else 'sample-provider-unavailable' if error.code == 503 else 'sample-http-error-'+str(error.code)
        error.close()
        raise CatalogError(code + (('-retry-after-'+cooldown) if re.fullmatch(r'\d{1,5}', cooldown) else '')) from None
    except (urllib.error.URLError, OSError, http.client.IncompleteRead) as error:
        raise CatalogError(network_error(error)) from None

def save(root, name, data):
    require(re.fullmatch(r'(?:page-\d{3}\.json|sample-manifest\.json)', name), 'unsafe-sample-filename')
    temporary = root / ('.sample-'+uuid.uuid4().hex+'.tmp')
    try:
        with temporary.open('xb') as file:
            os.chmod(temporary, 0o600)
            require(file.write(data) == len(data), 'sample-incomplete-write')
            file.flush(); os.fsync(file.fileno())
        os.link(temporary, root/name) # Atomic, never overwrite an older capture.
        temporary.unlink()
        directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
        try: os.fsync(directory)
        finally: os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)

def capture(root, requests, opener=None, time_budget=600):
    require(root.is_dir() and not root.is_symlink(), 'unsafe-sample-workspace')
    opener = opener or urllib.request.build_opener(NoRedirect())
    manifest = {'format': 'opengym-hf-sample', 'version': 1, 'source': 'https://huggingface.co/datasets/'+DATASET, 'license': 'ODbL-1.0', 'contentLicense': 'DbCL-1.0', 'attribution': 'Open Food Facts contributors', 'capturedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'complete': False, 'pages': [], 'maxBytes': MAX_TOTAL, 'maxSeconds': time_budget}
    start, used, total, schema, indices = time.monotonic(), 0, None, None, set()
    try:
        for request in requests:
            resources(root)
            remaining_time = time_budget-(time.monotonic()-start)
            require(remaining_time > 0, 'sample-deadline-exceeded')
            data, headers = acquire(request['url'], opener, MAX_TOTAL-used, min(30, remaining_time))
            used += len(data)
            # json.loads is bounded by byte ceiling; strict full schema is validated
            # by huggingface.mjs before any import. No source schema invented here.
            def pairs(items):
                result = {}
                for key, value in items:
                    require(key not in result and key not in ('__proto__', 'constructor', 'prototype'), 'sample-unsafe-or-duplicate-key')
                    result[key] = value
                return result
            def constant(_):
                raise CatalogError('sample-nonfinite-json')
            try:
                envelope = json.loads(data.decode('utf8'), object_pairs_hook=pairs, parse_constant=constant)
            except (ValueError, UnicodeError, RecursionError):
                raise CatalogError('sample-invalid-json')
            require(type(envelope) is dict and envelope.get('partial') is False and type(envelope.get('features')) is list and type(envelope.get('rows')) is list and 0 < len(envelope['rows']) <= request['length'], 'sample-partial-or-invalid-envelope')
            require(type(envelope.get('num_rows_total')) is int and envelope['num_rows_total'] <= 10000000, 'sample-invalid-total')
            fingerprint = hashlib.sha256(canonical(envelope['features']).encode()).hexdigest()
            if total is None:
                total, schema = envelope['num_rows_total'], fingerprint
                # A single offset-zero page is also a population-size probe. A
                # distributed capture must use the observed current/filter total.
                require(len(requests) == 1 or total == request['populationRows'], 'sample-population-changed')
            require(total == envelope['num_rows_total'] and schema == fingerprint, 'sample-dataset-changed')
            for item in envelope['rows']:
                require(type(item) is dict and type(item.get('row_idx')) is int and 0 <= item['row_idx'] < 10000000 and item['row_idx'] not in indices and item.get('truncated_cells') == [], 'sample-truncated-or-duplicate-row')
                indices.add(item['row_idx'])
            name = f'page-{len(manifest["pages"]):03d}.json'
            save(root, name, data)
            manifest['pages'].append({**request, 'file': name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(), 'rows': len(envelope['rows']), **headers})
        manifest.update(complete=True, bytes=used, rows=len(indices), totalRowsReported=total, schemaSha256=schema)
    except CatalogError as error:
        manifest['error'] = str(error)
        raise
    except (OSError, MemoryError):
        manifest['error'] = 'sample-storage-or-resource-error'
        raise
    finally:
        manifest['seconds'] = time.monotonic()-start
        save(root, 'sample-manifest.json', (canonical(manifest)+'\n').encode())
    return manifest

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--total', type=int, required=True, help='observed total of rows or filter; never assume global total for filtered rows')
    parser.add_argument('--pages', type=int, default=10)
    parser.add_argument('--length', type=int, default=100)
    parser.add_argument('--language')
    parser.add_argument('--fetch', action='store_true')
    parser.add_argument('--workspace', default='off-sample-diverse')
    args = parser.parse_args()
    try:
        requests = plan(args.total, args.pages, args.length, args.language)
        if not args.fetch:
            print(canonical({'plan': requests, 'maxRows': args.pages*args.length, 'maxBytes': MAX_TOTAL, 'maxSeconds': 600, 'networkRequests': 0})); return 0
        require(re.fullmatch('[a-zA-Z0-9_-]{1,40}', args.workspace) and not BASE.is_symlink(), 'invalid-workspace')
        BASE.mkdir(exist_ok=True, mode=0o700)
        root = BASE / args.workspace
        root.mkdir(mode=0o700) # Exclusive new workspace, no clobbering old captures.
        soft, hard = resource.getrlimit(resource.RLIMIT_AS)
        resource.setrlimit(resource.RLIMIT_AS, (min(soft, 256*1024*1024) if soft != -1 else 256*1024*1024, hard))
        def expired(*_):
            raise CatalogError('sample-deadline-exceeded')
        # Scoped process watchdog; urllib's per-socket timeout alone is not a
        # complete download deadline for a slow stream. No system configuration.
        signal.signal(signal.SIGALRM, expired); signal.alarm(600)
        try:
            print(canonical(capture(root, requests)))
        finally:
            signal.alarm(0)
    except (CatalogError, OSError, MemoryError) as error:
        print(canonical({'error': str(error) if isinstance(error, CatalogError) else 'sample-storage-or-resource-error'}), file=sys.stderr); return 1
    return 0

if __name__ == '__main__':
    sys_exit = main()
    raise SystemExit(sys_exit)
