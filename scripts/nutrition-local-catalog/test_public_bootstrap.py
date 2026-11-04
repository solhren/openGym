"""Tiny synthetic source fixtures; no Internet or existing catalogue is used."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import urllib.error
import xml.etree.ElementTree as ET
import zipfile

spec = importlib.util.spec_from_file_location('public_bootstrap', Path(__file__).with_name('public-bootstrap.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def fixture_sources(records=None):
    records = records or [('0001', 'Riz cru', 'Rice, raw', ['350', '7', '75', '1']),
                          ('2', 'Lait nature', 'Milk, plain', ['41', '3,2', '4,8', '1'])]
    values = list(m.HEADERS.values())
    table = ET.Element(m.NS + 'worksheet')
    data = ET.SubElement(table, m.NS + 'sheetData')
    header = ET.SubElement(data, m.NS + 'row', r='1')
    for column, label in m.HEADERS.items():
        cell = ET.SubElement(header, m.NS + 'c', r=column + '1', t='s')
        ET.SubElement(cell, m.NS + 'v').text = str(values.index(label))
    labels = ET.Element('TABLE')
    for index, (code, french, english, nutrients) in enumerate(records, 2):
        row = ET.SubElement(data, m.NS + 'row', r=str(index))
        for column, value in {'G': code, 'H': french, **dict(zip(m.NUTRIENT_COLUMNS.values(), nutrients))}.items():
            values.append(value)
            cell = ET.SubElement(row, m.NS + 'c', r=column + str(index), t='s')
            ET.SubElement(cell, m.NS + 'v').text = str(len(values) - 1)
        item = ET.SubElement(labels, 'ALIM')
        for key, value in [('alim_code', code), ('alim_nom_fr', french), ('alim_nom_eng', english)]:
            ET.SubElement(item, key).text = value
    shared = ET.Element(m.NS + 'sst')
    for value in values:
        ET.SubElement(ET.SubElement(shared, m.NS + 'si'), m.NS + 't').text = value
    raw = io.BytesIO()
    with zipfile.ZipFile(raw, 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('xl/sharedStrings.xml', ET.tostring(shared, encoding='utf-8'))
        archive.writestr('xl/worksheets/sheet1.xml', ET.tostring(table, encoding='utf-8'))
    bodies = [raw.getvalue(), ET.tostring(labels, encoding='utf-8')]
    specs = [{**original, 'bytes': len(body), 'md5': hashlib.md5(body).hexdigest(), 'sha256': hashlib.sha256(body).hexdigest()}
             for original, body in zip(m.SOURCES, bodies)]
    return specs, bodies


class Response(io.BytesIO):
    def __init__(self, body, status=200, headers=None, fail_after=None):
        super().__init__(body)
        self.status = status
        self.headers = headers or {'Content-Length': str(len(body))}
        self.fail_after = fail_after

    def read(self, size=-1):
        if self.fail_after is not None:
            if self.tell() >= self.fail_after:
                raise urllib.error.URLError('synthetic interruption')
            size = min(size, self.fail_after - self.tell())
        return super().read(size)


def build_fixture(root, records=None):
    """Test-only fixture factory also usable by API/reader integration tests."""
    specs, bodies = fixture_sources(records)
    by_url = {item['url']: body for item, body in zip(specs, bodies)}
    return m.acquire(root, specs=specs, expected_rows=len(records) if records else 2,
                     opener=lambda request, **kwargs: Response(by_url[request.full_url]), guard=lambda *args: None)


class PublicBootstrapTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.output = self.root / 'catalogues'

    def records(self):
        manifest = json.loads((self.output / m.WORKSPACE / 'current.json').read_text())
        connection = sqlite3.connect(self.output / m.WORKSPACE / manifest['file'])
        try:
            return [json.loads(payload) for (payload,) in connection.execute('SELECT payload FROM foods ORDER BY rowid')]
        finally:
            connection.close()

    def test_complete_bilingual_import_retains_codes_grams_provenance_and_immutable_revision(self):
        report = build_fixture(self.output)
        self.assertEqual(report['rows'], 2)
        self.assertEqual(report['completeFoodCount'], 2)
        self.assertEqual(report['englishNameCount'], 2)
        records = self.records()
        self.assertEqual(records[0]['id'], 'ciqual:0001')
        self.assertIsNone(records[0]['code'])
        self.assertEqual(records[1]['food']['reference'], {'amount': 100, 'unit': 'g'})
        self.assertEqual(records[1]['food']['nutrients']['protein'], 3.2)
        self.assertEqual(records[0]['food']['source']['license'], m.LICENSE)
        english = m.localize_record(records[0], 'en')
        self.assertEqual(english['name'], 'Rice, raw')
        self.assertEqual(english['food']['name'], english['name'])
        self.assertEqual(english['id'], records[0]['id'])
        self.assertNotEqual(english['food']['id'], records[0]['food']['id'])
        m.validate_record(english, english['source']['sourceSha256'], english['source']['namesSourceSha256'])
        self.assertEqual(m.localize_record(records[0], 'de'), records[0])
        self.assertEqual(m.fold_text('Œufs PÂTES'), 'oeufs pates')

    def test_completed_acquisition_is_idempotent_and_offline(self):
        first = build_fixture(self.output)
        calls = []
        second = m.acquire(self.output, specs=fixture_sources()[0], opener=lambda *args, **kwargs: calls.append(args), guard=lambda *args: None)
        self.assertEqual(first, second)
        self.assertEqual(calls, [])

    def test_unknown_and_qualified_values_stay_null_and_invalid_values_block_food(self):
        names = {'1': {'fr': 'Aliment test', 'en': 'Test food'}}
        for raw in ['-', '', 'traces', '< 0,1']:
            with self.subTest(raw=raw):
                row = {'G': '1', 'H': 'Aliment test', 'K': '100', 'P': raw, 'Q': '5', 'R': '2'}
                record = m.normalize_row(row, names, 'a' * 64, 'b' * 64)
                self.assertEqual(record['validationStatus'], 'partial')
                self.assertIsNone(record['food']['nutrients']['protein'])
        for raw in ['-1', 'NaN', '101', '1e309', 'garbage']:
            with self.subTest(raw=raw):
                row = {'G': '1', 'H': 'Aliment test', 'K': '100', 'P': raw, 'Q': '5', 'R': '2'}
                self.assertIsNone(m.normalize_row(row, names, 'a' * 64, 'b' * 64)['food'])
        row = {'G': '1', 'H': 'Aliment test', 'K': '0', 'P': '0', 'Q': '0', 'R': '0'}
        self.assertEqual(m.normalize_row(row, names, 'a' * 64, 'b' * 64)['validationStatus'], 'validated')

    def test_missing_english_uses_french_without_inventing_translation(self):
        build_fixture(self.output, [('1', 'Riz', '', ['100', '2', '20', '1'])])
        record = self.records()[0]
        self.assertIsNone(record['source']['names']['en'])
        self.assertEqual(m.localize_record(record, 'en'), record)

    def test_source_checksum_failure_never_publishes(self):
        specs, bodies = fixture_sources()
        def opener(request, **kwargs):
            return Response(b'X' + bodies[0][1:])
        with self.assertRaisesRegex(ValueError, 'publisher-source-checksum'):
            m.acquire(self.output, specs=specs, expected_rows=2, opener=opener, guard=lambda *args: None)
        self.assertFalse((self.output / m.WORKSPACE / 'current.json').exists())

    def test_interrupted_metadata_publication_can_restart_offline_without_changing_generation(self):
        specs, bodies = fixture_sources()
        by_url = dict(zip([s['url'] for s in specs], bodies))
        write = m.atomic_write
        def interrupted(path, content):
            if path.name == 'current.json':
                path.with_name('current.json.tmp').write_bytes(b'incomplete metadata')
                raise ValueError('synthetic-interruption')
            return write(path, content)
        with patch.object(m, 'atomic_write', side_effect=interrupted):
            with self.assertRaisesRegex(ValueError, 'synthetic-interruption'):
                m.acquire(self.output, specs=specs, expected_rows=2,
                          opener=lambda request, **kwargs: Response(by_url[request.full_url]), guard=lambda *args: None)
        directory = self.output / m.WORKSPACE
        self.assertFalse((directory / 'current.json').exists())
        generations = {path.name: path.read_bytes() for path in directory.glob('catalog-*.sqlite')}
        calls = []
        result = m.acquire(self.output, restart=True, specs=specs, expected_rows=2,
                           opener=lambda *args, **kwargs: calls.append(args), guard=lambda *args: None)
        self.assertEqual(result['rows'], 2)
        self.assertEqual(calls, [])
        self.assertFalse((directory / 'current.json.tmp').exists())
        self.assertEqual({path.name: path.read_bytes() for path in directory.glob('catalog-*.sqlite')}, generations)

    def test_response_limit_and_redirect_limit_do_not_publish(self):
        specs, bodies = fixture_sources()
        directory = self.root / 'download'
        directory.mkdir()
        with self.assertRaisesRegex(ValueError, 'source-response-too-large'):
            m.download(specs[0], directory, opener=lambda *args, **kwargs: Response(bodies[0] + b'X', headers={}), guard=lambda *args: None)
        self.assertFalse((directory / 'source.xlsx').exists())
        handler = m.PublisherRedirect()
        request = m.urllib.request.Request(specs[0]['url'])
        for _ in range(3):
            handler.redirect_request(request, None, 302, 'Found', {}, specs[0]['url'])
        with self.assertRaisesRegex(ValueError, 'source-redirect-limit'):
            handler.redirect_request(request, None, 302, 'Found', {}, specs[0]['url'])

    def test_xlsx_formulas_and_traversal_members_are_not_interpreted(self):
        _, bodies = fixture_sources()
        for mode in ['formula', 'traversal']:
            output = self.root / (mode + '.xlsx')
            with zipfile.ZipFile(io.BytesIO(bodies[0])) as source, zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as target:
                for name in source.namelist():
                    raw = source.read(name)
                    if mode == 'formula' and name.endswith('sheet1.xml'):
                        root = ET.fromstring(raw)
                        cell = next(cell for cell in root.iter(m.NS + 'c') if cell.get('r') == 'P2')
                        ET.SubElement(cell, m.NS + 'f').text = '1+1'
                        raw = ET.tostring(root)
                    target.writestr(name, raw)
                if mode == 'traversal':
                    target.writestr('../../outside', b'not extracted')
            with self.subTest(mode=mode), self.assertRaises(ValueError):
                list(m.spreadsheet_rows(output))
        self.assertFalse((self.root.parent / 'outside').exists())

    def test_partial_download_can_resume_once_with_exact_range_and_pinned_digest(self):
        specs, bodies = fixture_sources()
        directory = self.root / 'download'
        directory.mkdir()
        with self.assertRaises(urllib.error.URLError):
            m.download(specs[0], directory, opener=lambda *args, **kwargs: Response(bodies[0], fail_after=17), guard=lambda *args: None)
        self.assertEqual((directory / 'source.xlsx.partial').stat().st_size, 17)
        def resumed(request, **kwargs):
            self.assertEqual(request.get_header('Range'), 'bytes=17-')
            self.assertEqual(request.get_header('If-range'), '"' + specs[0]['md5'] + '"')
            return Response(bodies[0][17:], 206, {'Content-Range': f'bytes 17-{len(bodies[0])-1}/{len(bodies[0])}'})
        result = m.download(specs[0], directory, opener=resumed, guard=lambda *args: None)
        self.assertEqual(result.read_bytes(), bodies[0])
        self.assertFalse((directory / 'source.xlsx.partial').exists())

    def test_ignored_resume_range_preserves_partial_until_explicit_restart(self):
        specs, bodies = fixture_sources()
        directory = self.root / 'download'
        directory.mkdir()
        partial = directory / 'source.xlsx.partial'
        partial.write_bytes(bodies[0][:10])
        with self.assertRaisesRegex(ValueError, 'resume-unsupported'):
            m.download(specs[0], directory, opener=lambda *args, **kwargs: Response(bodies[0]), guard=lambda *args: None)
        self.assertEqual(partial.read_bytes(), bodies[0][:10])
        result = m.download(specs[0], directory, restart=True, opener=lambda *args, **kwargs: Response(bodies[0]), guard=lambda *args: None)
        self.assertEqual(result.read_bytes(), bodies[0])

    def test_duplicate_or_incomplete_code_joins_never_publish(self):
        specs, bodies = fixture_sources()
        labels = ET.fromstring(bodies[1])
        labels.remove(labels[-1])
        bodies[1] = ET.tostring(labels)
        specs[1].update(bytes=len(bodies[1]), md5=hashlib.md5(bodies[1]).hexdigest(), sha256=hashlib.sha256(bodies[1]).hexdigest())
        by_url = dict(zip([s['url'] for s in specs], bodies))
        with self.assertRaisesRegex(ValueError, 'unmatched-source-code'):
            m.acquire(self.output, specs=specs, expected_rows=2, opener=lambda request, **kwargs: Response(by_url[request.full_url]), guard=lambda *args: None)
        self.assertFalse((self.output / m.WORKSPACE / 'current.json').exists())

    def test_corruption_and_manifest_path_escape_are_rejected(self):
        build_fixture(self.output)
        directory = self.output / m.WORKSPACE
        path = directory / 'current.json'
        manifest = json.loads(path.read_text())
        file = directory / manifest['file']
        with file.open('r+b') as stream:
            stream.seek(100)
            stream.write(b'corrupt')
        with self.assertRaisesRegex(ValueError, 'catalogue-digest-mismatch'):
            m.inspect_generation(directory, expected_specs=fixture_sources()[0])
        manifest['file'] = '../outside.sqlite'
        path.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, 'unsafe-catalogue-generation'):
            m.inspect_generation(directory, expected_specs=fixture_sources()[0])

    def test_public_inspection_default_rejects_self_declared_source_pins(self):
        build_fixture(self.output)
        directory = self.output / m.WORKSPACE
        with self.assertRaisesRegex(ValueError, 'unsupported-source-pins'):
            m.inspect_generation(directory)
        manifest = m.inspect_generation(directory, expected_specs=fixture_sources()[0])
        self.assertEqual(manifest['rows'], 2)

    def test_source_url_redirect_xml_declarations_and_workspace_symlinks_are_refused(self):
        for url in ['http://entrepot.recherche.data.gouv.fr/api/access/datafile/666260',
                    'https://user:password@entrepot.recherche.data.gouv.fr/api/access/datafile/666260',
                    'https://evil.example/source.xlsx', 'https://entrepot.recherche.data.gouv.fr/api/access/datafile/42']:
            with self.subTest(url=url), self.assertRaises(ValueError):
                m.allowed_url(url)
        with self.assertRaisesRegex(ValueError, 'xml-declarations-refused'):
            m.xml_bytes(b'<!DOCTYPE TABLE [<!ENTITY boom "no">]><TABLE/>')
        target = self.root / 'real'
        target.mkdir()
        link = self.root / 'link'
        link.symlink_to(target, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'symlinks-refused'):
            m.acquire(link, guard=lambda *args: None)

    def test_host_reserve_is_not_relaxed_for_public_bootstrap(self):
        with patch.object(m.Path, 'read_text', return_value='MemAvailable: 4194304 kB\n'), \
             patch.object(m.shutil, 'disk_usage', return_value=SimpleNamespace(free=20*m.GIB-1)):
            with self.assertRaisesRegex(ValueError, 'reserve-20gib'):
                m.acquire(self.output)
        self.assertFalse((self.output / m.WORKSPACE).exists())

    def test_source_descriptors_do_not_advertise_unimplemented_importers(self):
        descriptors = json.loads(Path(m.__file__).with_name('public-catalog-sources.json').read_text())
        self.assertEqual(descriptors['recommended'], ['ciqual-2025'])
        self.assertEqual([source['id'] for source in descriptors['sources'] if source['available']], ['ciqual-2025'])
        for source in descriptors['sources'][1:]:
            self.assertEqual(source['status'], 'experimental-unavailable')
            self.assertIsNone(source['acquisition'])


if __name__ == '__main__':
    unittest.main()
