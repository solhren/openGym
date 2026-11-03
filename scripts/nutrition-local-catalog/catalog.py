"""Isolated, read-only FTS prototype. No openGym data directory is ever opened.

Only sealed immutable generations can become current. A failed writer leaves the
old manifest authoritative; readers pin one generation for their whole lifetime.
"""
import argparse
import contextlib
import fcntl
from functools import lru_cache
import hashlib
import json
import math
import os
from pathlib import Path
import re
import resource
import shutil
import sqlite3
import sys
import time
import unicodedata
import uuid
from fuzzy import create_index, fallback_match

BASE = Path(__file__).resolve().parent / 'artifacts'
MAX_LINE = 16384
MAX_PRODUCTS = 100000
MAX_DB = 512 * 1024 * 1024
FORMAT = 'opengym-off-catalog-prototype'
APPLICATION_ID = 0x4F474643
KEYS = {'code', 'name', 'nameFr', 'brand', 'countries', 'reference', 'nutrients', 'portions', 'warnings', 'modifiedAt'}
WARNINGS = {'estimated-values', 'reference-required', 'serving-only', 'missing-values', 'export-qualifiers-unavailable', 'source-quality-warning', 'nutrition-rejected'}

@lru_cache(maxsize=4096)
def search_text(value):
    # Match the accent-insensitive token vocabulary, without inventing popularity.
    value = ''.join(c for c in unicodedata.normalize('NFD', value.lower()) if not unicodedata.combining(c))
    return ' '.join(re.findall(r'[^\W_]+', value, re.UNICODE))

class CatalogError(Exception):
    pass

def require(condition, code):
    if not condition:
        raise CatalogError(code)

def workspace(name, create=True):
    require(isinstance(name, str) and re.fullmatch(r'[a-zA-Z0-9_-]{1,40}', name), 'invalid-workspace')
    require(not BASE.is_symlink(), 'unsafe-workspace')
    if create:
        BASE.mkdir(exist_ok=True, mode=0o700)
    root = BASE / name
    require(not root.is_symlink(), 'unsafe-workspace')
    if create:
        root.mkdir(exist_ok=True, mode=0o700)
    else:
        require(root.is_dir(), 'missing-catalogue-workspace')
    return root

def resources(root):
    # Conservative availability checks, not a reservation against other services.
    available = next(int(line.split()[1]) * 1024 for line in Path('/proc/meminfo').read_text().splitlines() if line.startswith('MemAvailable:'))
    free = shutil.disk_usage(root).free
    require(available >= 2 * 1024 * 1024 * 1024, 'insufficient-available-memory')
    require(free >= 20 * 1024 * 1024 * 1024, 'insufficient-free-disk')
    allocated = sum(p.stat().st_size for p in root.iterdir() if p.is_file() and not p.is_symlink())
    require(allocated <= 2 * 1024 * 1024 * 1024, 'workspace-disk-budget-exceeded')
    return {'availableMemoryBytes': available, 'freeDiskBytes': free}

def canonical(value):
    # JSON has one numeric type, whereas SQLite REAL returns 6.0 for an input 6.
    # Collapse exact integral floats (including -0.0), never round a decimal.
    # All accepted fields are bounded far below the exact IEEE integer limit.
    def numbers(item):
        if type(item) is float and math.isfinite(item) and item.is_integer():
            return int(item)
        if type(item) is dict:
            return {key: numbers(v) for key, v in item.items()}
        if type(item) is list:
            return [numbers(v) for v in item]
        return item
    return json.dumps(numbers(value), ensure_ascii=False, separators=(',', ':'), sort_keys=True, allow_nan=False)

def parse_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result and key not in ('__proto__', 'prototype', 'constructor'), 'unsafe-or-duplicate-json-key')
            result[key] = value
        return result
    try:
        result = json.loads(raw, object_pairs_hook=pairs, parse_constant=lambda _: (_ for _ in ()).throw(CatalogError('nonfinite-json')))
        pending, nodes = [(result, 0)], 0
        while pending:
            item, depth = pending.pop()
            nodes += 1
            require(nodes <= 20000 and depth <= 12, 'oversized-or-deep-json')
            if type(item) is dict:
                pending.extend((v, depth + 1) for v in item.values())
            elif type(item) is list:
                require(len(item) <= 1000, 'oversized-json-array')
                pending.extend((v, depth + 1) for v in item)
            elif type(item) is str:
                require(len(item) <= 10000, 'oversized-json-string')
        return result
    except (ValueError, RecursionError):
        raise CatalogError('invalid-json')

