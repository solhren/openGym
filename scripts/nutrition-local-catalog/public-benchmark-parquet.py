"""Open Prices Parquet capture/projection for the existing public benchmark.

No Dataset Viewer /filter, nutrition import, application database or query hits.
Fetch pins an official Hub revision and LFS SHA-256. Projection scans bounded
Arrow batches and deduplicates on private SQLite disk before seeded sampling.
"""
import argparse
import collections
import datetime
import hashlib
import http.client
import importlib.util
import json
import os
from pathlib import Path
import re
import resource
import signal
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from catalog import BASE, CatalogError, canonical, digest_file, parse_json, require, resources
from sample import network_error

DATASET = 'openfoodfacts/open-prices'
METADATA = 'https://huggingface.co/api/datasets/'+DATASET+'?blobs=true'
MAX_FILE = 64*1024**2
MAX_METADATA = 1024**2
MAX_ROWS = 2000000
MAX_FOOTER = 4*1024**2
MAX_WORKSPACE = 256*1024**2
BATCH = 256
MAX_SECONDS = 600
FORMAT = 'opengym-open-prices-parquet'
PROJECT_FORMAT = 'opengym-public-price-projection'
s = importlib.util.spec_from_file_location('public_cases', Path(__file__).with_name('public-benchmark.py'))
bench = importlib.util.module_from_spec(s); s.loader.exec_module(bench)


def root_for(name, create=False):
    require(type(name) is str and re.fullmatch('[A-Za-z0-9_-]{1,40}', name) and not BASE.is_symlink(), 'unsafe-workspace')
    BASE.mkdir(mode=0o700, exist_ok=True)
    root = BASE/name
    require(not root.is_symlink(), 'unsafe-workspace')
    if create: root.mkdir(mode=0o700)
    require(root.is_dir(), 'missing-workspace')
    return root


def save(root, name, value):
    require(name in ('capture.json', 'sample-manifest.json'), 'unsafe-manifest-name')
    temporary = root/('.'+name+'.tmp')
    try:
        with temporary.open('xb') as f:
            os.chmod(temporary, 0o600); f.write((canonical(value)+'\n').encode()); f.flush(); os.fsync(f.fileno())
        os.link(temporary, root/name)
        fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
        try: os.fsync(fd)
        finally: os.close(fd)
    finally: temporary.unlink(missing_ok=True)


def safe_url(url):
    p = urllib.parse.urlsplit(url)
    hosts = {'huggingface.co', 'cdn-lfs.huggingface.co', 'cdn-lfs.hf.co', 'cas-bridge.xethub.hf.co',
             'us.aws.cdn.hf.co', 'eu.aws.cdn.hf.co'}
    require(p.scheme == 'https' and p.hostname in hosts and p.port in (None, 443) and not p.username and not p.password and not p.fragment, 'unsafe-parquet-url')
    if p.hostname == 'huggingface.co':
        require(p.path in ('/api/datasets/'+DATASET, ) or re.fullmatch('/datasets/'+DATASET+r'/resolve/[a-f0-9]{40}/prices\.parquet', p.path), 'unsafe-parquet-url')
    return p.hostname


class Redirect(urllib.request.HTTPRedirectHandler):
    def __init__(self): super().__init__(); self.hops = 0
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        safe_url(newurl); self.hops += 1; require(self.hops <= 4, 'parquet-redirect-limit')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def open_response(opener, url, timeout):
    safe_url(url)
    try:
        response = opener.open(urllib.request.Request(url, headers={'User-Agent':'openGym-benchmark/1.4.1 (https://github.com/solhren/openGym)', 'Accept-Encoding':'identity'}), timeout=timeout)
        require(response.status == 200, 'parquet-http-status')
        if hasattr(response, 'geturl'): safe_url(response.geturl())
        return response
    except urllib.error.HTTPError as error:
        code = error.code; error.close(); raise CatalogError('parquet-http-error-'+str(code)) from None
    except (urllib.error.URLError, OSError, http.client.IncompleteRead) as error:
        raise CatalogError(network_error(error).replace('sample-', 'parquet-')) from None


def read_network(response, amount):
    # Keep timeouts/truncation during a body read distinct from ENOSPC while
    # persisting that body. No request is retried after either failure.
    try: return response.read(amount)
    except (urllib.error.URLError, OSError, http.client.IncompleteRead) as error:
        raise CatalogError(network_error(error).replace('sample-', 'parquet-')) from None


