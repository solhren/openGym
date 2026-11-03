import gzip
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('wger_sample',Path(__file__).with_name('wger-sample.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Response(io.BytesIO):
 def __init__(self,data,status=200,headers=None):super().__init__(data);self.status=status;self.headers=headers or {'ETag':'"fixed"'}
class PrefixTests(unittest.TestCase):
 def setUp(self):self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
 def tearDown(self):self.temp.cleanup()
 def capture(self,data,status=200,headers=None,rows=2):
  r=Response(data,status,headers);opener=type('Opener',(),{'open':lambda _,req,timeout:r})()
  with patch.object(m,'resources',lambda _:{}):return m.capture_prefix(opener,{'etag':'"fixed"'},self.root,rows)
 def data(self):return gzip.compress(b'{"uuid":"one"}\n{"uuid":"two"}\n{"uuid":"three"}\n')
 def test_only_requested_complete_rows_without_full_dump_assumption(self):
  result=self.capture(self.data());self.assertEqual(result['rows'],2);self.assertTrue(result['prefixOnly']);self.assertFalse(result['representative']);self.assertFalse(result['rangeHonored']);self.assertEqual(len((self.root/'rows.jsonl').read_text().splitlines()),2)
 def test_range_validation(self):
  with self.assertRaisesRegex(Exception,'invalid-range'):self.capture(self.data(),206,{'ETag':'"fixed"'})
 def test_changed_export_not_accepted(self):
  with self.assertRaisesRegex(Exception,'export-changed'):self.capture(self.data(),200,{'ETag':'"changed"'})
 def test_invalid_json_never_publishes_capture(self):
  with self.assertRaises(Exception):self.capture(gzip.compress(b'{bad}\n'))
  self.assertFalse((self.root/'rows.jsonl').exists())
 def test_expansion_limit_and_line_limit(self):
  with patch.object(m,'MAX_EXPANDED',10),self.assertRaisesRegex(Exception,'expanded-limit'):self.capture(self.data())
  self.assertFalse((self.root/'rows.jsonl').exists())
 def test_urls_do_not_allow_barcode_queries_that_would_trigger_off(self):
  for url in ['http://wger.de/api/v2/ingredient/?limit=1','https://evil.test/api/v2/ingredient/?limit=1','https://wger.de/api/v2/ingredient/?code=3017620422003','https://wger.de/api/v2/ingredient/?name__search=3017620422003&language=12&limit=10']:
   with self.assertRaises(Exception):m.allowed(url)
  m.allowed('https://wger.de/api/v2/ingredient/?name__search=lait&language=12&limit=10')
 def test_no_redirect_is_followed(self):
  with self.assertRaisesRegex(Exception,'redirect-refused'):m.NoRedirect().redirect_request(None,None,302,'',{},'http://elsewhere')

class LiteralSearchTests(unittest.TestCase):
 def test_search_has_no_fuzzy_or_sql_operators(self):
  import sqlite3
  spec=importlib.util.spec_from_file_location('wger_sqlite',Path(__file__).with_name('wger-sqlite.py'));search_module=importlib.util.module_from_spec(spec);spec.loader.exec_module(search_module)
  c=sqlite3.connect(':memory:')
  try:
   c.executescript("CREATE TABLE products(id INTEGER PRIMARY KEY,uid TEXT,folded TEXT,frfold TEXT,brandfold TEXT,addable INTEGER,complete INTEGER,language TEXT,payload TEXT);CREATE VIRTUAL TABLE products_fts USING fts5(name,name_fr,brand);INSERT INTO products VALUES(1,'wger:uuid','nutella','nutella','brand',0,1,'fr','{}');INSERT INTO products_fts(rowid,name,name_fr,brand) VALUES(1,'Nutella','Nutella','Brand');PRAGMA query_only=ON;")
   self.assertEqual(len(search_module.search(c,'nutella')),1);self.assertEqual(len(search_module.search(c,'nute')),1);self.assertEqual(search_module.search(c,'nutela'),[])
   self.assertEqual(search_module.search(c,"x' OR 1=1"),[])
   self.assertEqual(c.execute('SELECT count(*) FROM products').fetchone()[0],1)
  finally:c.close()