def text(value, limit, empty=True):
    return isinstance(value, str) and len(value) <= limit and (empty or bool(value.strip())) and not any(ord(c) < 32 for c in value)

def numeric(value, maximum):
    return value is None or (type(value) in (int, float) and math.isfinite(value) and 0 <= value <= maximum)

def validate_record(record):
    require(type(record) is dict and record.keys() == KEYS, 'invalid-record-fields')
    require(isinstance(record['code'], str) and re.fullmatch(r'(?:\d{8}|\d{12,14})', record['code'], re.ASCII), 'invalid-barcode')
    require(text(record['name'], 300, False) and text(record['nameFr'], 300) and text(record['brand'], 300), 'invalid-text')
    require(type(record['countries']) is list and len(record['countries']) <= 100, 'invalid-countries')
    require(all(isinstance(c, str) and re.fullmatch(r'[a-z]{2}:[a-z0-9-]{1,60}', c) for c in record['countries']), 'invalid-countries')
    require(len(set(record['countries'])) == len(record['countries']), 'invalid-countries')
    ref = record['reference']
    require(ref is None or (type(ref) is dict and ref.keys() == {'amount', 'unit'} and ref['amount'] == 100 and type(ref['amount']) in (int, float) and ref['unit'] in ('g', 'ml')), 'invalid-reference')
    nutrients = record['nutrients']
    require(type(nutrients) is dict and nutrients.keys() == {'kcal', 'protein', 'carbs', 'fat'}, 'invalid-nutrients')
    require(all(numeric(v, 2000 if k == 'kcal' else 100) for k, v in nutrients.items()), 'invalid-nutrients')
    require(ref is not None or all(v is None for v in nutrients.values()), 'ambiguous-reference')
    require(type(record['warnings']) is list and len(record['warnings']) <= len(WARNINGS) and all(type(v) is str and v in WARNINGS for v in record['warnings']), 'invalid-warnings')
    require(numeric(record['modifiedAt'], 10**12), 'invalid-modified-time')
    require(record['modifiedAt'] is None or type(record['modifiedAt']) is int, 'invalid-modified-time')
    require(type(record['portions']) is list and len(record['portions']) <= 1, 'invalid-portions')
    for p in record['portions']:
        require(type(p) is dict and p.keys() == {'id', 'label', 'amount', 'unit'} and p['id'] == 'off-serving' and text(p['label'], 200, False), 'invalid-portions')
        require(numeric(p['amount'], 100000) and p['amount'] is not None and p['amount'] > 0 and ref is not None and p['unit'] == ref['unit'], 'invalid-portions')
    return record

def validate_source(source):
    require(type(source) is dict and source.keys() == {'kind', 'version', 'inputSha256', 'scanned', 'rejected', 'filtered'}, 'invalid-source')
    require(source['kind'] in ('fixture', 'off-jsonl', 'off-tsv') and text(source['version'], 120, False) and type(source['inputSha256']) is str and re.fullmatch(r'[a-f0-9]{64}', source['inputSha256']), 'invalid-source')
    require(all(type(source[k]) is int and 0 <= source[k] <= MAX_PRODUCTS for k in ('scanned', 'rejected', 'filtered')), 'invalid-source')
    require(source['rejected'] + source['filtered'] <= source['scanned'], 'invalid-source-counts')
    return source

def fsync_directory(root):
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)

def digest_file(path):
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(65536), b''):
            digest.update(chunk)
    return digest.hexdigest()

def safe_file(root, name):
    require(type(name) is str and re.fullmatch(r'catalog-[a-f0-9]{32}\.sqlite', name), 'invalid-generation-path')
    path = root / name
    require(not path.is_symlink() and path.is_file(), 'missing-or-unsafe-generation')
    return path