def metadata(value):
    require(type(value) is dict and value.get('id') == DATASET and type(value.get('sha')) is str and re.fullmatch('[a-f0-9]{40}', value['sha']), 'invalid-parquet-metadata')
    files = value.get('siblings'); require(type(files) is list and len(files) <= 100, 'invalid-parquet-metadata')
    matches = [r for r in files if type(r) is dict and r.get('rfilename') == 'prices.parquet']
    require(len(matches) == 1, 'missing-parquet-metadata'); lfs = matches[0].get('lfs')
    require(type(lfs) is dict and type(lfs.get('size')) is int and 12 <= lfs['size'] <= MAX_FILE and type(lfs.get('sha256')) is str and re.fullmatch('[a-f0-9]{64}', lfs['sha256']), 'invalid-parquet-lfs-metadata')
    return value['sha'], lfs['size'], lfs['sha256']


def footer(file):
    size = file.stat().st_size
    require(12 <= size <= MAX_FILE, 'parquet-file-size')
    with file.open('rb') as f:
        require(f.read(4) == b'PAR1', 'invalid-parquet-magic'); f.seek(-8, 2); end = f.read(8)
    length = int.from_bytes(end[:4], 'little')
    require(end[4:] == b'PAR1' and 0 < length <= min(MAX_FOOTER, size-12), 'invalid-parquet-footer')
    return length


def fetch(name, opener=None):
    root = root_for(name, True); resources(root); start = time.monotonic()
    receipt = {'format':FORMAT, 'version':1, 'complete':False, 'dataset':DATASET,
               'capturedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(), 'license':'ODbL-1.0',
               'attribution':'Open Prices / Open Food Facts contributors', 'maxBytes':MAX_FILE, 'maxSeconds':MAX_SECONDS,
               'networkRetries':0, 'containsPrivatePublicSourceFields':True}
    opener = opener or urllib.request.build_opener(Redirect())
    part = root/'prices.parquet.part'
    try:
        with open_response(opener, METADATA, 30) as r:
            raw = read_network(r, MAX_METADATA+1); require(len(raw) <= MAX_METADATA, 'parquet-metadata-size')
        value = parse_json(raw.decode('utf8')); revision, size, sha = metadata(value)
        url = 'https://huggingface.co/datasets/'+DATASET+'/resolve/'+revision+'/prices.parquet'
        receipt.update(revision=revision, sourceUrl=url, expectedBytes=size, expectedSha256=sha,
                       metadataSha256=hashlib.sha256(raw).hexdigest())
        require(resources(root)['freeDiskBytes']-size >= 20*1024**3, 'insufficient-free-disk')
        h = hashlib.sha256(); used = 0
        with open_response(opener, url, 30) as r, part.open('xb') as f:
            os.chmod(part, 0o600)
            length = r.headers.get('Content-Length'); require(length is None or length.isdigit() and int(length) == size, 'parquet-content-length')
            require((r.headers.get('Content-Encoding') or 'identity') == 'identity', 'parquet-content-encoding')
            while True:
                require(time.monotonic()-start < MAX_SECONDS, 'parquet-deadline'); resources(root)
                chunk = read_network(r, min(65536, size-used+1))
                if not chunk: break
                used += len(chunk); require(used <= size, 'parquet-oversized-response')
                require(f.write(chunk) == len(chunk), 'parquet-incomplete-write'); h.update(chunk)
            f.flush(); os.fsync(f.fileno())
        require(used == size, 'parquet-truncated-response'); require(h.hexdigest() == sha, 'parquet-checksum-mismatch')
        footer(part); os.link(part, root/'prices.parquet'); part.unlink()
        receipt.update(complete=True, file='prices.parquet', bytes=used, sha256=h.hexdigest())
    except (CatalogError, OSError, ValueError, UnicodeError, http.client.IncompleteRead) as error:
        receipt['error'] = str(error) if isinstance(error, CatalogError) else network_error(error).replace('sample-', 'parquet-') if isinstance(error, (urllib.error.URLError, http.client.IncompleteRead)) else 'parquet-read-or-storage-error'
        raise CatalogError(receipt['error']) from None
    finally:
        part.unlink(missing_ok=True); receipt['seconds'] = time.monotonic()-start; save(root, 'capture.json', receipt)
    return receipt


