#!/usr/bin/env python3
"""Bounded JSONL reads of one verified, immutable public Ciqual generation."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import resource
import sqlite3
import stat
import sys
import time

spec = importlib.util.spec_from_file_location('opengym_public_bootstrap', Path(__file__).with_name('public-bootstrap.py'))
bootstrap = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = bootstrap
spec.loader.exec_module(bootstrap)


def require(ok):
    if not ok:
        raise ValueError('invalid-catalogue-request')


def unique_object(pairs):
    value = {}
    for key, item in pairs:
        require(key not in value)
        value[key] = item
    return value


class Reader:
    def __init__(self, directory, inspector=bootstrap.inspect_generation):
        self.fd = None
        self.connection = None
        self.manifest = inspector(directory)
        file = Path(directory) / self.manifest['file']
        self.fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            before = os.fstat(self.fd)
            require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size == self.manifest['bytes'])
            digest = hashlib.sha256()
            with os.fdopen(os.dup(self.fd), 'rb') as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b''):
                    digest.update(block)
            require(digest.hexdigest() == self.manifest['sha256'])
            # Pin the descriptor which was hashed. A later current.json publication cannot
            # redirect this process to a different generation. This Linux/POSIX reader is
            # shipped in the public Docker profile; no writable SQLite handle is opened.
            self.connection = sqlite3.connect(f'file:/proc/self/fd/{self.fd}?mode=ro&immutable=1', uri=True)
            self.connection.execute('PRAGMA query_only=ON')
            self.connection.execute('PRAGMA trusted_schema=OFF')
            self.connection.enable_load_extension(False)
            self.connection.create_function('opengym_fold', 1, bootstrap.fold_text, deterministic=True)
        except Exception:
            self.close()
            raise

    def close(self):
        if self.connection is not None:
            self.connection.close()
            self.connection = None
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None

    def record(self, raw, lc):
        value = bootstrap.localize_record(json.loads(raw), lc)
        bootstrap.validate_record(value, self.manifest['source']['sha256'], self.manifest['namesSource']['sha256'])
        return value

    def read(self, op, args):
        require(isinstance(args, dict))
        deadline = time.monotonic() + 2
        self.connection.set_progress_handler(lambda: int(time.monotonic() > deadline), 1000)
        if op == 'inspect':
            require(not args)
            return self.manifest
        lc = args.get('lc', 'fr')
        require(isinstance(lc, str) and re.fullmatch('[a-z]{2}', lc))
        if op == 'barcode':
            require(set(args) <= {'code', 'lc'} and isinstance(args.get('code'), str) and re.fullmatch(r'(?:\d{8}|\d{12,14})', args['code']))
            return []  # Ciqual supplies no product GTINs. Never infer a commercial identity.
        if op == 'product':
            require(set(args) <= {'id', 'lc'} and isinstance(args.get('id'), str) and re.fullmatch(r'ciqual:[0-9]{1,8}', args['id']))
            row = self.connection.execute('SELECT payload FROM foods WHERE id=?', (args['id'],)).fetchone()
            return self.record(row[0], lc) if row else None
        require(op == 'search' and set(args) <= {'q', 'page', 'lc'})
        q, page = args.get('q'), args.get('page', 1)
        require(isinstance(q, str) and 2 <= len(q) <= 120 and not re.search(r'[\x00-\x1f\x7f]', q) and type(page) is int and 1 <= page <= 20)
        tokens = re.findall(r'[^\W_]+', bootstrap.fold_text(q), re.UNICODE)
        require(1 <= len(tokens) <= 8 and all(len(token) <= 40 for token in tokens))
        expression = ' AND '.join('"' + token + '"*' for token in tokens)
        whole_terms = ' AND '.join("instr(' '||f.folded||' ',?)>0" for token in tokens)
        count = self.connection.execute('SELECT count(*) FROM foods_fts WHERE foods_fts MATCH ?', (expression,)).fetchone()[0]
        rows = self.connection.execute('SELECT f.payload FROM foods_fts JOIN foods f ON f.rowid=foods_fts.rowid '
            'WHERE foods_fts MATCH ? ORDER BY '
            '(opengym_fold(f.name)=? OR opengym_fold(coalesce(json_extract(f.payload,\'$.source.names.en\'),\'\'))=?) DESC,'
            '(' + whole_terms + ') DESC,'
            '(instr(opengym_fold(f.name)||\' \',?)=1 OR instr(opengym_fold(coalesce(json_extract(f.payload,\'$.source.names.en\'),\'\'))||\' \',?)=1) DESC,'
            'f.addable DESC,f.complete DESC,bm25(foods_fts),f.name COLLATE NOCASE,f.id LIMIT 20 OFFSET ?',
            (expression, bootstrap.fold_text(q), bootstrap.fold_text(q), *(' ' + token + ' ' for token in tokens),
             bootstrap.fold_text(q) + ' ', bootstrap.fold_text(q) + ' ', (page - 1) * 20)).fetchall()
        return {'products': [self.record(row[0], lc) for row in rows], 'count': count, 'page': page,
                'pageSize': 20, 'literalOnly': True, 'registryVerified': True,
                'catalogueVersion': self.manifest['sha256']}


def serve(directory, inspector=bootstrap.inspect_generation):
    reader = Reader(directory, inspector=inspector)
    try:
        for raw in iter(lambda: sys.stdin.buffer.readline(4097), b''):
            if len(raw) > 4096 or not raw.endswith(b'\n'):
                raise ValueError('invalid-catalogue-frame')
            request = json.loads(raw.decode('utf-8', 'strict'), object_pairs_hook=unique_object,
                                 parse_constant=lambda value: require(False))
            require(isinstance(request, dict) and set(request) == {'v', 'id', 'op', 'args'} and request['v'] == 1 and
                    type(request['id']) is int and request['id'] > 0 and isinstance(request['op'], str))
            response = {'v': 1, 'id': request['id']}
            try:
                response.update(ok=True, result=reader.read(request['op'], request['args']))
            except (ValueError, sqlite3.Error):
                response.update(ok=False, error='catalogue-read-refused')
            wire = json.dumps(response, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode('utf-8')
            require(len(wire) <= 256 * 1024 - 1)
            sys.stdout.buffer.write(wire + b'\n')
            sys.stdout.buffer.flush()
    finally:
        reader.close()


if __name__ == '__main__':
    try:
        resource.setrlimit(resource.RLIMIT_AS, (128 * 1024 ** 2, 128 * 1024 ** 2))
        require(len(sys.argv) == 2)
        serve(sys.argv[1])
    except Exception:
        print('Public catalogue reader refused the generation or protocol', file=sys.stderr)
        sys.exit(1)
