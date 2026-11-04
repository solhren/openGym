#!/usr/bin/env python3
"""Acquire the pinned, bilingual ANSES Ciqual 2025 catalogue. No runtime HTTP.

Only Python's standard library is required. Source files are fetched directly
from the public publisher; no catalogue, credential or personal data ships here.
The CLI has no arbitrary URL, source-pin override or resource-budget bypass.
"""
import argparse
import copy
import fcntl
import hashlib
import io
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import resource
import shutil
import sqlite3
import sys
import time
import unicodedata
import urllib.error
import urllib.request
from urllib.parse import urlsplit
import xml.etree.ElementTree as ET
import zipfile

WORKSPACE = 'ciqual-2025'
FORMAT = 'opengym-public-food-catalog'
GIB = 1024 ** 3
MAX_WORKSPACE = 64 * 1024 ** 2
MAX_DB = 32 * 1024 ** 2
MAX_XML = 16 * 1024 ** 2
MAX_FOODS = 4000
LANDING = 'https://doi.org/10.57745/RDMHWY'
LICENSE = {'id': 'Etalab-2.0', 'url': 'https://spdx.org/licenses/etalab-2.0.html',
           'attribution': 'Anses. 2025. Table de composition nutritionnelle des aliments Ciqual 2025. Données du 2025-11-03. https://doi.org/10.57745/RDMHWY'}
SOURCES = (
    {'name': 'source.xlsx', 'url': 'https://entrepot.recherche.data.gouv.fr/api/access/datafile/666260',
     'bytes': 1541998, 'md5': '0d9758ce23f3f13dd63a005bc1bb4f2c',
     'sha256': '5555c572fa3735991298d832d0427788fa69a11b4fd20a5d580d58942369fbb0',
     'version': '2025-11-03', 'landingUrl': LANDING},
    {'name': 'names.xml', 'url': 'https://entrepot.recherche.data.gouv.fr/api/access/datafile/666252',
     'bytes': 1581031, 'md5': '8e1171d63cee4b6010cfce25dd29243d',
     'sha256': 'e0b1de25b3039028205e9d54a96892e403e1b313c2efeb41180fabe132627478',
     'version': '2025-11-03', 'landingUrl': LANDING},
)
NS = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
HEADERS = {'G': 'alim_code', 'H': 'alim_nom_fr',
           'K': 'Energie, Règlement UE N° 1169 2011 (kcal 100 g)',
           'P': 'Protéines, N x 6.25 (g 100 g)', 'Q': 'Glucides (g 100 g)', 'R': 'Lipides (g 100 g)'}
NUTRIENT_COLUMNS = {'kcal': 'K', 'protein': 'P', 'carbs': 'Q', 'fat': 'R'}