def verified_capture(name):
    root = root_for(name); f = root/'capture.json'
    require(not f.is_symlink() and f.stat().st_size <= 65536, 'unsafe-parquet-receipt')
    receipt = parse_json(f.read_text())
    require(receipt.get('format') == FORMAT and receipt.get('version') == 1 and receipt.get('complete') is True and receipt.get('dataset') == DATASET, 'invalid-parquet-receipt')
    revision, size, sha = metadata({'id':DATASET, 'sha':receipt.get('revision'), 'siblings':[{'rfilename':'prices.parquet','lfs':{'size':receipt.get('bytes'), 'sha256':receipt.get('sha256')}}]})
    require(receipt.get('file') == 'prices.parquet' and receipt.get('sourceUrl') == 'https://huggingface.co/datasets/'+DATASET+'/resolve/'+revision+'/prices.parquet' and receipt.get('expectedSha256') == sha and receipt.get('expectedBytes') == size, 'invalid-parquet-receipt')
    file = root/'prices.parquet'; require(not file.is_symlink() and file.is_file() and file.stat().st_size == size and digest_file(file) == sha, 'corrupt-parquet-capture'); footer(file)
    return file, receipt


def peak_rss_kib():
    """Linux high-water RSS since exec, not the launcher's inherited rusage.

    ru_maxrss can retain the pre-exec parent's peak even when the new Python
    process is small. /proc/self/status VmHWM measures this executable's peak.
    Fail closed if that measurement is unavailable; never raise the budget.
    """
    for line in Path('/proc/self/status').read_text().splitlines():
        match = re.fullmatch(r'VmHWM:\s+(\d+) kB', line)
        if match: return int(match[1])
    raise CatalogError('parquet-process-memory-unavailable')


def arrow_rows(file, report):
    try:
        import pyarrow as pa
        import pyarrow.parquet as pq
    except ImportError: raise CatalogError('parquet-reader-missing-install-isolated-pyarrow') from None
    pa.set_cpu_count(1); pa.set_io_thread_count(1)
    try:
        reader = pq.ParquetFile(file, memory_map=False, pre_buffer=False, thrift_string_size_limit=1024**2,
                                thrift_container_size_limit=200000, page_checksum_verification=True, arrow_extensions_enabled=False)
        schema = reader.schema_arrow; names = schema.names
        require(len(names) == len(set(names)) <= 200, 'invalid-parquet-schema')
        required = {'id','product_code','location_osm_address_country_code'}
        require(required <= set(names), 'missing-parquet-country-or-identity-column')
        for name in required | ({'product_name','category_tag'} & set(names)):
            kind = schema.field(name).type
            valid = pa.types.is_integer(kind) if name == 'id' else (pa.types.is_string(kind) or pa.types.is_large_string(kind) or pa.types.is_null(kind))
            require(valid, 'invalid-parquet-column-type')
        require(0 < reader.metadata.num_rows <= MAX_ROWS and reader.metadata.num_row_groups <= 20000, 'parquet-row-budget')
        require(sum(reader.metadata.row_group(i).total_byte_size for i in range(reader.metadata.num_row_groups)) <= 2*1024**3, 'parquet-expanded-size-budget')
        columns = sorted(required | ({'product_name','category_tag'} & set(names)))
        # Bound each selected row-group expansion before Arrow decodes any pages.
        for i in range(reader.metadata.num_row_groups):
            g = reader.metadata.row_group(i)
            require(sum(g.column(j).total_uncompressed_size for j in range(g.num_columns) if g.column(j).path_in_schema in columns) <= 64*1024**2, 'parquet-row-group-budget')
        report.update(rows=reader.metadata.num_rows, rowGroups=reader.metadata.num_row_groups,
                      schema=[{'name':f.name, 'type':str(f.type), 'nullable':f.nullable} for f in schema],
                      projectedColumns=columns, reader='pyarrow', readerVersion=pa.__version__)
        for batch in reader.iter_batches(batch_size=BATCH, columns=columns, use_threads=False):
            allocated = pa.total_allocated_bytes(); peak = peak_rss_kib()
            if not (batch.nbytes <= 4*1024**2 and allocated <= 192*1024**2 and peak <= 512*1024):
                print(canonical({'event':'parquet-memory-budget','batchBytes':batch.nbytes,'arrowAllocatedBytes':allocated,'peakRssKiB':peak}),file=sys.stderr)
                raise CatalogError('parquet-batch-memory-budget')
            yield from batch.to_pylist()
    except CatalogError: raise
    except Exception as error: raise CatalogError('invalid-parquet-data-'+type(error).__name__) from None


def bounded_string(value, maximum):
    return value if type(value) is str and len(value) <= maximum and not re.search(r'[\x00-\x1f\x7f]', value) else None


