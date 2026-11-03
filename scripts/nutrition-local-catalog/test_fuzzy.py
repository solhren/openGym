"""Deterministic labelled fixtures, not claims about actual OFF products."""
import contextlib
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from catalog import Catalog, CatalogError, build
from test_catalog import record, protocol, preserve_address_space_limit
from fuzzy import distance, alternatives, MAX_CANDIDATES

class FuzzyTest(unittest.TestCase):
    def setUp(self):
        preserve_address_space_limit(self)
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        names = ['Nutella', 'Coca-Cola', 'Pâte à tartiner', "Lait d'amande", 'Yaourt', 'Noir chocolat', 'Chocolat noir', 'Yaourtière', 'Nuit étoilée']
        build(self.root, io.BytesIO(protocol([record(str(12000+i).zfill(8), n) for i,n in enumerate(names)])))
        self.cat = Catalog(self.root); self.addCleanup(self.cat.close)
    def test_requested_queries(self):
        for query, name in [('nutela','Nutella'), ('cocacola','Coca-Cola'), ('pate tartiner','Pâte à tartiner'), ('lait amande',"Lait d'amande"), ('yaort','Yaourt'), ('chocolat noir','Chocolat noir')]:
            with self.subTest(query=query): self.assertEqual(self.cat.search(query)['products'][0]['name'],name)
    def test_exact_is_never_replaced_or_augmented_by_fuzzy(self):
        with patch('catalog.fallback_match', side_effect=AssertionError('unnecessary fallback')):
            self.assertEqual(self.cat.search('yaourt')['matchMode'],'literal')
        self.assertEqual(self.cat.search('nutela')['matchMode'],'fuzzy')
    def test_short_queries_do_not_guess(self):
        self.assertEqual(self.cat.search('yau')['products'],[])
        self.assertEqual(self.cat.search('nu')['products'],[]) # final prefix below three
    def test_accents_unicode_and_word_order(self):
        self.assertEqual(self.cat.search('PA\u0302TE TARTINER')['products'][0]['name'],'Pâte à tartiner')
        self.assertEqual({p['name'] for p in self.cat.search('noir chocolat')['products']},{'Noir chocolat','Chocolat noir'})
    def test_transposition_and_length_thresholds(self):
        self.assertEqual(distance('nutlela','nutella',2),1)
        self.assertEqual(self.cat.search('nutlela')['products'][0]['name'],'Nutella')
        self.assertEqual(self.cat.search('xyort')['products'],[])
        self.assertEqual(self.cat.search('xyz')['products'],[])
    def test_candidate_distance_is_bounded(self):
        # Indexed vocabulary can be huge; distance sees only shortlisted terms.
        from fuzzy import distance as actual
        with patch('fuzzy.distance', wraps=actual) as compare:
            alternatives(self.cat.connection,'nutela',lambda:None)
            self.assertLessEqual(compare.call_count,MAX_CANDIDATES)
    def test_fts_and_sql_syntax_never_executed(self):
        for query in ['nutela OR anything', '"; DROP TABLE products;--', 'nutela* NEAR(yaort)', '%_nutela']:
            self.cat.search(query)
        self.assertEqual(self.cat.barcode('00012000')['name'],'Nutella')
    def test_fuzzy_pagination_is_stable_without_duplicates(self):
        first=self.cat.search('choclat noir',page_size=1)
        second=self.cat.search('choclat noir',page=2,page_size=1)
        self.assertEqual(first['count'],2)
        self.assertNotEqual(first['products'][0]['code'],second['products'][0]['code'])
    def test_interruption_building_fuzzy_index_keeps_old_generation(self):
        import sqlite3
        with patch('catalog.create_index',side_effect=sqlite3.OperationalError('simulated disk full during fuzzy index')):
            with self.assertRaises(sqlite3.OperationalError):
                build(self.root,io.BytesIO(protocol([record(name='Replacement')])) )
        with contextlib.closing(Catalog(self.root)) as unchanged:
            self.assertEqual(unchanged.manifest['sha256'],self.cat.manifest['sha256'])
            self.assertEqual(unchanged.search('nutela')['products'][0]['name'],'Nutella')
        self.assertEqual(list(self.root.glob('*.partial')),[])
    def test_deadline_covers_python_candidate_generation(self):
        with patch('catalog.time.monotonic',side_effect=[1,2]):
            with self.assertRaisesRegex(CatalogError,'query-budget-exceeded'):self.cat.search('nutela')
        self.assertEqual(self.cat.search('nutella')['count'],1)
    def test_legacy_v2_is_readable_but_cannot_claim_fuzzy(self):
        import sqlite3,json
        from catalog import digest_file
        value=dict(self.cat.manifest);database=self.root/value['file']
        self.cat.close()
        with contextlib.closing(sqlite3.connect(database)) as connection,connection:
            connection.execute('DROP TABLE search_terms');connection.execute('DROP TABLE search_grams');connection.execute('PRAGMA user_version=2')
        value.update(version=2,bytes=database.stat().st_size,sha256=digest_file(database))
        (self.root/'current.json').write_text(json.dumps(value))
        with contextlib.closing(Catalog(self.root)) as old:
            self.assertEqual(old.search('nutella')['count'],1);self.assertEqual(old.search('nutela')['count'],0)
    def test_french_preference_is_only_applied_for_french_locale(self):
        first=record('00011000','Rice');first['nameFr']=''
        second=record('00011001','Rice');second['nameFr']='Riz'
        build(self.root,io.BytesIO(protocol([first,second])))
        with contextlib.closing(Catalog(self.root)) as new:
            self.assertEqual(new.search('rice',language='fr')['products'][0]['code'],'00011001')
            self.assertEqual(new.search('rice',language='en')['products'][0]['code'],'00011000')
            with self.assertRaisesRegex(CatalogError,'invalid-language'):new.search('rice',language='fr-FR')

    def test_resource_reserve_refuses_writes(self):
        import shutil
        with patch('catalog.shutil.disk_usage',return_value=shutil._ntuple_diskusage(30<<30,11<<30,19<<30)):
            with self.assertRaisesRegex(CatalogError,'insufficient-free-disk'):
                build(self.root,io.BytesIO(protocol([record()])))
        with contextlib.closing(Catalog(self.root)) as unchanged:
            self.assertEqual(unchanged.manifest['sha256'],self.cat.manifest['sha256'])

if __name__=='__main__':unittest.main()