def write_manifest(root, value):
    temporary = root / ('manifest-' + uuid.uuid4().hex + '.tmp')
    try:
        with temporary.open('x', encoding='utf8') as handle:
            handle.write(canonical(value))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, root / 'current.json')
        fsync_directory(root)
    finally:
        temporary.unlink(missing_ok=True)

def previous_manifest(manifest):
    # One rollback anchor, never a recursively growing chain in current.json.
    return {k: v for k, v in manifest.items() if k != 'previous'}

@contextlib.contextmanager
def writer_lock(root):
    require(not (root / 'writer.lock').is_symlink(), 'unsafe-lock')
    with (root / 'writer.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise CatalogError('writer-busy')
        yield

def build(root, stream, failpoint=None):
    """Input is a normalizer protocol, not a public import format. EOF without
    its final matching seal cannot publish, even if every received row was valid.
    Tests inject interruptions only into disposable workspaces.
    """
    require(not (root / 'writer.lock').is_symlink(), 'unsafe-lock')
    start = time.perf_counter()
    before = resources(root)
    with writer_lock(root):
        old = None
        if (root / 'current.json').exists() or (root / 'current.json').is_symlink():
            with contextlib.closing(Catalog(root)) as current:
                old = previous_manifest(current.manifest)
        # SQLite cache is small; RLIMIT also caps unexpected in-process allocation.
        soft, hard = resource.getrlimit(resource.RLIMIT_AS)
        cap = 256 * 1024 * 1024
        resource.setrlimit(resource.RLIMIT_AS, (min(soft, cap) if soft != -1 else cap, hard))
        generation = 'catalog-' + uuid.uuid4().hex + '.sqlite'
        partial = root / (generation + '.partial')
        database = root / generation
        connection = None
        count = duplicates = 0
        digest = hashlib.sha256()
        seal = None
        try:
            connection = sqlite3.connect(partial)
            connection.executescript('''
                PRAGMA page_size=4096;
                PRAGMA cache_size=-8192;
                PRAGMA temp_store=FILE;
                PRAGMA journal_mode=DELETE;
                PRAGMA synchronous=FULL;
                PRAGMA max_page_count=131072;
                PRAGMA user_version=3;
                CREATE TABLE products (
                    id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE,
                    name TEXT NOT NULL, name_fr TEXT NOT NULL, brand TEXT NOT NULL,
                    name_fold TEXT NOT NULL, name_fr_fold TEXT NOT NULL, brand_fold TEXT NOT NULL,
                    countries TEXT NOT NULL, reference_unit TEXT,
                    kcal REAL, protein REAL, carbs REAL, fat REAL,
                    portions TEXT NOT NULL, warnings TEXT NOT NULL, modified_at INTEGER,
                    complete INTEGER NOT NULL CHECK(complete IN (0,1)),
                    record_hash TEXT NOT NULL
                ) STRICT;
                CREATE VIRTUAL TABLE products_fts USING fts5(
                    name, name_fr, brand, content='products', content_rowid='id',
                    tokenize='unicode61 remove_diacritics 2', prefix='3 4'
                );
                CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
            ''')
            # Constants must match the reader; no writable extension or SQL supplied by input.
            connection.execute(f'PRAGMA application_id={APPLICATION_ID}')
            for raw in iter(lambda: stream.readline(MAX_LINE + 1), b''):
                require(len(raw) <= MAX_LINE and raw.endswith(b'\n'), 'oversized-or-truncated-protocol-line')
                try:
                    item = parse_json(raw)
                except (ValueError, RecursionError):
                    raise CatalogError('invalid-protocol-json')
                require(type(item) is dict, 'invalid-protocol')
                if 'seal' in item:
                    require(item.keys() == {'seal'} and seal is None, 'invalid-seal')
                    seal = item['seal']
                    require(type(seal) is dict and seal.keys() == {'count', 'digest', 'source'}, 'invalid-seal')
                    continue
                require(seal is None and item.keys() == {'record'}, 'invalid-protocol-order')
                record = validate_record(item['record'])
                count += 1
                require(count <= MAX_PRODUCTS, 'too-many-products')
                digest.update(raw)
                rh = hashlib.sha256(canonical(record).encode()).hexdigest()
                previous = connection.execute('SELECT record_hash FROM products WHERE code=?', (record['code'],)).fetchone()
                if previous:
                    require(previous[0] == rh, 'incompatible-duplicate-barcode')
                    duplicates += 1
                else:
                    n = record['nutrients']
                    connection.execute('INSERT INTO products(code,name,name_fr,brand,name_fold,name_fr_fold,brand_fold,countries,reference_unit,kcal,protein,carbs,fat,portions,warnings,modified_at,complete,record_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                        (record['code'], record['name'], record['nameFr'], record['brand'], search_text(record['name']), search_text(record['nameFr']), search_text(record['brand']), canonical(record['countries']), record['reference']['unit'] if record['reference'] else None,
                         n['kcal'], n['protein'], n['carbs'], n['fat'], canonical(record['portions']), canonical(record['warnings']), record['modifiedAt'], int(record['reference'] is not None and all(v is not None for v in n.values())), rh))
                if count % 500 == 0:
                    connection.commit()
                    resources(root)
                if failpoint == 'rows':
                    raise CatalogError('simulated-interruption-rows')
            require(seal is not None and type(seal['count']) is int and seal['count'] == count and seal['digest'] == digest.hexdigest(), 'missing-or-mismatched-seal')
            source = validate_source(seal['source'])
            require(source['scanned'] == count + source['rejected'] + source['filtered'], 'incomplete-source-accounting')
            require(count > 0, 'empty-catalogue')
            ingest_seconds = time.perf_counter() - start
            phase = time.perf_counter()
            connection.execute("INSERT INTO products_fts(products_fts) VALUES ('rebuild')")
            connection.execute("INSERT INTO products_fts(products_fts,rank) VALUES ('integrity-check',1)")
            create_index(connection, search_text, lambda: resources(root))
            fts_seconds = time.perf_counter() - phase
            connection.execute('INSERT INTO metadata VALUES (?,?)', ('source', canonical(source)))
            license_note = 'Synthetic fixtures; AGPL-3.0-or-later; not OFF data' if source['kind'] == 'fixture' else 'ODbL-1.0; DbCL-1.0; Open Food Facts contributors'
            connection.execute('INSERT INTO metadata VALUES (?,?)', ('license', license_note))
            connection.commit()
            phase = time.perf_counter()
            require(connection.execute('PRAGMA integrity_check').fetchall() == [('ok',)], 'sqlite-integrity-failed')
            # Verify actual SQLite reconstruction, including numeric affinity,
            # before publishing. Read one row at a time, not the whole catalogue.
            connection.row_factory = sqlite3.Row
            for row in connection.execute('SELECT * FROM products'):
                Catalog.record(None, row)
            connection.row_factory = None
            verification_seconds = time.perf_counter() - phase
            # Availability smoke checks must execute the built FTS index. Empty
            # matches are legitimate on a country/subset export, never fabricated.
            for term in ('nutella', 'coca cola', 'lait', 'riz', 'pates', 'yaourt'):
                match = ' AND '.join('"' + token + '"' for token in term.split())
                connection.execute('SELECT rowid FROM products_fts WHERE products_fts MATCH ? LIMIT 1', (match,)).fetchone()
            sizes = {name: size for name, size in connection.execute('SELECT name,sum(pgsize) FROM dbstat GROUP BY name')}
            rows = connection.execute('SELECT count(*) FROM products').fetchone()[0]
            connection.close()
            connection = None
            require(partial.stat().st_size <= MAX_DB, 'catalogue-too-large')
            with partial.open('rb') as handle:
                os.fsync(handle.fileno())
            if failpoint == 'verified':
                raise CatalogError('simulated-interruption-verified')
            os.replace(partial, database)
            fsync_directory(root)
            phase = time.perf_counter()
            manifest = {'format': FORMAT, 'version': 3, 'file': generation, 'sha256': digest_file(database), 'bytes': database.stat().st_size, 'products': rows, 'source': source, 'previous': old}
            if failpoint == 'generation':
                raise CatalogError('simulated-interruption-generation')
            resources(root)
            write_manifest(root, manifest)
            if failpoint == 'published':
                raise CatalogError('simulated-interruption-published')
            usage = resource.getrusage(resource.RUSAGE_SELF)
            return {'temporaryStorage': 'workspace' if os.environ.get('SQLITE_TMPDIR') and Path(os.environ['SQLITE_TMPDIR']).resolve() == root.resolve() else 'environment-default', 'products': rows, 'duplicates': duplicates, 'bytes': manifest['bytes'], 'ftsBytes': sum(v for k, v in sizes.items() if k.startswith('products_fts')), 'barcodeIndexBytes': sizes.get('sqlite_autoindex_products_1', 0), 'pageAllocation': sizes, 'seconds': time.perf_counter() - start, 'ingestSeconds': ingest_seconds, 'ftsSeconds': fts_seconds, 'verificationSeconds': verification_seconds, 'hashPublicationSeconds': time.perf_counter()-phase, 'peakRssKiB': usage.ru_maxrss, 'cpuSeconds': usage.ru_utime + usage.ru_stime, 'resourcesBefore': before, 'generation': generation}
        finally:
            if connection:
                connection.close()
            # Only this writer's unpublished partial/journal may be removed.
            partial.unlink(missing_ok=True)
            Path(str(partial) + '-journal').unlink(missing_ok=True)