def project(source, name, cases=1000, seed='opengym-public-v1', row_reader=None):
    require(type(cases) is int and 100 <= cases <= 2000 and type(seed) is str and re.fullmatch('[A-Za-z0-9_-]{1,80}', seed), 'invalid-benchmark-budget')
    file, capture = verified_capture(source); root = root_for(name, True); budget = resources(root)
    require(budget['freeDiskBytes']-MAX_WORKSPACE >= 20*1024**3, 'insufficient-free-disk')
    require(budget['availableMemoryBytes']-512*1024**2 >= 2*1024**3, 'insufficient-available-memory')
    manifest = {'format':PROJECT_FORMAT, 'version':1, 'complete':False, 'dataset':DATASET, 'source':'prices-fr-parquet',
                'license':'ODbL-1.0', 'attribution':'Open Prices / Open Food Facts contributors', 'seed':seed,
                'sourceCapture':source, 'sourceCaptureSha256':digest_file(file.parent/'capture.json'),
                'sourceRevision':capture['revision'], 'inputSha256':capture['sha256'], 'inputBytes':capture['bytes'],
                'sourceIsQueryLog':False, 'selectedUsingCatalogueResults':False, 'representativeOfFrenchPurchases':False,
                'samplingLimit':'seeded product identities after complete FR census; contributor observations, not a national purchase panel'}
    start = time.monotonic(); cpu = time.process_time(); counts = collections.Counter(); schema_report = {}
    db = sqlite3.connect(root/'dedup.sqlite'); os.chmod(root/'dedup.sqlite', 0o600)
    db.execute('PRAGMA cache_size=-8192'); db.execute('PRAGMA temp_store=FILE'); db.execute('PRAGMA max_page_count=32768')
    db.execute('CREATE TABLE identities (key TEXT PRIMARY KEY, code TEXT, source_id INTEGER, name TEXT, category TEXT, conflict INTEGER NOT NULL, rank TEXT NOT NULL, observations INTEGER NOT NULL)')
    db.execute('CREATE TABLE observations (id INTEGER PRIMARY KEY)')
    part = root/'projection.jsonl.part'
    try:
        for row in (row_reader or arrow_rows)(file, schema_report):
            counts['sourceRows'] += 1
            require(counts['sourceRows'] <= MAX_ROWS and time.monotonic()-start < MAX_SECONDS, 'parquet-projection-budget')
            if counts['sourceRows'] % 1024 == 1:
                resources(root); require(sum(p.stat().st_size for p in root.iterdir() if p.is_file()) <= MAX_WORKSPACE, 'parquet-workspace-budget'); db.commit()
            require(type(row) is dict and type(row.get('id')) is int and 0 <= row['id'] < 2**63, 'invalid-parquet-observation-id')
            try: db.execute('INSERT INTO observations VALUES (?)', (row['id'],))
            except sqlite3.IntegrityError: raise CatalogError('duplicate-parquet-observation-id') from None
            country = row.get('location_osm_address_country_code'); require(country is None or type(country) is str and len(country) <= 8, 'invalid-parquet-country')
            if country != 'FR': counts['outsideFrance'] += 1; continue
            counts['frenchObservations'] += 1
            raw_code = row.get('product_code'); require(raw_code is None or type(raw_code) is str, 'invalid-parquet-barcode-type')
            code = raw_code if type(raw_code) is str and re.fullmatch(r'(?:\d{8}|\d{12,14})', raw_code, re.ASCII) else None
            if raw_code and not code: counts['malformedBarcodeObservations'] += 1
            if not code: counts['observationsWithoutSupportedBarcode'] += 1
            key = bench.ids.canonical(code) if code else 'raw:'+str(row['id'])
            name = bounded_string(row.get('product_name'), 300)
            if name is not None: name = name.strip() or None
            if row.get('product_name') is not None and name is None: counts['missingOrUnsupportedTitleObservations'] += 1
            category = bounded_string(row.get('category_tag'), 300)
            rank = hashlib.sha256((seed+'\0'+key).encode()).hexdigest()
            old = db.execute('SELECT code, source_id, name, category, conflict FROM identities WHERE key=?', (key,)).fetchone()
            if old:
                conflict = bool(old[4]) or bool(old[2] and name and old[2] != name)
                new_name = None if conflict else old[2] or name
                new_code = min(old[0], code) if code else None
                db.execute('UPDATE identities SET code=?, source_id=?, name=?, category=?, conflict=?, observations=observations+1 WHERE key=?',
                           (new_code, min(old[1], row['id']), new_name, min(v for v in (old[3],category) if v is not None) if old[3] or category else None, int(conflict), key))
                counts['duplicateProductObservations'] += 1
            else: db.execute('INSERT INTO identities VALUES (?,?,?,?,?,?,?,1)', (key, code, row['id'], name, category, 0, rank))
        require(counts['sourceRows'] == schema_report.get('rows'), 'incomplete-parquet-scan')
        db.commit(); require(db.execute('PRAGMA quick_check').fetchone()[0] == 'ok', 'corrupt-projection-index')
        population = db.execute('SELECT count(*) FROM identities').fetchone()[0]; require(population > 0, 'no-french-observations')
        missing = db.execute('SELECT count(*) FROM identities WHERE name IS NULL').fetchone()[0]
        conflicts = db.execute('SELECT count(*) FROM identities WHERE conflict=1').fetchone()[0]
        n = 0
        with part.open('xb') as f:
            os.chmod(part, 0o600)
            for key, code, source_id, name_value, category, conflict, rank, observations in db.execute('SELECT * FROM identities ORDER BY rank, key LIMIT ?', (cases,)):
                out = {'sourceId':str(source_id), 'code':code, 'name':name_value, 'brand':None, 'france':True, 'category':category,
                       'identityKey':key, 'observations':observations, 'conflictingSourceNames':bool(conflict)}
                f.write((canonical(out)+'\n').encode()); n += 1
            f.flush(); os.fsync(f.fileno())
        os.link(part, root/'projection.jsonl'); part.unlink()
        manifest.update(complete=True, rows=n, requestedCases=cases, eligibleUniqueProducts=population, unresolvedUniqueTitles=missing,
                        conflictingUniqueTitles=conflicts, counts=dict(counts), parquet=schema_report,
                        projectionFile='projection.jsonl', projectionBytes=(root/'projection.jsonl').stat().st_size,
                        projectionSha256=digest_file(root/'projection.jsonl'), sourceRowsLimit=MAX_ROWS,
                        privacy='Projection excludes owners, receipts, images, shop identities/locations, prices and dates. Raw capture remains private.')
    except (CatalogError, OSError, sqlite3.Error, MemoryError) as error:
        manifest['error'] = str(error) if isinstance(error, CatalogError) else 'parquet-projection-storage-or-memory-error'
        raise CatalogError(manifest['error']) from None
    finally:
        db.close(); part.unlink(missing_ok=True)
        manifest.update(seconds=time.monotonic()-start, cpuSeconds=time.process_time()-cpu, peakRssKiB=peak_rss_kib(), memoryMetric='linux-process-VmHWM')
        save(root, 'sample-manifest.json', manifest)
    return manifest


