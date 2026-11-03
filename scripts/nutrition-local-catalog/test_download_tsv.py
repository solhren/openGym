import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('download_tsv',Path(__file__).with_name('download-tsv.py'));module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
URL='https://openfoodfacts-ds.s3.eu-west-3.amazonaws.com/en.openfoodfacts.org.products.csv.gz'
class Response(io.BytesIO):
 def __init__(self,data,status=200,headers=None):super().__init__(data);self.status=status;self.headers=headers or {'ETag':'"test"','Content-Length':str(len(data))}
 def geturl(self):return URL
class DownloadTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name);self.patches=[patch.object(module,'BASE',self.root),patch.object(module,'resources',lambda _:{}),patch.object(module,'ADDITIONAL_BUDGET',0),patch('shutil.disk_usage',return_value=type('Disk',(),{'free':40*1024**3})())]
  for p in self.patches:p.start()
  self.head={'status':200,'compressedBytes':6,'etag':'"test"','finalUrl':URL,'s3VersionId':None}
 def tearDown(self):
  for p in reversed(self.patches):p.stop()
  self.temp.cleanup()
 def run_download(self,response,head=None):
  opener=type('Opener',(),{'open':lambda _,request,timeout:response})()
  with patch.object(module,'probe',return_value=head or self.head),patch.object(module,'export_opener',return_value=(opener,None)):
   return module.download(self.root/'new',True,True)
 def test_complete_exact_download_hash_and_no_import(self):
  r=self.run_download(Response(b'abcdef'));self.assertTrue(r['complete']);self.assertFalse(r['gzipCrcVerified']);self.assertEqual(r['downloadSha256'],hashlib.sha256(b'abcdef').hexdigest());self.assertEqual((self.root/'new/source.tsv.gz').read_bytes(),b'abcdef');self.assertFalse((self.root/'new/current.json').exists())
 def test_truncated_response_keeps_partial_without_success_manifest(self):
  with self.assertRaisesRegex(Exception,'truncated-download'):self.run_download(Response(b'abc',headers={'ETag':'"test"','Content-Length':'6'}))
  self.assertEqual((self.root/'new/source.tsv.gz.partial').read_bytes(),b'abc');self.assertFalse((self.root/'new/download-manifest.json').exists())
 def test_resume_strict_range_and_source_identity(self):
  with self.assertRaises(Exception):self.run_download(Response(b'abc',headers={'ETag':'"test"','Content-Length':'6'}))
  r=self.run_download(Response(b'def',206,{'ETag':'"test"','Content-Length':'3','Content-Range':'bytes 3-5/6'}));self.assertEqual(r['downloadSha256'],hashlib.sha256(b'abcdef').hexdigest())
 def test_ignored_range_does_not_append_duplicate_source(self):
  with self.assertRaises(Exception):self.run_download(Response(b'abc',headers={'ETag':'"test"','Content-Length':'6'}))
  with self.assertRaisesRegex(Exception,'object-changed'):self.run_download(Response(b'abcdef'))
  self.assertEqual((self.root/'new/source.tsv.gz.partial').read_bytes(),b'abc')
 def test_changed_object_refuses_resume(self):
  with self.assertRaises(Exception):self.run_download(Response(b'abc',headers={'ETag':'"test"','Content-Length':'6'}))
  with self.assertRaisesRegex(Exception,'source-changed'):self.run_download(Response(b'abcdef'),{**self.head,'etag':'"new"'})
 def test_oversized_or_failed_head_does_not_download(self):
  for head in [{**self.head,'compressedBytes':module.MAX_SOURCE+1},{'status':503}]:
   with self.assertRaisesRegex(Exception,'missing-or-oversized'):self.run_download(Response(b'abcdef'),head)
 def test_requires_acknowledgement_and_budget(self):
  with patch.object(module,'probe',return_value=self.head):
   with self.assertRaisesRegex(Exception,'not-acknowledged'):module.download(self.root/'new',True,False)
   with patch('shutil.disk_usage',return_value=type('Disk',(),{'free':1})()),self.assertRaisesRegex(Exception,'insufficient-targeted'):module.download(self.root/'new',True,True)
 def test_existing_final_never_overwritten(self):
  self.run_download(Response(b'abcdef'))
  with self.assertRaisesRegex(Exception,'already-complete'):self.run_download(Response(b'abcdef'))

 def test_dns_diagnostic_is_preserved_without_retry(self):
  with patch.object(module,'probe',return_value={'error':'export-dns-error'}) as probe,self.assertRaisesRegex(Exception,'export-dns-error'):module.download(self.root/'new',True,True)
  self.assertEqual(probe.call_count,1)
 def test_concurrent_downloader_refused_by_kernel_lock(self):
  root=self.root/'new';root.mkdir()
  with module.writer_lock(root),self.assertRaisesRegex(Exception,'writer-busy'):module.download(root,True,True)

 def test_resume_does_not_double_reserve_existing_partial_bytes(self):
  with self.assertRaises(Exception):self.run_download(Response(b'abc',headers={'ETag':'"test"','Content-Length':'6'}))
  with patch.object(module,'ADDITIONAL_BUDGET',8),patch('shutil.disk_usage',return_value=type('Disk',(),{'free':20*1024**3+5})()):
   result=self.run_download(Response(b'def',206,{'ETag':'"test"','Content-Length':'3','Content-Range':'bytes 3-5/6'}))
  self.assertEqual(result['remainingAdditionalBudgetBytes'],5)
 def test_resume_after_receipt_before_partial_creation(self):
  root=self.root/'new';root.mkdir()
  state={'format':'opengym-off-tsv-download','version':1,'source':module.EXPORTS['tsv'],'finalUrl':URL,'etag':'"test"','s3VersionId':None,'bytes':6}
  (root/'download-state.json').write_text(json.dumps(state))
  result=self.run_download(Response(b'abcdef'));self.assertTrue(result['complete'])