class Catalog:
    """Pin current generation, verify its hash before opening immutable read-only.
    Queries return bounded records; no SQL/FTS syntax or path comes from a request.
    """
    def __init__(self, root, manifest=None):
        self.connection = None
        try:
            if manifest is None:
                require(not (root / 'current.json').is_symlink(), 'unsafe-manifest')
                require((root / 'current.json').stat().st_size <= 4096, 'oversized-manifest')
                raw = (root / 'current.json').read_bytes()
                require(len(raw) <= 4096, 'oversized-manifest')
                manifest = parse_json(raw)
            base_keys = {'format', 'version', 'file', 'sha256', 'bytes', 'products', 'source'}
            require(type(manifest) is dict and set(manifest) in (base_keys, base_keys | {'previous'}), 'invalid-manifest')
            previous = manifest.get('previous')
            require(previous is None or (type(previous) is dict and previous.keys() == base_keys), 'invalid-previous-manifest')
            require(manifest['format'] == FORMAT and type(manifest['version']) is int and manifest['version'] in (1, 2, 3), 'unsupported-format')
            require(type(manifest['bytes']) is int and 0 < manifest['bytes'] <= MAX_DB and type(manifest['products']) is int and 0 < manifest['products'] <= MAX_PRODUCTS, 'invalid-manifest')
            require(type(manifest['sha256']) is str and re.fullmatch(r'[a-f0-9]{64}', manifest['sha256']), 'invalid-manifest-hash')
            source = validate_source(manifest['source'])
            require(manifest['products'] <= source['scanned'] - source['rejected'] - source['filtered'], 'invalid-source-counts')
            path = safe_file(root, manifest['file'])
            require(path.stat().st_size == manifest['bytes'] and digest_file(path) == manifest['sha256'], 'corrupt-generation')
            self.manifest = manifest
            self.connection = sqlite3.connect(path.as_uri() + '?mode=ro&immutable=1', uri=True)
            self.connection.row_factory = sqlite3.Row
            self.connection.execute('PRAGMA query_only=ON')
            self.connection.execute('PRAGMA cache_size=-4096')
            self.connection.execute('PRAGMA trusted_schema=OFF')
            self.connection.execute('PRAGMA temp_store=FILE')
            self.connection.execute('PRAGMA mmap_size=0')
            require(self.connection.execute('PRAGMA application_id').fetchone()[0] == APPLICATION_ID and self.connection.execute('PRAGMA user_version').fetchone()[0] == manifest['version'], 'invalid-database-schema')
            expected_columns = {'id', 'code', 'name', 'name_fr', 'brand', 'countries', 'reference_unit', 'kcal', 'protein', 'carbs', 'fat', 'portions', 'warnings', 'modified_at', 'complete', 'record_hash'}
            if manifest['version'] >= 2:
                expected_columns.update(('name_fold', 'name_fr_fold', 'brand_fold'))
            require({r[1] for r in self.connection.execute('PRAGMA table_info(products)')} == expected_columns, 'invalid-database-schema')
            if manifest['version'] == 3:
                for table, columns in [('search_terms', {'term','expansion'}), ('search_grams', {'gram','length','term'})]:
                    require({r[1] for r in self.connection.execute('PRAGMA table_info(' + table + ')')} == columns, 'invalid-database-schema')
            require(self.connection.execute('SELECT count(*) FROM products').fetchone()[0] == manifest['products'], 'incomplete-catalogue')
            require(json.loads(self.connection.execute("SELECT value FROM metadata WHERE key='source'").fetchone()[0]) == manifest['source'], 'invalid-source-manifest')
        except (OSError, ValueError, sqlite3.Error, TypeError, KeyError, CatalogError) as error:
            self.close()
            if isinstance(error, CatalogError):
                raise
            raise CatalogError('missing-or-corrupt-catalogue') from error

    def close(self):
        if self.connection:
            self.connection.close()
            self.connection = None

    def record(self, row):
        result = {'code': row['code'], 'name': row['name'], 'nameFr': row['name_fr'], 'brand': row['brand'], 'countries': json.loads(row['countries']), 'reference': {'amount': 100, 'unit': row['reference_unit']} if row['reference_unit'] else None,
                  'nutrients': {k: row[k] for k in ('kcal', 'protein', 'carbs', 'fat')}, 'portions': json.loads(row['portions']), 'warnings': json.loads(row['warnings']), 'modifiedAt': row['modified_at']}
        validate_record(result)
        if 'name_fold' in row.keys():
            require(row['name_fold'] == search_text(result['name']) and row['name_fr_fold'] == search_text(result['nameFr']) and row['brand_fold'] == search_text(result['brand']), 'corrupt-search-fields')
        require(hashlib.sha256(canonical(result).encode()).hexdigest() == row['record_hash'], 'corrupt-record')
        return result

    def search(self, query, page=1, page_size=20, language='fr'):
        require(type(language) is str and re.fullmatch('[a-z]{2}', language), 'invalid-language')
        require(text(query, 120, False) and len(query.strip()) >= 2, 'invalid-query')
        require(type(page) is int and 1 <= page <= 20 and type(page_size) is int and 1 <= page_size <= 20, 'invalid-pagination')
        folded = search_text(query)
        tokens = re.findall(r'[^\W_]+', folded, re.UNICODE)
        # French compounds include "à" and "d'". Keep them as quoted AND tokens,
        # while refusing queries made only of single letters and broad wildcards.
        require(1 <= len(tokens) <= 8 and all(1 <= len(t) <= 40 for t in tokens) and any(len(t) >= 2 for t in tokens), 'invalid-query-tokens')
        # Quoted literal AND tokens; only a final >=3-letter prefix is generated.
        # User-supplied operators, quotes and wildcards never enter FTS grammar.
        match = ' AND '.join('"' + token + '"' + ('*' if i == len(tokens)-1 and len(token) >= 3 else '') for i, token in enumerate(tokens))
        phrase = search_text(query)
        def relevance(name, french, brand):
            names = [search_text(name), search_text(french)]
            if phrase in names:
                return 3
            if any(n.startswith(phrase + ' ') or (n.startswith(phrase) and len(tokens[-1]) >= 3) for n in names):
                return 2
            return 1 if search_text(brand) == phrase else 0
        self.connection.create_function('query_relevance', 3, relevance)
        deadline = time.monotonic() + 0.15
        self.connection.set_progress_handler(lambda: int(time.monotonic() >= deadline), 1000)
        try:
            match_mode = 'literal'
            cost_sql = ''
            count = self.connection.execute('SELECT count(*) FROM products_fts WHERE products_fts MATCH ?', (match,)).fetchone()[0]
            if not count and self.manifest['version'] == 3:
                def check_deadline():
                    require(time.monotonic() < deadline, 'query-budget-exceeded')
                fallback = fallback_match(self.connection, tokens, check_deadline)
                if fallback:
                    match, scores = fallback
                    def spelling_cost(name, french, brand):
                        words = set((name + ' ' + french + ' ' + brand).split())
                        return min((cost for cost, phrase_words in scores if phrase_words <= words), default=100)
                    self.connection.create_function('spelling_cost', 3, spelling_cost)
                    cost_sql = 'spelling_cost(p.name_fold,p.name_fr_fold,p.brand_fold), '
                    match_mode = 'fuzzy'
                    count = self.connection.execute('SELECT count(*) FROM products_fts WHERE products_fts MATCH ?', (match,)).fetchone()[0]
            base_sql = 'SELECT p.*,bm25(products_fts,4.0,6.0,2.0) AS score FROM products_fts JOIN products p ON p.id=products_fts.rowid WHERE products_fts MATCH ? ORDER BY '
            if self.manifest['version'] >= 2:
                prefix = phrase if len(tokens[-1]) >= 3 else phrase + ' '
                rank_sql = 'CASE WHEN ? IN (p.name_fold,p.name_fr_fold) THEN 3 WHEN substr(p.name_fold,1,?)=? OR substr(p.name_fr_fold,1,?)=? THEN 2 WHEN p.brand_fold=? THEN 1 ELSE 0 END'
                params = (match, phrase, len(prefix), prefix, len(prefix), prefix, phrase)
            else:
                rank_sql, params = 'query_relevance(p.name,p.name_fr,p.brand)', (match,)
            rows = self.connection.execute(base_sql + cost_sql + rank_sql + ' DESC, ((p.kcal IS NOT NULL)+(p.protein IS NOT NULL)+(p.carbs IS NOT NULL)+(p.fat IS NOT NULL)) DESC, (? AND p.name_fr<>\'\') DESC,score,p.code LIMIT ? OFFSET ?', (*params, int(language == 'fr'), page_size + 1, (page-1)*page_size)).fetchall()
            # Exact total prepares the existing API's count-based pagination.
            # This extra query shares the same deadline; no fabricated count.
            records = [self.record(r) for r in rows[:page_size]]
            require(len(canonical(records).encode()) <= 128 * 1024, 'response-too-large')
            fixture = self.manifest['source']['kind'] == 'fixture'
            return {'products': records, 'matchMode': match_mode, 'count': count, 'page': page, 'pageSize': page_size, 'hasMore': len(rows) > page_size and page < 20, 'limited': count > page_size * 20, 'catalogueVersion': self.manifest['sha256'], 'source': 'Synthetic fixtures (not OFF data)' if fixture else 'Open Food Facts contributors', 'license': None if fixture else 'ODbL-1.0', 'fixture': fixture}
        except sqlite3.OperationalError as error:
            raise CatalogError('query-budget-exceeded' if str(error) == 'interrupted' else 'catalogue-query-failed') from error
        finally:
            self.connection.set_progress_handler(None, 0)

    def barcode(self, code):
        require(isinstance(code, str) and re.fullmatch(r'(?:\d{8}|\d{12,14})', code, re.ASCII), 'invalid-barcode')
        digits = code.lstrip('0')
        code = digits.zfill(8 if len(digits) <= 8 else 13 if len(digits) <= 13 else 14)
        row = self.connection.execute('SELECT * FROM products WHERE code=?', (code,)).fetchone()
        return self.record(row) if row else None

