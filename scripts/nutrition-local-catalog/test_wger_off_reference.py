import copy,importlib.util,json,sqlite3,unittest
from pathlib import Path
from unittest.mock import patch
import test_off_reference_full as full_fixture
from test_wger_generation import row,wire

s=importlib.util.spec_from_file_location('combined',Path(__file__).with_name('wger-off-reference.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)

class CombinedReferenceTests(unittest.TestCase):
 def setUp(self):
  self.fixture=full_fixture.FullReferenceTests();self.fixture.setUp();self.addCleanup(self.fixture.tearDown);self.root=self.fixture.root
  original=self.fixture.fixture
  def food(code,unit):
   p=original(code,unit);p['product_name']='Nutella'if code==self.fixture.codes[0]else'Coca-Cola';return p
  self.fixture.fixture=food;self.fixture.build()
  self.patches=[patch.object(m.off,'BASE',self.root),patch.object(m.quality.wger,'BASE',self.root),patch.object(m,'resources',return_value={'freeDiskBytes':40*1024**3,'availableMemoryBytes':4*1024**3})]
  for p in self.patches:p.start();self.addCleanup(p.stop)
  self.base=self.root/'base';self.base.mkdir();self.q=self.root/'quality';self.q.mkdir()
  a=row(name='Nutella');a.update(barcode='3017620422003',sourceKind='off-derived',food=None,issues=['off-100g-or-100ml-reference-lost'],provenance={'sourceUrl':'https://world.openfoodfacts.org/api/v2/product/3017620422003'})
  b=copy.deepcopy(a);b['id']='wger:12345678-1234-1234-1234-123456789abd';b['barcode']='03017620422003';b['language']='en'
  native=row('12345678-1234-1234-1234-123456789abe','Rice raw');native.update(barcode=None,brand='',sourceKind='usda',food={'reference':{'amount':100,'unit':'g'},'nutrients':{'kcal':350,'protein':7,'carbs':75,'fat':1}})
  unavailable=copy.deepcopy(a);unavailable.update(id='wger:12345678-1234-1234-1234-123456789abf',name='Coca',nameFr='Coca',barcode='12345678',provenance={'sourceUrl':''})
  m.quality.wger.build(self.base,wire([a,b,native,unavailable]));base=m.quality.wger.Reader(self.base)
  try:m.quality.build(base,self.q,{'baseSha256':base.manifest['sha256'],'aliases':[{'uid':native['id'],'label':'Riz cru','terms':'riz','expectedName':native['name']}]})
  finally:base.close()
 def build(self,**kw):return m.build('base','quality','normalized','index',**kw)
 def reader(self):
  r=m.Reader(m.quality.Reader(m.quality.wger.Reader(self.base),self.q),self.root/'normalized',self.root/'index');self.addCleanup(r.close);return r
 def test_deduplicated_literal_union_hydrates_and_discovers_missing_wger_products(self):
  manifest=self.build();self.assertEqual(manifest['rows'],2);self.assertEqual(manifest['bindings'],2)
  r=self.reader();p=r.search('nutella')['products'];self.assertEqual(len(p),1);self.assertEqual(p[0]['id'],'off:03017620422003');self.assertEqual(p[0]['food']['reference']['unit'],'g')
  liquid=r.search('Coca-Cola')['products'];self.assertEqual(len(liquid),1);self.assertEqual(liquid[0]['food']['reference']['unit'],'ml')
  self.assertEqual(r.product('wger:12345678-1234-1234-1234-123456789abc')['id'],p[0]['id'])
  self.assertEqual(r.barcode('03017620422003')[0]['id'],p[0]['id']);self.assertEqual(r.search('nutela')['products'],[]);self.assertEqual(r.search('cocacola')['products'],[])
  self.assertEqual(r.search('riz')['products'][0]['name'],'Riz cru')
 def test_exact_unusable_product_precedes_different_usable_prefix_and_pagination_is_stable(self):
  self.build();r=self.reader();found=r.search('Coca');self.assertEqual(found['count'],2);self.assertEqual(found['products'][0]['name'],'Coca');self.assertIsNone(found['products'][0]['food']);self.assertIsNotNone(found['products'][1]['food'])
  a=r.search('Coca',1,1);b=r.search('Coca',2,1);self.assertNotEqual(a['products'][0]['id'],b['products'][0]['id']);self.assertEqual(a['count'],b['count'])
  for q,page in [('x'*121,1),('nutella',21),('a b c d e f g h i',1)]:
   with self.assertRaises(Exception):r.search(q,page)
 def test_interrupted_index_does_not_publish_or_modify_original_generations(self):
  original=(self.root/'normalized'/'current.json').read_bytes()
  with self.assertRaisesRegex(Exception,'simulated-index-interruption'):self.build(fail_after=1)
  self.assertFalse((self.root/'index'/'current.json').exists());self.assertEqual((self.root/'normalized'/'current.json').read_bytes(),original)
 def test_corrupt_or_mismatched_index_refuses_reader(self):
  self.build();file=self.root/'index'/'current.json';p=json.loads(file.read_text());p['referenceSha256']='a'*64;file.write_text(json.dumps(p))
  with self.assertRaisesRegex(Exception,'search-source-mismatch'):self.reader()
 def test_warmup_really_reads_the_covering_index_instead_of_sqlite_count_star_fast_path(self):
  self.build();base=m.quality.wger.Reader(self.base);quality=m.quality.Reader(base,self.q);statements=[]
  base.c.set_trace_callback(statements.append)
  r=m.Reader(quality,self.root/'normalized',self.root/'index');self.addCleanup(r.close)
  warm=[sql for sql in statements if 'FROM products INDEXED BY search_rank_idx'in sql]
  self.assertEqual(warm,['SELECT count(id)FROM products INDEXED BY search_rank_idx'])
  plan=base.c.execute('EXPLAIN QUERY PLAN '+warm[0]).fetchall()
  self.assertTrue(any('search_rank_idx'in row[-1]for row in plan),plan)
  self.assertFalse(any('language_idx'in row[-1]for row in plan),plan)
  self.assertEqual(base.c.execute(warm[0]).fetchone()[0],base.manifest['rows'])
 def test_warming_does_not_change_ranked_results_or_barcode_references(self):
  self.build();r=self.reader()
  expected={query:r.search(query)for query in ['Nutella','Coca-Cola','lait','riz','pâtes','yaourt','Coca']}
  r.base.c.execute('SELECT count(id)FROM products INDEXED BY search_rank_idx').fetchone()
  for query,result in expected.items():self.assertEqual(r.search(query),result)
  self.assertEqual(r.barcode('3017620422003')[0]['food']['reference']['unit'],'g')
  self.assertEqual(r.barcode('5449000000996')[0]['food']['reference']['unit'],'ml')
 def test_representative_searches_and_deadline_recovery_with_many_milk_matches(self):
  large=self.root/'base-large';large.mkdir();q=self.root/'quality-large';q.mkdir();rows=[]
  names=['Lait','Nutella','Coca-Cola','Riz basmati','Pâtes complètes','Yaourt nature']+[f'Lait demi-écrémé {i}'for i in range(300)]
  for i,name in enumerate(names):
   p=row(f'00000000-0000-4000-8000-{i:012x}',name);p.update(barcode=None,brand='',sourceKind='usda',food={'reference':{'amount':100,'unit':'g'},'nutrients':{'kcal':60,'protein':3,'carbs':5,'fat':3}});rows.append(p)
  m.quality.wger.build(large,wire(rows));b=m.quality.wger.Reader(large)
  try:m.quality.build(b,q,{'baseSha256':b.manifest['sha256'],'aliases':[{'uid':rows[0]['id'],'label':'Lait','terms':'lait','expectedName':'Lait'}]})
  finally:b.close()
  m.build('base-large','quality-large','normalized','index-large')
  r=m.Reader(m.quality.Reader(m.quality.wger.Reader(large),q),self.root/'normalized',self.root/'index-large');self.addCleanup(r.close)
  expected={query:r.search(query)for query in ['Nutella','Coca-Cola','lait','riz','pates','yaourt']}
  self.assertEqual(expected['lait']['products'][0]['name'],'Lait');self.assertGreater(expected['lait']['count'],300)
  for query,result in expected.items():self.assertTrue(result['products'],query);self.assertEqual(r.search(query),result)
  ticks=[10.0]
  def advance():ticks[0]+=1.1;return ticks[0]
  with patch.object(m.time,'monotonic',side_effect=advance):
   with self.assertRaisesRegex(sqlite3.OperationalError,'interrupted'):r.search('lait')
  self.assertEqual(r.search('lait'),expected['lait'])

if __name__=='__main__':unittest.main()
