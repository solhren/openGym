import hashlib
import importlib.util
import io
import json
from pathlib import Path
import socket
import tempfile
import unittest
import urllib.error
from unittest.mock import patch

s=importlib.util.spec_from_file_location('price_parquet',Path(__file__).with_name('public-benchmark-parquet.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)

class Response(io.BytesIO):
    status=200
    def __init__(self,data,headers=None):super().__init__(data);self.headers=headers or {}

class Opener:
    def __init__(self,*values):self.values=list(values);self.requests=[]
    def open(self,request,timeout):
        self.requests.append(request.full_url);value=self.values.pop(0)
        if isinstance(value,Exception):raise value
        return value

class PublicParquetTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.patches=[patch.object(m,'BASE',self.root),patch.object(m.bench,'BASE',self.root),patch.object(m,'resources',return_value={'freeDiskBytes':35*1024**3,'availableMemoryBytes':4*1024**3}),patch.object(m.bench,'resources',return_value={})]
        for p in self.patches:p.start()
        self.data=b'PAR1'+b'fixture-footer'+(14).to_bytes(4,'little')+b'PAR1';self.sha=hashlib.sha256(self.data).hexdigest()
    def tearDown(self):
        for p in reversed(self.patches):p.stop()
        self.temp.cleanup()
    def meta(self):return {'id':m.DATASET,'sha':'a'*40,'siblings':[{'rfilename':'prices.parquet','lfs':{'size':len(self.data),'sha256':self.sha}}]}
    def capture(self,name='raw',data=None):
        opener=Opener(Response(json.dumps(self.meta()).encode()),Response(self.data if data is None else data,{'Content-Length':str(len(self.data))}))
        result=m.fetch(name,opener);return result,opener
    def rows(self):return [
        {'id':1,'product_code':'00012345','product_name':None,'location_osm_address_country_code':'FR','owner':'SECRET','proof_file_path':'SECRET'},
        {'id':2,'product_code':'00012345','product_name':None,'location_osm_address_country_code':'FR'},
        {'id':3,'product_code':'00012346','product_name':'Pâtes','location_osm_address_country_code':'FR'},
        {'id':4,'product_code':'00012347','product_name':'Milk','location_osm_address_country_code':'US'},
        {'id':5,'product_code':None,'category_tag':'en:bananas','location_osm_address_country_code':'FR'},
        {'id':6,'product_code':'00012348','product_name':'One','location_osm_address_country_code':'FR'},
        {'id':7,'product_code':'00012348','product_name':'Two','location_osm_address_country_code':'FR'}]
    def reader(self,rows):
        def read(file,report):report.update(rows=len(rows),schema=[{'name':'id','type':'int64'}]);yield from rows
        return read
    def test_pinned_download_hash_size_footer_private_files_and_no_filter(self):
        result,opener=self.capture();self.assertTrue(result['complete']);self.assertEqual(result['sha256'],self.sha)
        self.assertIn('/resolve/'+'a'*40+'/',opener.requests[1]);self.assertFalse(any('/filter' in r for r in opener.requests));self.assertEqual(len(opener.requests),2)
        self.assertEqual((self.root/'raw').stat().st_mode&0o777,0o700);self.assertEqual((self.root/'raw'/'prices.parquet').stat().st_mode&0o777,0o600)
        self.assertEqual(m.verified_capture('raw')[1]['revision'],'a'*40)
        with self.assertRaises(FileExistsError):self.capture()
    def test_checksum_short_and_oversized_response_never_publish(self):
        for i,data in enumerate([self.data[:-1],b'X'+self.data[1:],self.data+b'x']):
            with self.assertRaises(m.CatalogError):self.capture('bad'+str(i),data)
            root=self.root/('bad'+str(i));self.assertFalse((root/'prices.parquet').exists());self.assertFalse((root/'prices.parquet.part').exists());self.assertFalse(json.loads((root/'capture.json').read_text())['complete'])
    def test_dns_http_timeout_are_explicit_without_retry(self):
        errors=[(urllib.error.URLError(socket.gaierror()),'dns'),(TimeoutError(),'timeout'),(urllib.error.HTTPError(m.METADATA,500,'bad',{},None),'http-error-500')]
        for i,(error,message) in enumerate(errors):
            opener=Opener(error)
            with self.assertRaisesRegex(m.CatalogError,message):m.fetch('error'+str(i),opener)
            self.assertEqual(len(opener.requests),1);self.assertFalse(json.loads((self.root/('error'+str(i))/'capture.json').read_text())['complete'])
    def test_timeout_during_file_body_is_not_misclassified_as_disk_error(self):
        response=Response(self.data)
        response.read=lambda amount:(_ for _ in ()).throw(TimeoutError())
        opener=Opener(Response(json.dumps(self.meta()).encode()),response)
        with self.assertRaisesRegex(m.CatalogError,'parquet-timeout'):m.fetch('bodytimeout',opener)
        self.assertEqual(len(opener.requests),2)
        self.assertFalse((self.root/'bodytimeout'/'prices.parquet').exists());self.assertFalse((self.root/'bodytimeout'/'prices.parquet.part').exists())
    def test_metadata_budgets_https_redirects_and_unsafe_paths(self):
        for url in ['http://huggingface.co/x','https://evil.example/x','https://huggingface.co.evil/x','https://user@huggingface.co/x','https://huggingface.co:444/x','https://huggingface.co/datasets/other/resolve/main/x']:
            with self.assertRaises(m.CatalogError):m.safe_url(url)
        self.assertEqual(m.safe_url('https://cas-bridge.xethub.hf.co/x?signature=private'),'cas-bridge.xethub.hf.co')
        r=m.Redirect()
        for _ in range(4):r.redirect_request(__import__('urllib.request').request.Request('https://huggingface.co'),None,302,'',{},'https://cas-bridge.xethub.hf.co/x')
        with self.assertRaisesRegex(m.CatalogError,'redirect-limit'):r.redirect_request(__import__('urllib.request').request.Request('https://huggingface.co'),None,302,'',{},'https://cas-bridge.xethub.hf.co/x')
        bad=self.meta();bad['siblings'][0]['lfs']['size']=m.MAX_FILE+1
        with self.assertRaises(m.CatalogError):m.metadata(bad)
        with self.assertRaises(m.CatalogError):m.root_for('../escape',True)
    def test_footer_and_receipt_tampering_are_rejected(self):
        self.capture();(self.root/'raw'/'prices.parquet').write_bytes(b'X'+self.data[1:])
        with self.assertRaisesRegex(m.CatalogError,'corrupt'):m.verified_capture('raw')
        f=self.root/'bad';f.write_bytes(b'PAR1xxxx'+(99999999).to_bytes(4,'little')+b'PAR1')
        with self.assertRaises(m.CatalogError):m.footer(f)
    def test_process_peak_uses_linux_exec_high_water_not_inherited_parent_peak(self):
        with patch.object(Path,'read_text',return_value='VmRSS:\t 10000 kB\nVmHWM:\t 12345 kB\n'),patch.object(m.resource,'getrusage',side_effect=AssertionError('inherited metric must not be used')):
            self.assertEqual(m.peak_rss_kib(),12345)
        with patch.object(Path,'read_text',return_value='VmRSS:\t 10000 kB\n'):
            with self.assertRaisesRegex(m.CatalogError,'memory-unavailable'):m.peak_rss_kib()
    def test_streaming_fr_census_dedup_missing_names_and_privacy_reuse_existing_prepare(self):
        self.capture();result=m.project('raw','projection',100,row_reader=self.reader(self.rows()))
        self.assertTrue(result['complete']);self.assertEqual(result['counts']['sourceRows'],7);self.assertEqual(result['counts']['frenchObservations'],6)
        self.assertEqual(result['eligibleUniqueProducts'],4);self.assertEqual(result['unresolvedUniqueTitles'],3);self.assertEqual(result['conflictingUniqueTitles'],1)
        data=(self.root/'projection'/'projection.jsonl').read_text();self.assertNotIn('SECRET',data);self.assertNotIn('owner',data);self.assertIn('00012345',data)
        p=m.bench.prepare('projection','frozen',100);self.assertEqual(p['cases'],4);self.assertEqual(p['source']['source'],'openfoodfacts/open-prices');self.assertEqual(p['sourceCounts']['missingQueryLabel'],3)
        with self.assertRaisesRegex(m.CatalogError,'seed'):m.bench.prepare('projection','wrongseed',100,'another')
    def test_selection_is_row_order_independent_and_labels_not_needed_for_selection(self):
        self.capture();rows=self.rows();m.project('raw','one',100,row_reader=self.reader(rows));m.project('raw','two',100,row_reader=self.reader(list(reversed(rows))))
        self.assertEqual((self.root/'one'/'projection.jsonl').read_bytes(),(self.root/'two'/'projection.jsonl').read_bytes())
    def test_fr_filter_uses_country_code_not_country_name(self):
        self.capture();rows=[{'id':1,'product_code':'00012345','product_name':None,'location_osm_address_country_code':'fr'}, {'id':2,'product_code':'00012346','location_osm_address_country_code':'FR'}]
        result=m.project('raw','fr',100,row_reader=self.reader(rows));self.assertEqual(result['eligibleUniqueProducts'],1)
    def test_duplicate_observations_corruption_and_disk_failure_leave_incomplete(self):
        self.capture()
        for name,rows in [('duplicate',[self.rows()[0],self.rows()[0]]),('badtype',[{**self.rows()[0],'product_code':12345}])]:
            with self.assertRaises(m.CatalogError):m.project('raw',name,100,row_reader=self.reader(rows))
            self.assertFalse(json.loads((self.root/name/'sample-manifest.json').read_text())['complete']);self.assertFalse((self.root/name/'projection.jsonl').exists())
        with patch.object(m,'resources',side_effect=m.CatalogError('insufficient-free-disk')):
            with self.assertRaisesRegex(m.CatalogError,'disk'):m.fetch('disk',Opener())
    def test_truncated_scan_and_incomplete_projection_not_usable(self):
        self.capture()
        def read(file,report):report['rows']=5;yield self.rows()[0]
        with self.assertRaisesRegex(m.CatalogError,'incomplete-parquet'):m.project('raw','partial',100,row_reader=read)
        with self.assertRaisesRegex(m.CatalogError,'incomplete-source'):m.bench.prepare('partial','notfrozen',100)

if __name__=='__main__':unittest.main()
