import gzip
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('selector',Path(__file__).with_name('select-tsv.py'))
selector=importlib.util.module_from_spec(spec);spec.loader.exec_module(selector)
class SelectionTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name);self.patch=patch.object(selector,'BASE',self.root);self.patch.start();self.resources=patch.object(selector,'resources',lambda _:{});self.resources.start()
 def tearDown(self):self.resources.stop();self.patch.stop();self.temp.cleanup()
 def source(self,tail=''):
  source=self.root/'source.gz';source.write_bytes(gzip.compress(('code\tproduct_name\tbrands\tcountries_tags\tenergy-kcal_100g\tcreator\n0034000470693\tLait\tMarque\ten:france\t12.345\tsecret\n3017620422003\tNutella\tFerrero\ten:italy,en:france\t539\tsecret\n00012345\tRice\tBrand\ten:usa\t\tsecret\n'+tail).encode()));return source
 def test_budgets_reference_and_decimals_not_invented(self):
  result=selector.select(self.source(),self.root/'new',1,1);self.assertEqual(result['counts']['retained'],2);self.assertEqual(result['counts']['scanned'],3);self.assertTrue(result['gzipCrcVerified']);text=(self.root/'new/selected.tsv').read_text();self.assertIn('12.345',text);self.assertIn('0034000470693',text);self.assertNotIn('secret',text);self.assertNotIn('creator',text);self.assertNotIn('nutrition_data_per\t100g',text)
 def test_invalid_identity_not_selected(self):
  result=selector.select(self.source('invalid\tFoo\t\t\t\t\n00023456\t\t\t\t\t\n'),self.root/'new');self.assertEqual(result['counts']['invalidIdentity'],2)
 def test_corrupt_crc_never_seals_receipt(self):
  src=self.source();content=bytearray(src.read_bytes());content[-8]^=255;src.write_bytes(content)
  with self.assertRaises(OSError):selector.select(src,self.root/'new')
  self.assertFalse((self.root/'new/selection-manifest.json').exists())
 def test_existing_destination_is_preserved(self):
  dest=self.root/'new';dest.mkdir();(dest/'data').write_text('keep')
  with self.assertRaisesRegex(Exception,'workspace-exists'):selector.select(self.source(),dest)
  self.assertEqual((dest/'data').read_text(),'keep')
 def test_conflicting_codes_fail_and_no_manifest(self):
  with self.assertRaisesRegex(Exception,'conflicting-selected-barcode'):selector.select(self.source('0034000470693\tDifferent\t\ten:france\t12\t\n'),self.root/'new')
  self.assertFalse((self.root/'new/selection-manifest.json').exists())
 def test_resource_failure_and_scanned_limit_do_not_publish(self):
  src=self.source()
  with patch.object(selector,'MAX_SCANNED',1),self.assertRaisesRegex(Exception,'scanned-row-limit'):selector.select(src,self.root/'new')
  self.assertFalse((self.root/'new/selection-manifest.json').exists())
 def test_unsafe_paths_and_oversized_source_fail_before_writes(self):
  src=self.source()
  with self.assertRaisesRegex(Exception,'unsafe-destination-path'):selector.select(src,self.root/'../outside')
  with patch.object(selector,'MAX_COMPRESSED',1),self.assertRaisesRegex(Exception,'source-too-large'):selector.select(src,self.root/'new')
  self.assertFalse((self.root/'new').exists())
 def test_unknown_reference_is_an_empty_tsv_cell(self):
  selector.select(self.source(),self.root/'new');lines=(self.root/'new/selected.tsv').read_text().splitlines();index=lines[0].split('\t').index('nutrition_data_per');self.assertEqual(lines[1].split('\t')[index],'')

 def many_source(self, rows, name='many.gz'):
  source=self.root/name;header='code\tproduct_name\tbrands\tcountries_tags\tenergy-kcal_100g\tproteins_100g\tcarbohydrates_100g\tfat_100g\n'
  source.write_bytes(gzip.compress((header+''.join('\t'.join(row)+'\n' for row in rows)).encode()));return source
 def test_selection_independent_of_source_order_and_not_first_rows(self):
  rows=[(f'{i:08d}',f'Lait {i}','Marque','en:france' if i%2 else 'en:usa','46','3.2','4.8','1.5') for i in range(1,101)]
  a=selector.select(self.many_source(rows,'forward.gz'),self.root/'forward',7,3)
  b=selector.select(self.many_source(list(reversed(rows)),'backward.gz'),self.root/'backward',7,3)
  self.assertEqual(a['selectedSha256'],b['selectedSha256']);self.assertTrue(a['orderIndependent']);self.assertEqual(a['counts']['france'],7);self.assertEqual(a['counts']['international'],3)
  lines=(self.root/'forward/selected.tsv').read_text().splitlines();index=lines[0].split('\t').index('code');codes={line.split('\t')[index] for line in lines[1:]};self.assertTrue(any(int(code)>20 for code in codes));self.assertEqual(a['eligible'],{'france':50,'international':50})
 def test_complete_raw_hint_prefers_late_record_without_claiming_journal_readiness(self):
  rows=[('00012345','Incomplete','Brand','en:france','','','',''),('00012346','Complete','Brand','en:france','10.5','0','2.5','0')]
  result=selector.select(self.many_source(rows),self.root/'new',1,0)
  text=(self.root/'new/selected.tsv').read_text();self.assertIn('Complete',text);self.assertNotIn('Incomplete',text);self.assertEqual(result['rawCompleteHintRetained']['france'],1)
  index=text.splitlines()[0].split('\t').index('nutrition_data_per');self.assertEqual(text.splitlines()[1].split('\t')[index],'')
 def test_invalid_macro_or_declared_error_does_not_gain_complete_hint(self):
  rows=[('00012345','Impossible','Brand','en:france','10','-1','2','0'),('00012346','Reliable candidate','Brand','en:france','10','0','2','0')]
  result=selector.select(self.many_source(rows),self.root/'new',1,0);self.assertEqual(result['rawCompleteHintEligible']['france'],1)
 def test_duplicate_after_eviction_still_detected(self):
  rows=[(f'{i:08d}',f'Food {i}','Brand','en:france','','','','') for i in range(1,21)]
  rows.append(('00000001','Changed','Brand','en:france','','','',''))
  with self.assertRaisesRegex(Exception,'conflicting-selected-barcode'):selector.select(self.many_source(rows),self.root/'new',1,0)
  self.assertFalse((self.root/'new/selection-manifest.json').exists())
 def test_exact_duplicates_do_not_bias_sample(self):
  row=('00012345','Lait','Brand','en:france','10','0','2','0')
  result=selector.select(self.many_source([row,row]),self.root/'new',1,0);self.assertEqual(result['counts']['duplicates'],1);self.assertEqual(result['eligible']['france'],1)

 def test_staging_page_budget_fails_without_sealing(self):
  rows=[(f'{i:08d}','Lait','Brand','en:france','46','3.2','4.8','1.5') for i in range(1,501)]
  import sqlite3
  with patch.object(selector,'MAX_STAGING',3*4096),self.assertRaises(sqlite3.Error):selector.select(self.many_source(rows),self.root/'new',100,0)
  self.assertFalse((self.root/'new/selection-manifest.json').exists())
