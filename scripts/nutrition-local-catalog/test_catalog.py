import copy
import contextlib
import fcntl
import hashlib
import io
import json
import resource
from pathlib import Path
import sqlite3
import tempfile
import subprocess
import sys
import time
import unittest
from unittest.mock import patch

from catalog import Catalog, CatalogError, build, canonical, cleanup_generations, digest_file, parse_json, recover_previous, rollback, validate_record, workspace


def record(code='00012345', name='Pâtes complètes', unit='g'):
    return {'code': code, 'name': name, 'nameFr': name, 'brand': 'Exemple', 'countries': ['en:france'], 'reference': {'amount': 100, 'unit': unit}, 'nutrients': {'kcal': 350, 'protein': 12.35, 'carbs': 70.125, 'fat': 0}, 'portions': [], 'warnings': [], 'modifiedAt': None}


def protocol(records):
    lines = b''.join((json.dumps({'record': r}, ensure_ascii=False, separators=(',', ':')) + '\n').encode() for r in records)
    seal = {'count': len(records), 'digest': hashlib.sha256(lines).hexdigest(), 'source': {'kind': 'fixture', 'version': 'test-v1', 'inputSha256': '0'*64, 'scanned': len(records), 'rejected': 0, 'filtered': 0}}
    return lines + (json.dumps({'seal': seal}) + '\n').encode()


def preserve_address_space_limit(case):
    # The real builder lowers the process soft limit. Exercise that protection,
    # then restore the test runner's entry state, not a production worker's cap.
    previous = resource.getrlimit(resource.RLIMIT_AS)
    case.addCleanup(resource.setrlimit, resource.RLIMIT_AS, previous)