def main():
    p = argparse.ArgumentParser(); sub = p.add_subparsers(dest='command', required=True)
    f = sub.add_parser('fetch'); f.add_argument('--workspace', required=True); f.add_argument('--fetch', action='store_true')
    q = sub.add_parser('project'); q.add_argument('--source', required=True); q.add_argument('--workspace', required=True); q.add_argument('--cases', type=int, default=1000); q.add_argument('--seed', default='opengym-public-v1')
    a = p.parse_args()
    # Arrow reserves virtual address space: do not reuse the 256 MiB RLIMIT_AS.
    # Check RSS between bounded batches; this is not a kernel memory reservation.
    resource.setrlimit(resource.RLIMIT_CPU, (300, 300))
    signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(CatalogError('parquet-deadline'))); signal.alarm(MAX_SECONDS)
    try:
        if a.command == 'fetch' and not a.fetch:
            result = {'metadataUrl':METADATA, 'maxFileBytes':MAX_FILE, 'maxSeconds':MAX_SECONDS, 'pinnedRevisionAndLfsChecksumRequired':True, 'networkRequests':0, 'note':'Explicit --fetch: one metadata request and one pinned file; bounded HTTPS redirects, no retry. No /filter.'}
        elif a.command == 'fetch': result = fetch(a.workspace)
        else: result = project(a.source, a.workspace, a.cases, a.seed)
        print(canonical(result))
    except (CatalogError, OSError, ValueError, MemoryError) as error:
        print(canonical({'error':str(error) if isinstance(error, CatalogError) else 'parquet-storage-or-memory-error'}), file=sys.stderr); return 1
    finally: signal.alarm(0)
    return 0

if __name__ == '__main__': sys.exit(main())
