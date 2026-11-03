"""Persistent read-only prototype worker. Stdout is exclusively bounded JSONL.

No path or SQL in a request. A changed manifest is verified before switching;
bad publication fails closed for that request rather than serving a stale success.
"""
import contextlib
import json
import resource
import sqlite3
import sys
from catalog import Catalog, CatalogError, canonical, parse_json, require, workspace

MAX_REQUEST = 4096
MAX_RESPONSE = 256 * 1024

def serve(root, incoming, outgoing):
    catalogue, anchor = None, None
    try:
        while True:
            line = incoming.readline(MAX_REQUEST + 1)
            if not line:
                break
            # Cannot resynchronise an oversized/truncated stream safely. No echo.
            if len(line) > MAX_REQUEST or not line.endswith(b'\n'):
                return 2
            identity = None
            try:
                message = parse_json(line)
                require(type(message) is dict and message.keys() == {'v', 'id', 'op', 'args'}, 'invalid-worker-request')
                require(type(message['v']) is int and message['v'] == 1 and type(message['id']) is int and 0 < message['id'] <= 2**53-1, 'invalid-worker-request')
                identity = message['id']
                op, args = message['op'], message['args']
                require(type(op) is str and op in ('search', 'barcode', 'product', 'inspect') and type(args) is dict, 'invalid-worker-operation')
                require(set(args) in ({'query','page','pageSize'}, {'query','page','pageSize','language'}) if op == 'search' else args.keys() == ({'code'} if op in ('barcode','product') else set()), 'invalid-worker-arguments')
                manifest_path = root / 'current.json'
                require(not manifest_path.is_symlink(), 'unsafe-manifest')
                with manifest_path.open('rb') as handle:
                    current = handle.read(4097)
                require(len(current) <= 4096, 'oversized-manifest')
                if current != anchor:
                    replacement = Catalog(root, parse_json(current))
                    if catalogue:
                        catalogue.close()
                    catalogue, anchor = replacement, current
                result = catalogue.search(args['query'], args['page'], args['pageSize'], args.get('language','fr')) if op == 'search' else catalogue.barcode(args['code']) if op in ('barcode','product') else catalogue.manifest
                if op == 'product' and result is not None:
                    result = {'product':result,'catalogueVersion':catalogue.manifest['sha256'],'fixture':catalogue.manifest['source']['kind']=='fixture'}
                response = {'v': 1, 'id': identity, 'ok': True, 'result': result}
                require(len(canonical(response).encode()) <= MAX_RESPONSE, 'worker-response-too-large')
            except (CatalogError, OSError, sqlite3.Error, MemoryError) as error:
                response = {'v': 1, 'id': identity, 'ok': False, 'error': str(error) if isinstance(error, CatalogError) else 'catalogue-unavailable'}
            outgoing.write((canonical(response)+'\n').encode())
            outgoing.flush()
    finally:
        if catalogue:
            catalogue.close()
    return 0

if __name__ == '__main__':
    # Only a validated prototype workspace; never a client-selected filesystem path.
    try:
        require(len(sys.argv) == 2, 'invalid-worker-arguments')
        root = workspace(sys.argv[1], create=False)
        soft, hard = resource.getrlimit(resource.RLIMIT_AS)
        resource.setrlimit(resource.RLIMIT_AS, (min(soft, 256*1024*1024) if soft != -1 else 256*1024*1024, hard))
        sys.exit(serve(root, sys.stdin.buffer, sys.stdout.buffer))
    except (CatalogError, OSError):
        # No filesystem paths, account data or traceback in the protocol/log.
        print('catalogue-worker-unavailable', file=sys.stderr)
        sys.exit(1)