class CatalogueTest(unittest.TestCase):
    def setUp(self):
        preserve_address_space_limit(self)
        self.temp = tempfile.TemporaryDirectory(prefix='opengym-catalog-test-')
        self.root = Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)

    def write(self, rows=None, failpoint=None):
        return build(self.root, io.BytesIO(protocol(rows or [record()])), failpoint)

    def read(self):
        catalogue = Catalog(self.root)
        self.addCleanup(catalogue.close)
        return catalogue

    def test_canonical_numeric_equivalence_without_rounding(self):
        self.assertEqual(canonical({'n': [0, 6, 100]}), canonical({'n': [-0.0, 6.0, 100.0]}))
        self.assertNotEqual(canonical(0.10000000000000002), canonical(0.1))
        with self.assertRaises(ValueError):
            canonical(float('nan'))

    def test_builder_limit_is_exercised_and_restored_between_test_cases(self):
        previous = resource.getrlimit(resource.RLIMIT_AS)
        outer = self
        class BuilderCase(unittest.TestCase):
            def runTest(case):
                preserve_address_space_limit(case)
                outer.write()
                case.assertLessEqual(resource.getrlimit(resource.RLIMIT_AS)[0], 256 * 1024**2)
        result = unittest.TestResult(); BuilderCase().run(result)
        self.assertTrue(result.wasSuccessful(), result.errors)
        self.assertEqual(resource.getrlimit(resource.RLIMIT_AS), previous)

    def test_exact_round_trip_decimals_and_integer_real(self):
        self.write()
        result = self.read().barcode('00012345')
        self.assertEqual(result, record())
        self.assertEqual(result['nutrients']['protein'], 12.35)
        self.assertEqual(result['nutrients']['carbs'], 70.125)
        self.assertEqual(result['nutrients']['fat'], 0)

    def test_repeated_round_trip_does_not_drift(self):
        value = record()
        value['nutrients'].update(kcal=83.33333333333333, protein=0.10000000000000002)
        for _ in range(3):
            self.write([value])
            value = self.read().barcode(value['code'])
        self.assertEqual(value['nutrients']['kcal'], 83.33333333333333)
        self.assertEqual(value['nutrients']['protein'], 0.10000000000000002)

    def test_ml_and_g_never_convert(self):
        water = record('00012346', 'Lait', 'ml')
        self.write([record(), water])
        catalogue = self.read()
        self.assertEqual(catalogue.barcode('00012346')['reference'], {'amount': 100, 'unit': 'ml'})
        self.assertEqual(catalogue.barcode('00012345')['reference'], {'amount': 100, 'unit': 'g'})

    def test_null_is_not_zero(self):
        value = record()
        value['nutrients'].update(kcal=None, carbs=None)
        self.write([value])
        self.assertIsNone(self.read().barcode('00012345')['nutrients']['kcal'])
        self.assertEqual(self.read().barcode('00012345')['nutrients']['fat'], 0)

    def test_ambiguous_reference_requires_unknown_nutrients(self):
        value = record()
        value['reference'] = None
        with self.assertRaisesRegex(CatalogError, 'ambiguous-reference'):
            self.write([value])
        value['nutrients'] = dict.fromkeys(value['nutrients'])
        self.write([value])
        self.assertIsNone(self.read().barcode(value['code'])['reference'])

    def test_complete_results_come_before_incomplete(self):
        partial = record('00012344', 'Pâtes')
        partial['nutrients']['kcal'] = None
        self.write([partial, record(name='Pâtes')])
        self.assertEqual(self.read().search('pates')['products'][0]['code'], '00012345')

    def test_exact_name_beats_complete_brand_and_longer_names(self):
        exact = record('00012344', 'Lait')
        exact['nutrients']['kcal'] = None
        prefix = record('00012345', 'Lait entier')
        other = record('00012346', 'Chocolat'); other['brand'] = 'Lait'
        self.write([other, prefix, exact])
        self.assertEqual([r['code'] for r in self.read().search('lait')['products']], ['00012344', '00012345', '00012346'])

    def test_same_relevance_prefers_usable_macros_then_french_name(self):
        complete = record('00012347', 'Riz'); complete['nameFr'] = ''
        french = record('00012346', 'Riz')
        partial = record('00012345', 'Riz'); partial['nutrients']['kcal'] = None
        empty = record('00012344', 'Riz'); empty['nutrients'] = dict.fromkeys(empty['nutrients'])
        self.write([empty, partial, complete, french])
        self.assertEqual([r['code'] for r in self.read().search('riz')['products']], ['00012346', '00012347', '00012345', '00012344'])

    def test_unicode_decomposed_query_and_names(self):
        self.write([record(name='Pa\u0302tes comple\u0300tes')])
        self.assertEqual(self.read().search('pâtes')['products'], self.read().search('pa\u0302tes')['products'])

    def test_french_accents_prefixes_brand_and_hyphen(self):
        rows = [record(), record('00012346', 'Coca-Cola'), record('00012347', 'Yaourts natures')]
        rows[0]['brand'] = 'Panzani'
        self.write(rows)
        catalogue = self.read()
        self.assertEqual(catalogue.search('pâtes')['products'], catalogue.search('PATES')['products'])
        self.assertEqual(catalogue.search('Panzani')['products'][0]['code'], '00012345')
        self.assertEqual(catalogue.search('coca cola')['products'], catalogue.search('Coca-Cola')['products'])
        self.assertEqual(catalogue.search('yaourt')['products'][0]['code'], '00012347')

    def test_all_six_required_french_queries(self):
        self.write([record(str(12340+i).zfill(8), name) for i, name in enumerate(['Nutella', 'Coca-Cola', 'Lait demi-écrémé', 'Riz', 'Pâtes', 'Yaourt'])])
        for q in ('nutella', 'Coca-Cola', 'lait', 'riz', 'pates', 'yaourt'):
            self.assertEqual(len(self.read().search(q)['products']), 1)

    def test_french_compounds_keep_single_letter_words_without_allowing_broad_queries(self):
        self.write([record(name='Pâte à tartiner'),record('00012346',"Lait d'amande")])
        reader=self.read()
        self.assertEqual(reader.search('pate a tartiner')['products'][0]['name'],'Pâte à tartiner')
        self.assertEqual(reader.search("lait d'amande")['products'][0]['code'],'00012346')
        with self.assertRaises(CatalogError):reader.search('a b')

    def test_barcode_zeroes_and_aliases(self):
        self.write()
        catalogue = self.read()
        self.assertEqual(catalogue.barcode('00012345')['code'], '00012345')
        self.assertEqual(catalogue.barcode('0000000012345')['code'], '00012345')
        self.assertIsNone(catalogue.barcode('00054321'))
        for code in (12345, '', '12345', '１２３４５６７８'):
            with self.assertRaises(CatalogError):
                catalogue.barcode(code)

    def test_pagination_has_no_overlap_and_is_bounded(self):
        self.write([record(str(12340+i).zfill(8)) for i in range(45)])
        catalogue = self.read()
        first, second = catalogue.search('pates'), catalogue.search('pates', page=2)
        self.assertEqual(first['count'], 45)
        self.assertTrue(first['hasMore'])
        self.assertFalse(set(p['code'] for p in first['products']) & set(p['code'] for p in second['products']))
        self.assertFalse(catalogue.search('pates', page=3)['hasMore'])
        for page, size in ((0, 20), (21, 20), (1, 21), (True, 20)):
            with self.assertRaises(CatalogError):
                catalogue.search('pates', page, size)

    def test_fts_and_sql_syntax_is_literal_or_rejected(self):
        self.write()
        catalogue = self.read()
        for q in ('" OR *', 'pates OR lait', 'pates; DROP TABLE products', 'NEAR(pates lait)', 'name:pates'):
            try:
                self.assertEqual(catalogue.search(q)['products'], [])
            except CatalogError:
                pass
        self.assertEqual(catalogue.search('pates')['products'][0]['code'], '00012345')

    def test_bad_query_limits(self):
        self.write()
        for q in ('', 'a', 'x'*121, 'a '*9, 'ab\x00cd', None, {'query': 'pates'}):
            with self.assertRaises(CatalogError):
                self.read().search(q)

    def test_html_is_only_literal_data(self):
        value = record(name='<script>alert(1)</script> Pâtes')
        self.write([value])
        self.assertEqual(self.read().barcode(value['code'])['name'], value['name'])

    def test_read_connection_refuses_writes(self):
        self.write()
        with self.assertRaises(sqlite3.OperationalError):
            self.read().connection.execute('DELETE FROM products')

    def test_identical_duplicates_accept_integer_real_equivalence(self):
        same = record()
        same['nutrients']['kcal'] = 350.0
        result = self.write([record(), same])
        self.assertEqual(result['duplicates'], 1)
        self.assertEqual(result['products'], 1)

    def test_conflicting_duplicate_preserves_old_catalogue(self):
        self.write()
        old = (self.root/'current.json').read_bytes()
        changed = record()
        changed['nutrients']['protein'] = 12.36
        with self.assertRaisesRegex(CatalogError, 'incompatible-duplicate'):
            self.write([record(), changed])
        self.assertEqual((self.root/'current.json').read_bytes(), old)
        self.assertEqual(self.read().barcode('00012345'), record())

    def test_bad_records_rejected(self):
        base = record()
        for key, value in [('countries', [{}]), ('warnings', [{}]), ('modifiedAt', True), ('nutrients', {'kcal': float('inf'), 'protein': 1, 'carbs': 2, 'fat': 3}), ('reference', {'amount': 100, 'unit': 'kg'})]:
            r = copy.deepcopy(base)
            r[key] = value
            with self.assertRaises(CatalogError):
                validate_record(r)
        for value in (-1, float('nan'), True, '12', 100.0001):
            r = copy.deepcopy(base)
            r['nutrients']['protein'] = value
            with self.assertRaises(CatalogError):
                validate_record(r)

    def test_unsealed_truncated_and_reordered_protocol_cannot_publish(self):
        self.write()
        old = (self.root/'current.json').read_bytes()
        good = protocol([record()])
        lines = good.splitlines(keepends=True)
        for raw in (lines[0], good[:-1], b'{bad}\n', b'x'*16385+b'\n', lines[1]+lines[0], good+lines[0]):
            with self.assertRaises(CatalogError):
                build(self.root, io.BytesIO(raw))
            self.assertEqual((self.root/'current.json').read_bytes(), old)

    def test_seal_checksum_and_count_required(self):
        for replacements in ({'digest': '0'*64}, {'count': 2}):
            lines = protocol([record()]).splitlines()
            seal = json.loads(lines[1])
            seal['seal'].update(replacements)
            with self.assertRaisesRegex(CatalogError, 'seal'):
                build(self.root, io.BytesIO(lines[0]+b'\n'+json.dumps(seal).encode()+b'\n'))

    def test_proto_duplicate_nonfinite_deep_json_rejected(self):
        for raw in ('{"__proto__":{}}', '{"record":1,"record":2}', '{"v":NaN}', '['*2000+']'*2000):
            with self.assertRaises(CatalogError):
                parse_json(raw)

    def test_missing_and_corrupt_database(self):
        with self.assertRaises(CatalogError):
            Catalog(self.root)
        self.write()
        manifest = json.loads((self.root/'current.json').read_text())
        path = self.root/manifest['file']
        with path.open('r+b') as f:
            f.seek(5000)
            f.write(b'corrupt')
        with self.assertRaisesRegex(CatalogError, 'corrupt-generation'):
            Catalog(self.root)

    def test_manifest_paths_and_versions_refused(self):
        self.write()
        base = json.loads((self.root/'current.json').read_text())
        for change in ({'file': '../private.sqlite'}, {'file': 12}, {'version': 4}, {'bytes': 1}, {'products': 2}, {'extra': 'x'}, {'source': {'bad': 1}}):
            (self.root/'current.json').write_text(json.dumps({**base, **change}))
            with self.assertRaises(CatalogError):
                Catalog(self.root)

    def test_record_hash_detects_changed_decimal_even_if_file_hash_resealed(self):
        self.write()
        manifest = json.loads((self.root/'current.json').read_text())
        path = self.root/manifest['file']
        with contextlib.closing(sqlite3.connect(path)) as connection, connection:
            connection.execute('UPDATE products SET protein=12.36')
        manifest['sha256'] = digest_file(path)
        (self.root/'current.json').write_text(json.dumps(manifest))
        with self.assertRaisesRegex(CatalogError, 'corrupt-record'):
            self.read().barcode('00012345')

    def test_old_v1_generation_reads_and_rolls_back_after_v3_build(self):
        self.write()
        manifest = json.loads((self.root/'current.json').read_text())
        database = self.root/manifest['file']
        with contextlib.closing(sqlite3.connect(database)) as connection, connection:
            for field in ('name_fold', 'name_fr_fold', 'brand_fold'):
                connection.execute('ALTER TABLE products DROP COLUMN '+field)
            connection.execute('PRAGMA user_version=1')
        manifest.update(version=1, bytes=database.stat().st_size, sha256=digest_file(database))
        (self.root/'current.json').write_text(json.dumps(manifest))
        self.assertEqual(self.read().search('pates')['products'][0], record())
        self.write([record(name='Nouvelle génération')])
        self.assertEqual(self.read().manifest['version'], 3)
        rollback(self.root)
        self.assertEqual(self.read().manifest['version'], 1)
        self.assertEqual(self.read().search('pates')['products'][0], record())

    def test_tampered_derived_search_fields_are_rejected_even_when_resealed(self):
        self.write()
        manifest = json.loads((self.root/'current.json').read_text())
        database = self.root/manifest['file']
        with contextlib.closing(sqlite3.connect(database)) as connection, connection:
            connection.execute("UPDATE products SET name_fold='wrong'")
        manifest['sha256'] = digest_file(database)
        (self.root/'current.json').write_text(json.dumps(manifest))
        with self.assertRaisesRegex(CatalogError, 'corrupt-search-fields'):
            self.read().barcode('00012345')

    def test_explicit_recovery_from_corrupt_current_preserves_both_files(self):
        self.write(); self.write([record(name='New')])
        manifest = json.loads((self.root/'current.json').read_text())
        corrupt = self.root/manifest['file']
        corrupt.write_bytes(b'corrupted')
        with self.assertRaises(CatalogError): self.read()
        result = recover_previous(self.root)
        self.assertEqual(result['status'], 'recovered-previous')
        self.assertEqual(self.read().barcode('00012345'), record())
        self.assertTrue(corrupt.exists())
        self.assertTrue((self.root/manifest['previous']['file']).exists())

    def test_recovery_never_guesses_after_malformed_manifest_or_corrupt_previous(self):
        self.write(); self.write([record(name='New')])
        manifest = json.loads((self.root/'current.json').read_text())
        with self.assertRaisesRegex(CatalogError, 'recovery-not-required'): recover_previous(self.root)
        (self.root/manifest['file']).write_bytes(b'bad')
        (self.root/manifest['previous']['file']).write_bytes(b'bad previous')
        old = (self.root/'current.json').read_bytes()
        with self.assertRaises(CatalogError): recover_previous(self.root)
        self.assertEqual(old, (self.root/'current.json').read_bytes())
        (self.root/'current.json').write_text('{bad}')
        with self.assertRaises(CatalogError): recover_previous(self.root)
        self.assertEqual((self.root/'current.json').read_text(), '{bad}')

    def test_each_interruption_keeps_old_or_complete_new(self):
        self.write()
        for point in ('rows', 'verified', 'generation', 'published'):
            old = (self.root/'current.json').read_bytes()
            old_value = self.read().barcode('00012345')
            changed = record(name='Nouveau lait '+point)
            with self.assertRaisesRegex(CatalogError, 'simulated-interruption'):
                self.write([changed], point)
            actual = self.read().barcode('00012345')
            self.assertEqual(actual, changed if point == 'published' else old_value)
            if point != 'published':
                self.assertEqual((self.root/'current.json').read_bytes(), old)
            self.assertFalse(list(self.root.glob('*.partial')))

    def test_old_reader_pins_generation_during_publication_and_rebuild(self):
        self.write()
        old = self.read()
        previous = old.manifest['file']
        self.write([record(name='Nouveau lait')])
        self.assertEqual(old.barcode('00012345')['name'], 'Pâtes complètes')
        self.assertEqual(self.read().barcode('00012345')['name'], 'Nouveau lait')
        self.assertTrue((self.root/previous).exists())
        self.write([record(name='Nouveau lait')])
        self.assertEqual(self.read().barcode('00012345')['name'], 'Nouveau lait')

    def test_concurrent_writer_refused(self):
        with (self.root/'writer.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(CatalogError, 'writer-busy'):
                self.write()

    def test_quota_failure_preserves_old(self):
        self.write()
        old = (self.root/'current.json').read_bytes()
        with patch('catalog.resources', side_effect=CatalogError('insufficient-free-disk')):
            with self.assertRaisesRegex(CatalogError, 'insufficient-free-disk'):
                self.write()
        self.assertEqual((self.root/'current.json').read_bytes(), old)

    def test_isolated_workspaces_and_safe_names(self):
        self.write()
        with tempfile.TemporaryDirectory(prefix='opengym-other-catalog-') as other:
            build(Path(other), io.BytesIO(protocol([record(name='Autre catalogue')])))
            with CatalogContext(Path(other)) as catalogue:
                self.assertEqual(catalogue.barcode('00012345')['name'], 'Autre catalogue')
        self.assertEqual(self.read().barcode('00012345')['name'], 'Pâtes complètes')
        for name in ('../data', '/data', 'a/b', '', 'x'*41):
            with self.assertRaises(CatalogError):
                workspace(name)

    def test_explicit_rollback_and_forward_preserve_both_generations(self):
        self.write()
        original = self.read().manifest['file']
        self.write([record(name='Nouveau lait')])
        newest = self.read().manifest['file']
        self.assertEqual(rollback(self.root)['file'], original)
        self.assertEqual(self.read().barcode('00012345')['name'], 'Pâtes complètes')
        self.assertEqual(rollback(self.root)['file'], newest)
        self.assertEqual(self.read().barcode('00012345')['name'], 'Nouveau lait')

    def test_no_rollback_without_valid_anchor(self):
        self.write()
        with self.assertRaisesRegex(CatalogError, 'no-previous'):
            rollback(self.root)
        old = self.read().manifest['file']
        self.write([record(name='Nouveau lait')])
        with (self.root/old).open('r+b') as f:
            f.write(b'corrupt')
        current = (self.root/'current.json').read_bytes()
        with self.assertRaisesRegex(CatalogError, 'corrupt-generation'):
            rollback(self.root)
        self.assertEqual((self.root/'current.json').read_bytes(), current)

    def test_cleanup_only_explicit_old_generation_and_reader_stays_pinned(self):
        self.write()
        pinned = self.read()
        old = pinned.manifest['file']
        self.write([record(name='Deux')])
        self.write([record(name='Trois')])
        current = self.read().manifest
        for name in (current['file'], current['previous']['file'], '../db.json'):
            with self.assertRaises(CatalogError):
                cleanup_generations(self.root, [old, name])
            self.assertTrue((self.root/old).exists())
        self.assertEqual(cleanup_generations(self.root, [old])['files'], [old])
        self.assertFalse((self.root/old).exists())
        self.assertEqual(pinned.barcode('00012345')['name'], 'Pâtes complètes')
        self.assertEqual(self.read().barcode('00012345')['name'], 'Trois')

    def test_manifest_previous_chain_is_bounded(self):
        self.write()
        for i in range(4):
            self.write([record(name='Version '+str(i))])
            manifest = self.read().manifest
            self.assertNotIn('previous', manifest['previous'])
            self.assertLess((self.root/'current.json').stat().st_size, 4096)

    def test_symlink_generation_is_refused(self):
        self.write()
        manifest = self.read().manifest
        path = self.root/manifest['file']
        renamed = self.root/'real.sqlite'
        path.rename(renamed)
        path.symlink_to(renamed)
        with self.assertRaisesRegex(CatalogError, 'unsafe-generation'):
            Catalog(self.root)

    def test_process_kill_keeps_current_and_releases_writer_lock(self):
        self.write()
        old = (self.root/'current.json').read_bytes()
        script = 'import sys;from pathlib import Path;from catalog import build;build(Path(sys.argv[1]),sys.stdin.buffer)'
        child = subprocess.Popen([sys.executable, '-c', script, str(self.root)], cwd=Path(__file__).parent, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            child.stdin.write(protocol([record()]).splitlines(keepends=True)[0])
            child.stdin.flush()
            deadline = time.monotonic()+3
            while not list(self.root.glob('*.partial')) and time.monotonic()<deadline:
                time.sleep(.01)
            self.assertTrue(list(self.root.glob('*.partial')))
            child.kill()
            child.wait(timeout=3)
        finally:
            if child.poll() is None:
                child.kill()
            child.communicate(timeout=3)
        self.assertEqual((self.root/'current.json').read_bytes(), old)
        self.assertEqual(self.read().barcode('00012345'), record())
        self.write([record(name='Après redémarrage')])
        self.assertEqual(self.read().barcode('00012345')['name'], 'Après redémarrage')

    def test_disk_full_during_insert_preserves_published_generation(self):
        self.write()
        old = (self.root/'current.json').read_bytes()
        original_connect = sqlite3.connect
        class FullDisk(sqlite3.Connection):
            def execute(self, sql, *args):
                if sql.startswith('INSERT INTO products('):
                    raise sqlite3.OperationalError('database or disk is full')
                return super().execute(sql, *args)
        def connect(path, *args, **kwargs):
            return original_connect(path, *args, **{**kwargs, 'factory': FullDisk})
        with patch('catalog.sqlite3.connect', connect):
            with self.assertRaisesRegex(sqlite3.OperationalError, 'disk is full'):
                self.write([record(name='Ne pas publier')])
        self.assertEqual((self.root/'current.json').read_bytes(), old)
        self.assertEqual(self.read().barcode('00012345'), record())

    def test_expensive_query_is_interrupted_without_partial_success(self):
        self.write([record(str(12340+i).zfill(8)) for i in range(800)])
        catalogue = self.read()
        ticks = iter([0, 1])
        with patch('catalog.time.monotonic', side_effect=lambda: next(ticks, 1)):
            with self.assertRaisesRegex(CatalogError, 'query-budget-exceeded'):
                catalogue.search('pates')
        self.assertEqual(catalogue.search('pates')['count'], 800)


class CatalogContext(Catalog):
    def __enter__(self):
        return self
    def __exit__(self, *args):
        self.close()

if __name__ == '__main__':
    unittest.main()