def rollback(root):
    """Explicit swap to the validated previous generation. Both versions remain;
    the manifest is the only publication point, and rollback can itself be undone.
    """
    with writer_lock(root), contextlib.closing(Catalog(root)) as current:
        previous = current.manifest.get('previous')
        require(previous is not None, 'no-previous-generation')
        with contextlib.closing(Catalog(root, previous)) as candidate:
            # Force an indexed read; a file hash alone is not a schema validator.
            candidate.search('nutella', page_size=1)
            manifest = {**previous, 'previous': previous_manifest(current.manifest)}
        write_manifest(root, manifest)
        return {'status': 'rolled-back', 'file': manifest['file'], 'sha256': manifest['sha256']}

def recover_previous(root):
    """Explicit recovery when the current file is corrupt but its manifest still
    holds a fully verifiable previous anchor. Never guess from directory entries.
    No file is deleted; a malformed manifest requires an out-of-band saved receipt.
    """
    with writer_lock(root):
        try:
            with contextlib.closing(Catalog(root)):
                pass
        except CatalogError:
            pass
        else:
            raise CatalogError('recovery-not-required-use-rollback')
        path = root / 'current.json'
        require(not path.is_symlink(), 'unsafe-manifest')
        with path.open('rb') as file:
            raw = file.read(4097)
        require(len(raw) <= 4096, 'oversized-manifest')
        value = parse_json(raw)
        require(type(value) is dict and value.keys() == {'format', 'version', 'file', 'sha256', 'bytes', 'products', 'source', 'previous'}, 'invalid-manifest')
        require(value['format'] == FORMAT and type(value['version']) is int and value['version'] in (1, 2, 3), 'unsupported-format')
        require(type(value['previous']) is dict and value['previous'].keys() == {'format', 'version', 'file', 'sha256', 'bytes', 'products', 'source'}, 'no-valid-previous-anchor')
        with contextlib.closing(Catalog(root, value['previous'])) as previous:
            # File hash, schema, counts and record hashes/derived fields must all
            # be valid before this exceptional recovery becomes authoritative.
            for row in previous.connection.execute('SELECT * FROM products'):
                previous.record(row)
            manifest = {**previous.manifest, 'previous': None}
        write_manifest(root, manifest)
        return {'status': 'recovered-previous', 'file': manifest['file'], 'sha256': manifest['sha256'], 'discardedAnchorOnly': True}

