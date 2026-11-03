import gzip
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
import urllib.error
import socket
from unittest.mock import patch
from catalog import CatalogError

spec=importlib.util.spec_from_file_location('tsv_sample',Path(__file__).with_name('tsv-sample.py'))
sample=importlib.util.module_from_spec(spec);spec.loader.exec_module(sample)

class Reply(io.BytesIO):
    status=206
    def __init__(self,data,status=206,headers=None):
        super().__init__(data);self.status=status
        self.headers=headers or {'Content-Range':f'bytes 0-{len(data)-1}/1275171186','Content-Length':str(len(data)),'ETag':'"version"'}
    def geturl(self):return 'https://openfoodfacts-ds.s3.eu-west-3.amazonaws.com/en.openfoodfacts.org.products.csv.gz'
class Opener:
    def __init__(self,reply):self.reply=reply;self.calls=0
    def open(self,request,**kwargs):
        self.calls+=1;self.request=request
        if isinstance(self.reply,Exception):raise self.reply
        return self.reply

class TsvSampleTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name);self.addCleanup(self.temp.cleanup)
    def data(self):return b'code\tproduct_name\tenergy-kcal_100g\n00012345\t"Quoted name\t300.25\n00012346\tMilk\t42\n00012347\tThird\t12\n'
    def test_bounded_official_range_complete_rows_hashes_and_no_full_gzip_claim(self):
        opener=Opener(Reply(gzip.compress(self.data())))
        report=sample.capture(self.root,2,opener)
        self.assertTrue(report['complete']);self.assertEqual(report['rows'],2);self.assertEqual(opener.calls,1)
        self.assertEqual(opener.request.get_header('Range'),f'bytes=0-{sample.MAX_COMPRESSED-1}')
        self.assertFalse(report['representative']);self.assertFalse(report['sourceGzipCrcVerified'])
        stored=(self.root/'sample.tsv').read_bytes();self.assertIn(b'00012345\t"Quoted name',stored);self.assertNotIn(b'Third',stored)
        self.assertEqual(report['sampleBytes'],len(stored));self.assertEqual(json.loads((self.root/'sample-manifest.json').read_text())['complete'],True)
    def test_range_ignored_and_invalid_content_range_fail_without_storing_body(self):
        for reply in [Reply(gzip.compress(self.data()),200),Reply(gzip.compress(self.data()),headers={'Content-Range':'bytes 10-30/100'})]:
            opener=Opener(reply)
            with self.assertRaises(CatalogError):sample.capture(self.root,2,opener)
            self.assertFalse((self.root/'sample.tsv').exists())
            (self.root/'sample-manifest.json').unlink() # only this test's failed receipt
    def test_dns_timeout_http_no_retry(self):
        for error in [urllib.error.URLError(socket.gaierror()),TimeoutError(),urllib.error.HTTPError('url',503,'down',{},None)]:
            opener=Opener(error)
            with self.assertRaises(CatalogError):sample.capture(self.root,2,opener)
            self.assertEqual(opener.calls,1);self.assertFalse((self.root/'sample.tsv').exists())
            self.assertFalse(json.loads((self.root/'sample-manifest.json').read_text())['complete']);(self.root/'sample-manifest.json').unlink()
    def test_corrupt_gzip_invalid_utf8_columns_and_insufficient_prefix(self):
        for data in [b'bad gzip',gzip.compress(b'code\tproduct_name\n1\t\xff\n'),gzip.compress(b'code\tproduct_name\n1\tName\textra\n'),gzip.compress(b'code\tproduct_name\n')]:
            with self.assertRaises(CatalogError):sample.capture(self.root,2,Opener(Reply(data)))
            self.assertFalse((self.root/'sample.tsv').exists());(self.root/'sample-manifest.json').unlink()
    def test_existing_partial_is_never_removed_by_a_failed_capture(self):
        partial=self.root/'sample.tsv.partial';partial.write_bytes(b'PREEXISTING')
        with self.assertRaises(CatalogError):sample.capture(self.root,2,Opener(Reply(gzip.compress(self.data()))))
        self.assertEqual(partial.read_bytes(),b'PREEXISTING')

    def test_disk_failure_does_not_leave_an_importable_sample(self):
        original=Path.open
        def disk_full(path,*args,**kwargs):
            if path.name=='sample.tsv.partial':raise OSError('simulated full disk')
            return original(path,*args,**kwargs)
        with patch('pathlib.Path.open',disk_full),self.assertRaises(CatalogError):sample.capture(self.root,2,Opener(Reply(gzip.compress(self.data()))))
        self.assertFalse((self.root/'sample.tsv').exists());self.assertFalse(json.loads((self.root/'sample-manifest.json').read_text())['complete'])

if __name__=='__main__':unittest.main()