def require(condition, code):
    if not condition:
        raise ValueError(code)


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def digest_file(path):
    with open(path, 'rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def fsync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic_write(path, content):
    partial = path.with_name(path.name + '.tmp')
    require(not partial.exists() and not partial.is_symlink(), 'incomplete-metadata-write-use-new-directory')
    fd = os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(partial, path)
    fsync_directory(path.parent)


def reserve(directory, additional=0):
    memory = next(int(line.split()[1]) * 1024 for line in Path('/proc/meminfo').read_text().splitlines()
                  if line.startswith('MemAvailable:'))
    require(shutil.disk_usage(directory).free >= 20 * GIB + additional, 'reserve-20gib-disk-required')
    require(memory >= 2 * GIB, 'reserve-2gib-memory-required')
    return {'freeDiskBytes': shutil.disk_usage(directory).free, 'availableMemoryBytes': memory}


def safe_directory(path, create=False):
    path = Path(path).absolute()
    require(path.resolve() == path and not path.is_symlink(), 'directory-symlinks-refused')
    if not path.exists() and create:
        require(path.parent.is_dir(), 'directory-parent-required')
        path.mkdir(mode=0o700)
        fsync_directory(path.parent)
    require(path.is_dir(), 'catalogue-directory-required')
    return path


def workspace_budget(directory, guard):
    guard(directory)
    size = 0
    for path in directory.iterdir():
        require(not path.is_symlink() and path.is_file(), 'unexpected-catalogue-workspace-entry')
        size += path.stat().st_size
    require(size <= MAX_WORKSPACE, 'catalogue-workspace-budget')


def fold_text(value):
    value = ''.join(c for c in unicodedata.normalize('NFD', value.lower()) if not unicodedata.combining(c))
    return ' '.join(re.findall(r'[^\W_]+', value.replace('œ', 'oe').replace('æ', 'ae'), re.UNICODE))


def clean_name(value):
    require(isinstance(value, str), 'invalid-source-name')
    value = ' '.join(value.split())
    require(0 < len(value) <= 300 and not any(ord(c) < 32 or ord(c) == 127 for c in value), 'invalid-source-name')
    return value


def food_id(food):
    value = {key: item for key, item in food.items() if key != 'id'}
    return 'ciqual-' + food['source']['externalId'].split(':')[1] + '-' + hashlib.sha256(canonical(value).encode()).hexdigest()


def validate_record(record, source_sha256, names_sha256=None):
    required = {'id', 'code', 'name', 'brand', 'language', 'food', 'reference', 'validationStatus', 'issues', 'warnings', 'source'}
    require(type(record) is dict and set(record) == required, 'invalid-public-record')
    require(re.fullmatch(r'ciqual:[0-9]{1,8}', record['id']) is not None and record['code'] is None and
            record['brand'] == '' and record['language'] in ('fr', 'en'), 'invalid-ciqual-identity')
    source = record['source']
    require(type(source) is dict and set(source) == {'provider', 'foodCode', 'version', 'sourceName', 'sourceUrl',
            'sourceSha256', 'namesSourceSha256', 'names', 'license'}, 'invalid-ciqual-provenance')
    require(source['provider'] == 'ciqual' and source['foodCode'] == record['id'][7:] and source['version'] == '2025' and
            source['sourceName'] == 'Anses — Ciqual 2025' and source['sourceUrl'] == LANDING and
            source['sourceSha256'] == source_sha256 and re.fullmatch('[a-f0-9]{64}', source_sha256) is not None and
            re.fullmatch('[a-f0-9]{64}', source['namesSourceSha256']) is not None and source['license'] == LICENSE,
            'invalid-ciqual-provenance')
    if names_sha256 is not None:
        require(source['namesSourceSha256'] == names_sha256, 'names-source-mismatch')
    names = source['names']
    require(type(names) is dict and set(names) == {'fr', 'en'} and clean_name(names['fr']) == names['fr'] and
            (names['en'] is None or clean_name(names['en']) == names['en']) and
            record['name'] == names[record['language']], 'invalid-official-label')
    require(all(type(record[key]) is list and len(record[key]) <= 8 and
                all(type(v) is str and re.fullmatch('[a-z0-9-]{1,100}', v) for v in record[key])
                for key in ('issues', 'warnings')), 'invalid-quality-status')
    food = record['food']
    if food is None:
        require(record['reference'] is None and record['validationStatus'] == 'needs-verification', 'invalid-rejected-food')
        return
    require(type(food) is dict and set(food) == {'schemaVersion', 'kind', 'id', 'name', 'brand', 'reference', 'nutrients', 'portions', 'source'} and
            food['schemaVersion'] == 1 and food['kind'] == 'food' and food['name'] == record['name'] and
            food['brand'] == '' and food['portions'] == [] and food['reference'] == record['reference'] == {'amount': 100, 'unit': 'g'},
            'invalid-ciqual-food')
    require(food['source'] == {'kind': 'custom', 'externalId': record['id'], 'url': LANDING, 'license': LICENSE,
                              'publicCatalogImport': source}, 'invalid-food-provenance')
    nutrients = food['nutrients']
    require(type(nutrients) is dict and set(nutrients) == set(NUTRIENT_COLUMNS), 'invalid-ciqual-nutrients')
    require(all(v is None or type(v) in (int, float) and math.isfinite(v) and 0 <= v <= (2000 if key == 'kcal' else 100)
                for key, v in nutrients.items()) and any(v is not None for v in nutrients.values()), 'invalid-ciqual-nutrients')
    complete = all(v is not None for v in nutrients.values())
    require(record['validationStatus'] == ('validated' if complete else 'partial') and food['id'] == food_id(food), 'invalid-food-revision')


def localize_record(record, lc):
    result = copy.deepcopy(record)
    language = 'en' if lc != 'fr' and result['source']['names']['en'] else 'fr'
    result['language'] = language
    result['name'] = result['source']['names'][language]
    if result['food'] is not None:
        result['food']['name'] = result['name']
        result['food']['id'] = food_id(result['food'])
    return result


def source_ok(path, spec):
    require(path.is_file() and not path.is_symlink() and path.stat().st_size == spec['bytes'], 'source-size-mismatch')
    with path.open('rb') as stream:
        md5 = hashlib.file_digest(stream, 'md5').hexdigest()
    require(md5 == spec['md5'] and digest_file(path) == spec['sha256'], 'publisher-source-checksum-mismatch')


def allowed_url(value):
    url = urlsplit(value)
    require(url.scheme == 'https' and not url.username and not url.password and url.port in (None, 443), 'unsafe-source-url')
    require((url.hostname == 'entrepot.recherche.data.gouv.fr' and url.path in ('/api/access/datafile/666260', '/api/access/datafile/666252')) or
            (url.hostname == 'prod-espace-generique.opens3r-tls.stockage.inrae.fr' and url.path.startswith('/10.57745/RDMHWY/')), 'unsafe-source-url')


class PublisherRedirect(urllib.request.HTTPRedirectHandler):
    def __init__(self):
        self.redirects = 0

    def redirect_request(self, request, response, code, message, headers, newurl):
        allowed_url(newurl)
        self.redirects += 1
        require(self.redirects <= 3, 'source-redirect-limit')
        return super().redirect_request(request, response, code, message, headers, newurl)


def download(spec, directory, restart=False, opener=None, guard=reserve):
    require(spec['name'] in ('source.xlsx', 'names.xml') and 0 < spec['bytes'] <= 2 * 1024**2, 'source-budget')
    allowed_url(spec['url'])
    target = directory / spec['name']
    if target.exists() or target.is_symlink():
        source_ok(target, spec)
        return target
    partial = target.with_name(target.name + '.partial')
    require(not partial.is_symlink(), 'source-symlinks-refused')
    if restart and partial.exists():
        require(partial.is_file(), 'unsafe-partial-source')
        partial.unlink()  # Only this bootstrap's explicitly restarted unpublished download.
    offset = partial.stat().st_size if partial.exists() else 0
    require(offset <= spec['bytes'], 'partial-source-oversized-use-restart')
    if offset != spec['bytes']:
        guard(directory, spec['bytes'] - offset)
        headers = {'User-Agent': 'openGym-public-catalog-bootstrap/1 (Ciqual direct acquisition)', 'Accept-Encoding': 'identity'}
        if offset:
            headers.update({'Range': f'bytes={offset}-', 'If-Range': '"' + spec['md5'] + '"'})
        request = urllib.request.Request(spec['url'], headers=headers)
        open_request = opener or urllib.request.build_opener(urllib.request.ProxyHandler({}), PublisherRedirect()).open
        start = time.monotonic()
        with open_request(request, timeout=20) as response:
            require(response.headers.get('Content-Encoding', 'identity') == 'identity', 'unexpected-source-encoding')
            if offset:
                match = re.fullmatch(r'bytes (\d+)-(\d+)/(\d+)', response.headers.get('Content-Range', ''))
                require(response.status == 206 and match is not None and int(match[1]) == offset and
                        offset <= int(match[2]) < spec['bytes'] and int(match[3]) == spec['bytes'], 'resume-unsupported-use-restart')
            else:
                require(response.status == 200, 'unexpected-source-status')
            length = response.headers.get('Content-Length')
            require(length is None or length.isdigit() and int(length) <= spec['bytes'] - offset, 'source-response-too-large')
            flags = os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | (os.O_APPEND if offset else os.O_EXCL)
            with os.fdopen(os.open(partial, flags, 0o600), 'wb') as stream:
                while True:
                    require(time.monotonic() - start <= 120, 'source-download-deadline')
                    block = response.read(min(16384, spec['bytes'] - offset + 1))
                    if not block:
                        break
                    require(offset + len(block) <= spec['bytes'], 'source-response-too-large')
                    stream.write(block)
                    offset += len(block)
                    guard(directory)
                stream.flush()
                os.fsync(stream.fileno())
    source_ok(partial, spec)
    os.link(partial, target)
    partial.unlink()
    fsync_directory(directory)
    return target


def xml_bytes(raw):
    require(len(raw) <= MAX_XML, 'xml-size-limit')
    text = raw.decode('utf-8-sig')
    require('<!DOCTYPE' not in text and '<!ENTITY' not in text, 'xml-declarations-refused')
    return io.BytesIO(raw)


def names_from_xml(path):
    require(path.stat().st_size <= 2 * 1024**2, 'names-size-limit')
    result = {}
    for event, node in ET.iterparse(xml_bytes(path.read_bytes()), events=['end']):
        if node.tag != 'ALIM':
            continue
        code = node.findtext('alim_code', '').strip()
        require(re.fullmatch('[0-9]{1,8}', code) is not None and code not in result, 'duplicate-or-invalid-ciqual-code')
        french = clean_name(node.findtext('alim_nom_fr', ''))
        english = node.findtext('alim_nom_eng', '').strip()
        result[code] = {'fr': french, 'en': clean_name(english) if english else None}
        require(len(result) <= MAX_FOODS, 'source-row-limit')
        node.clear()
    require(result, 'empty-names-source')
    return result


def spreadsheet_rows(path):
    with zipfile.ZipFile(path) as archive:
        infos = archive.infolist()
        require(len(infos) <= 64 and len({i.filename for i in infos}) == len(infos) and
                sum(i.file_size for i in infos) <= MAX_XML, 'xlsx-archive-budget')
        for item in infos:
            name = PurePosixPath(item.filename)
            require(not name.is_absolute() and '..' not in name.parts and '\\' not in item.filename and
                    not item.flag_bits & 1 and item.compress_type in (zipfile.ZIP_DEFLATED, zipfile.ZIP_STORED) and
                    item.file_size <= MAX_XML, 'unsafe-xlsx-entry')
        shared_raw = archive.read('xl/sharedStrings.xml')
        require(len(shared_raw) <= 1024**2, 'shared-string-budget')
        shared = [''.join(item.itertext()) for item in ET.parse(xml_bytes(shared_raw)).getroot().findall(NS + 'si')]
        require(len(shared) <= 20000 and all(len(value) <= 1000 for value in shared), 'shared-string-budget')
        rows = 0
        for event, node in ET.iterparse(xml_bytes(archive.read('xl/worksheets/sheet1.xml')), events=['end']):
            if node.tag != NS + 'row':
                continue
            values = {}
            for cell in node.findall(NS + 'c'):
                match = re.fullmatch(r'([A-Z]{1,3})([1-9][0-9]{0,4})', cell.get('r', ''))
                require(match is not None, 'invalid-cell-address')
                column = match[1]
                if column not in HEADERS:
                    continue
                require(column not in values and cell.find(NS + 'f') is None, 'duplicate-or-formula-cell')
                raw = cell.findtext(NS + 'v', '')
                kind = cell.get('t', 'n')
                if kind == 's':
                    require(raw.isdigit() and int(raw) < len(shared), 'invalid-shared-string')
                    raw = shared[int(raw)]
                elif kind == 'inlineStr':
                    raw = ''.join(cell.find(NS + 'is').itertext())
                else:
                    require(kind == 'n', 'unsupported-source-cell-type')
                values[column] = raw.strip()
            if not values or not any(values.values()):
                node.clear()
                continue
            rows += 1
            require(rows <= MAX_FOODS + 1, 'source-row-limit')
            yield values
            node.clear()


def normalize_row(row, names, source_sha, names_sha):
    code = row.get('G', '')
    require(re.fullmatch('[0-9]{1,8}', code) is not None and code in names, 'unmatched-source-code')
    require(clean_name(row.get('H', '')) == names[code]['fr'], 'source-name-conflict')
    provenance = {'provider': 'ciqual', 'foodCode': code, 'version': '2025', 'sourceName': 'Anses — Ciqual 2025',
                  'sourceUrl': LANDING, 'sourceSha256': source_sha, 'namesSourceSha256': names_sha,
                  'names': names[code], 'license': LICENSE}
    values, issues, warnings = {}, [], []
    for key, column in NUTRIENT_COLUMNS.items():
        raw = row.get(column, '').strip()
        if raw in ('', '-') or raw.lower() == 'traces' or re.fullmatch(r'<\s*[0-9]+(?:[,.][0-9]+)?', raw):
            values[key] = None
            if raw not in ('', '-'):
                warnings.append('qualified-values')
        elif re.fullmatch(r'[0-9]+(?:[,.][0-9]+)?', raw):
            value = float(raw.replace(',', '.'))
            if not math.isfinite(value) or value > (2000 if key == 'kcal' else 100):
                values[key] = None
                issues.append('invalid-' + key)
            else:
                values[key] = value
        else:
            values[key] = None
            issues.append('invalid-' + key)
    complete = all(value is not None for value in values.values())
    if not complete:
        warnings.append('missing-values')
    food = None
    if not issues and any(value is not None for value in values.values()):
        food = {'schemaVersion': 1, 'kind': 'food', 'name': names[code]['fr'], 'brand': '',
                'reference': {'amount': 100, 'unit': 'g'}, 'nutrients': values, 'portions': [],
                'source': {'kind': 'custom', 'externalId': 'ciqual:' + code, 'url': LANDING,
                           'license': LICENSE, 'publicCatalogImport': provenance}}
        food['id'] = food_id(food)
    record = {'id': 'ciqual:' + code, 'code': None, 'name': names[code]['fr'], 'brand': '', 'language': 'fr',
              'food': food, 'reference': food['reference'] if food else None,
              'validationStatus': 'validated' if food and complete else 'partial' if food else 'needs-verification',
              'issues': sorted(set(issues or (['no-nutrition-values'] if not food else []))),
              'warnings': sorted(set(warnings)), 'source': provenance}
    validate_record(record, source_sha, names_sha)
    return record


def build_generation(directory, source, names_source, specs=SOURCES, expected_rows=3484, guard=reserve, restart=False):
    source_ok(source, specs[0])
    source_ok(names_source, specs[1])
    workspace_budget(directory, guard)
    names = names_from_xml(names_source)
    rows = iter(spreadsheet_rows(source))
    header = next(rows)
    require({key: fold_text(value) for key, value in header.items()} ==
            {key: fold_text(value) for key, value in HEADERS.items()}, 'unexpected-ciqual-columns')
    staged = directory / '.catalog.sqlite.partial'
    if restart and staged.exists():
        require(staged.is_file() and not staged.is_symlink(), 'unsafe-staged-catalogue')
        staged.unlink()  # Explicitly discard only an unpublished build, never a generation.
    require(not staged.exists() and not staged.is_symlink(), 'incomplete-build-use-restart')
    connection = sqlite3.connect(staged)
    staged.chmod(0o600)
    counts = {'rows': 0, 'usableFoodCount': 0, 'completeFoodCount': 0, 'englishNameCount': 0, 'rejectedFoodCount': 0}
    seen = set()
    try:
        connection.executescript('''PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE; PRAGMA cache_size=-2048;
          PRAGMA temp_store=FILE; PRAGMA max_page_count=8192;
          CREATE TABLE foods(rowid INTEGER PRIMARY KEY,id TEXT NOT NULL UNIQUE,name TEXT NOT NULL,folded TEXT NOT NULL,payload TEXT NOT NULL,complete INTEGER NOT NULL,addable INTEGER NOT NULL);
          CREATE VIRTUAL TABLE foods_fts USING fts5(folded,content='foods',content_rowid='rowid',tokenize='unicode61 remove_diacritics 2',prefix='3 4');''')
        for row in rows:
            record = normalize_row(row, names, specs[0]['sha256'], specs[1]['sha256'])
            require(record['id'] not in seen, 'duplicate-ciqual-code')
            seen.add(record['id'])
            complete, addable = record['validationStatus'] == 'validated', record['food'] is not None
            folded = fold_text(record['source']['names']['fr'] + ' ' + (record['source']['names']['en'] or ''))
            connection.execute('INSERT INTO foods(id,name,folded,payload,complete,addable) VALUES(?,?,?,?,?,?)',
                               (record['id'], record['name'], folded, canonical(record), int(complete), int(addable)))
            counts['rows'] += 1
            counts['usableFoodCount'] += addable
            counts['completeFoodCount'] += complete
            counts['rejectedFoodCount'] += not addable
            counts['englishNameCount'] += bool(record['source']['names']['en'])
            if counts['rows'] % 100 == 0:
                connection.commit()
                workspace_budget(directory, guard)
        require(counts['rows'] == expected_rows and len(names) == expected_rows and
                seen == {'ciqual:' + code for code in names}, 'incomplete-source-code-join')
        require(counts['usableFoodCount'] > 0 and counts['completeFoodCount'] > 0, 'no-usable-foods')
        connection.execute("INSERT INTO foods_fts(foods_fts) VALUES('rebuild')")
        connection.execute("INSERT INTO foods_fts(foods_fts,rank) VALUES('integrity-check',1)")
        connection.commit()
        require(connection.execute('PRAGMA integrity_check').fetchone()[0] == 'ok', 'catalogue-integrity-failed')
    finally:
        connection.close()
    require(staged.stat().st_size <= MAX_DB, 'catalogue-db-budget')
    with staged.open('rb') as stream:
        os.fsync(stream.fileno())
    digest = digest_file(staged)
    filename = 'catalog-' + digest + '.sqlite'
    final = directory / filename
    if final.exists():
        require(not final.is_symlink() and digest_file(final) == digest, 'generation-path-conflict')
    else:
        os.link(staged, final)
    staged.unlink()
    fsync_directory(directory)
    source_meta = {key: value for key, value in specs[0].items() if key != 'name'}
    names_meta = {key: value for key, value in specs[1].items() if key != 'name'}
    manifest = {'format': FORMAT, 'schemaVersion': 1, 'provider': 'ciqual', 'sourceVersion': '2025',
                'file': filename, 'sha256': digest, 'bytes': final.stat().st_size, **counts,
                'literalOnly': True, 'reference': {'amount': 100, 'unit': 'g'}, 'languages': ['fr', 'en'],
                'license': LICENSE, 'source': source_meta, 'namesSource': names_meta}
    notice = (LICENSE['attribution'] + '\nLicence Ouverte / Open Licence 2.0: ' + LICENSE['url'] + '\n'
              'Source data acquired directly from ANSES / Recherche Data Gouv; openGym is not endorsed by ANSES.\n'
              'Generic foods consumed in France; official French and English labels. No brands or barcodes.\n'
              'Other UI languages use official English labels when available, otherwise French. No automatic translation.\n'
              'All declared values are per 100 g edible food, including drinks. No density or ml conversion.\n'
              'Protein: N x 6.25; energy: EU Regulation 1169/2011 kcal. Qualified or missing values remain unknown.\n').encode()
    receipt = {'format': 'opengym-public-catalogue-acquisition', 'schemaVersion': 1, 'complete': True,
               'source': source_meta, 'namesSource': names_meta, 'catalogueSha256': digest, **counts,
               'automaticRetries': 0, 'externalRuntimeFoodCalls': 0, 'sourceCodeJoinComplete': True,
               'license': LICENSE, 'mapping': {'energy': HEADERS['K'], 'protein': HEADERS['P'],
                                             'carbs': HEADERS['Q'], 'fat': HEADERS['R'], 'reference': '100 g edible portion'}}
    atomic_write(directory / 'NOTICE.txt', notice)
    atomic_write(directory / 'receipt.json', (canonical(receipt) + '\n').encode())
    manifest['noticeSha256'] = digest_file(directory / 'NOTICE.txt')
    manifest['receiptSha256'] = digest_file(directory / 'receipt.json')
    workspace_budget(directory, guard)
    atomic_write(directory / 'current.json', (canonical(manifest) + '\n').encode())
    return inspect_generation(directory, expected_specs=specs)


def inspect_generation(directory, expected_specs=SOURCES):
    """Verify an operator-sealed generation against the supported source pins.

    expected_specs is dependency injection for tiny in-process test fixtures.
    The CLI and runtime default always use the committed publisher/source pins.
    A derived database hash is integrity metadata, not a publisher signature.
    """
    directory = safe_directory(directory)
    current = directory / 'current.json'
    require(current.is_file() and not current.is_symlink() and current.stat().st_size <= 16384, 'missing-or-unsafe-catalogue-manifest')
    manifest = json.loads(current.read_text())
    require(type(manifest) is dict and manifest.get('format') == FORMAT and manifest.get('schemaVersion') == 1 and
            manifest.get('provider') == 'ciqual' and manifest.get('sourceVersion') == '2025' and
            manifest.get('literalOnly') is True and manifest.get('reference') == {'amount': 100, 'unit': 'g'} and
            manifest.get('languages') == ['fr', 'en'] and manifest.get('license') == LICENSE, 'invalid-public-catalogue-manifest')
    sha = manifest.get('sha256', '')
    require(re.fullmatch('[a-f0-9]{64}', sha) is not None and manifest.get('file') == 'catalog-' + sha + '.sqlite', 'unsafe-catalogue-generation')
    for key in ('rows', 'usableFoodCount', 'completeFoodCount', 'englishNameCount', 'rejectedFoodCount'):
        require(type(manifest.get(key)) is int and 0 <= manifest[key] <= MAX_FOODS, 'invalid-catalogue-count')
    require(0 < manifest['completeFoodCount'] <= manifest['usableFoodCount'] <= manifest['rows'] and
            manifest['usableFoodCount'] + manifest['rejectedFoodCount'] == manifest['rows'] and
            manifest['englishNameCount'] <= manifest['rows'], 'invalid-catalogue-count')
    for key in ('source', 'namesSource'):
        value = manifest.get(key)
        require(type(value) is dict and set(value) == {'url', 'landingUrl', 'bytes', 'md5', 'sha256', 'version'} and
                type(value['bytes']) is int and 0 < value['bytes'] <= 2 * 1024**2 and value['landingUrl'] == LANDING and
                value['version'] == '2025-11-03' and re.fullmatch('[a-f0-9]{32}', value['md5']) is not None and
                re.fullmatch('[a-f0-9]{64}', value['sha256']) is not None, 'invalid-source-receipt')
        allowed_url(value['url'])
    require(len(expected_specs) == 2 and
            manifest['source'] == {key: value for key, value in expected_specs[0].items() if key != 'name'} and
            manifest['namesSource'] == {key: value for key, value in expected_specs[1].items() if key != 'name'},
            'unsupported-source-pins')
    file = directory / manifest['file']
    require(file.is_file() and not file.is_symlink() and type(manifest.get('bytes')) is int and
            file.stat().st_size == manifest['bytes'] <= MAX_DB and digest_file(file) == sha, 'catalogue-digest-mismatch')
    for name, key, limit in [('NOTICE.txt', 'noticeSha256', 16384), ('receipt.json', 'receiptSha256', 16384)]:
        path = directory / name
        require(path.is_file() and not path.is_symlink() and path.stat().st_size <= limit and
                digest_file(path) == manifest.get(key), 'catalogue-receipt-mismatch')
    connection = sqlite3.connect(file.resolve().as_uri() + '?mode=ro&immutable=1', uri=True)
    try:
        connection.execute('PRAGMA query_only=ON')
        connection.execute('PRAGMA cache_size=-2048')
        require(connection.execute('PRAGMA integrity_check').fetchone()[0] == 'ok', 'catalogue-integrity-failed')
        counts = {'rows': 0, 'usableFoodCount': 0, 'completeFoodCount': 0, 'englishNameCount': 0, 'rejectedFoodCount': 0}
        for uid, name, folded, payload, complete, addable in connection.execute('SELECT id,name,folded,payload,complete,addable FROM foods'):
            require(len(payload.encode()) <= 16384, 'catalogue-record-budget')
            record = json.loads(payload)
            validate_record(record, manifest['source']['sha256'], manifest['namesSource']['sha256'])
            require(uid == record['id'] and name == record['name'] and record['language'] == 'fr' and
                    folded == fold_text(record['source']['names']['fr'] + ' ' + (record['source']['names']['en'] or '')) and
                    complete == int(record['validationStatus'] == 'validated') and addable == int(record['food'] is not None), 'catalogue-row-mismatch')
            counts['rows'] += 1
            counts['usableFoodCount'] += addable
            counts['completeFoodCount'] += complete
            counts['englishNameCount'] += bool(record['source']['names']['en'])
            counts['rejectedFoodCount'] += not addable
            require(counts['rows'] <= MAX_FOODS, 'source-row-limit')
        require(all(manifest[key] == value for key, value in counts.items()), 'catalogue-count-mismatch')
        require(connection.execute('SELECT count(*) FROM foods_fts_docsize').fetchone()[0] == counts['rows'], 'catalogue-fts-count-mismatch')
    finally:
        connection.close()
    return manifest


def summary(manifest):
    return {'kind': 'ciqual-local', 'workspace': WORKSPACE, 'catalogueSha256': manifest['sha256'],
            **{key: manifest[key] for key in ('rows', 'usableFoodCount', 'completeFoodCount', 'englishNameCount', 'rejectedFoodCount', 'languages', 'license')},
            'sourceBytes': manifest['source']['bytes'] + manifest['namesSource']['bytes'], 'catalogueBytes': manifest['bytes']}


def acquire(root, restart=False, opener=None, guard=reserve, specs=SOURCES, expected_rows=3484):
    root = safe_directory(root, create=True)
    guard(root, MAX_WORKSPACE)
    lock = os.open(root / '.ciqual-bootstrap.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        directory = safe_directory(root / WORKSPACE, create=True)
        if (directory / 'current.json').exists() or (directory / 'current.json').is_symlink():
            return summary(inspect_generation(directory, expected_specs=specs))
        if restart:
            for name in ('NOTICE.txt.tmp', 'receipt.json.tmp', 'current.json.tmp'):
                partial = directory / name
                require(not partial.is_symlink(), 'unsafe-partial-metadata')
                if partial.exists():
                    require(partial.is_file(), 'unsafe-partial-metadata')
                    partial.unlink()  # Only unpublished metadata in this workspace.
        source, names = [download(spec, directory, restart=restart, opener=opener, guard=guard) for spec in specs]
        return summary(build_generation(directory, source, names, specs=specs, expected_rows=expected_rows, guard=guard, restart=restart))
    finally:
        os.close(lock)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['acquire', 'inspect', 'inspect-generation', 'list'])
    parser.add_argument('directory', nargs='?', help='Catalogue root, e.g. INSTANCE/catalogues; creates/reads ciqual-2025 beneath it')
    parser.add_argument('--restart', action='store_true', help='Restart only unpublished partial downloads/builds; verified generations are preserved')
    args = parser.parse_args()
    resource.setrlimit(resource.RLIMIT_AS, (128 * 1024**2, 128 * 1024**2))
    try:
        require(not args.restart or args.action == 'acquire', 'restart-only-for-acquisition')
        if args.action == 'list':
            require(args.directory is None, 'list-takes-no-directory')
            print(canonical(json.loads(Path(__file__).with_name('public-catalog-sources.json').read_text())))
            return 0
        require(args.directory is not None, 'catalogue-directory-required')
        value = acquire(args.directory, restart=args.restart) if args.action == 'acquire' else summary(inspect_generation(
            Path(args.directory) if args.action == 'inspect-generation' else Path(args.directory) / WORKSPACE))
        print(canonical(value))
    except (OSError, ValueError, KeyError, StopIteration, ET.ParseError, zipfile.BadZipFile, sqlite3.Error, urllib.error.URLError) as error:
        # HTTP redirects may contain publisher-signed tokens; never print raw URLs/errors.
        code = str(error) if type(error) is ValueError and re.fullmatch('[a-z0-9-]+', str(error)) else type(error).__name__
        print(canonical({'error': code, 'complete': False, 'runtimeActivated': False}), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