def cleanup_generations(root, names):
    """No automatic retention age. Operator supplies exact prototype filenames;
    current and rollback anchor are protected under the publication lock.
    Linux readers retain open file handles, even for an unlinked old generation.
    """
    require(type(names) is list and 1 <= len(names) <= 100 and all(type(n) is str for n in names) and len(set(names)) == len(names), 'invalid-cleanup-list')
    with writer_lock(root), contextlib.closing(Catalog(root)) as current:
        previous = current.manifest.get('previous')
        protected = {current.manifest['file']}
        if previous is not None:
            with contextlib.closing(Catalog(root, previous)):
                protected.add(previous['file'])
        paths = []
        for name in names:
            require(name not in protected, 'protected-generation')
            paths.append(safe_file(root, name))
        for path in paths:
            path.unlink()
        fsync_directory(root)
        return {'status': 'cleaned', 'files': names}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--workspace', default='trial')
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('build')
    search = sub.add_parser('search')
    search.add_argument('query')
    search.add_argument('--page', type=int, default=1)
    search.add_argument('--page-size', type=int, default=20)
    lookup = sub.add_parser('barcode')
    lookup.add_argument('code')
    sub.add_parser('inspect')
    sub.add_parser('rollback')
    sub.add_parser('recover-previous')
    cleanup = sub.add_parser('cleanup')
    cleanup.add_argument('--delete', action='append', required=True)
    args = parser.parse_args()
    try:
        root = workspace(args.workspace, create=args.command == 'build')
        if args.command == 'build':
            value = build(root, sys.stdin.buffer)
        elif args.command == 'rollback':
            value = rollback(root)
        elif args.command == 'recover-previous':
            value = recover_previous(root)
        elif args.command == 'cleanup':
            value = cleanup_generations(root, args.delete)
        else:
            with contextlib.closing(Catalog(root)) as catalogue:
                value = catalogue.search(args.query, args.page, args.page_size) if args.command == 'search' else catalogue.barcode(args.code) if args.command == 'barcode' else catalogue.manifest
        print(canonical(value))
    except (CatalogError, sqlite3.Error, OSError, MemoryError) as error:
        print(canonical({'error': str(error) if isinstance(error, CatalogError) else 'storage-or-resource-error'}), file=sys.stderr)
        return 1
    return 0

if __name__ == '__main__':
    sys.exit(main())
