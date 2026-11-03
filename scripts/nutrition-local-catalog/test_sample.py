import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
import urllib.error
import socket
import errno
import subprocess
import sys
import http.client
from email.message import Message
from unittest.mock import patch
from catalog import CatalogError
from sample import acquire, capture, plan, NoRedirect, save

def envelope(index=0, total=1000):
    return {'features': [{'name': 'code', 'type': {'dtype':'string'}}], 'rows': [{'row_idx':index, 'row':{'code':'00012345'}, 'truncated_cells':[]}], 'num_rows_total':total, 'partial':False}
class Response(io.BytesIO):
    status = 200
    def __init__(self, data):
        super().__init__(data)
        self.headers = Message(); self.headers['Content-Type'] = 'application/json'
class Opener:
    def __init__(self, values):
        self.values = iter(values); self.calls = 0; self.requests = []
    def open(self, request, **_):
        self.calls += 1; self.requests.append(request)
        value = next(self.values)
        if isinstance(value, Exception): raise value
        return Response(value)

class SampleTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)
    def test_bounded_offsets_and_documented_filter(self):
        requests = plan(10000, 20, 100, 'fr')
        self.assertEqual(len(requests),20); self.assertEqual(requests[-1]['offset'],9900)
        self.assertIn('filter?',requests[0]['url']); self.assertIn('where=',requests[0]['url'])
        for options in [(0,1,10), (10000,21,100), (10000,1,101), (10,2,10)]:
            with self.assertRaises(CatalogError): plan(*options)
    def test_success_captures_hashes_parameters_and_no_retries(self):
        data = json.dumps(envelope()).encode(); opener=Opener([data])
        result=capture(self.root,plan(1000,1,100),opener)
        self.assertTrue(result['complete']); self.assertEqual(result['pages'][0]['sha256'],hashlib.sha256(data).hexdigest())
        self.assertEqual((self.root/'page-000.json').read_bytes(),data)
        self.assertEqual(opener.calls,1)
        self.assertIn('openGym',opener.requests[0].get_header('User-agent'))
    def test_429_503_dns_and_timeout_have_distinct_error_and_aborted_manifest(self):
        for status in [429,503]:
            with tempfile.TemporaryDirectory() as folder:
                headers=Message(); headers['Retry-After']='60'
                opener=Opener([urllib.error.HTTPError('url',status,'unavailable',headers,None)])
                with self.assertRaisesRegex(CatalogError,'rate-limited' if status==429 else 'provider-unavailable'):
                    capture(Path(folder),plan(1000,1),opener)
                self.assertEqual(opener.calls,1)
                self.assertFalse(json.loads((Path(folder)/'sample-manifest.json').read_text())['complete'])
        with self.assertRaisesRegex(CatalogError,'dns-error'):
            acquire(plan(1000,1)[0]['url'],Opener([urllib.error.URLError(socket.gaierror(-3,'DNS'))]),10000,1)
    def test_oversized_redirect_arbitrary_host_and_deadline_refused(self):
        self.assertIsNone(NoRedirect().redirect_request(None, None, 302, 'redirect', {}, 'https://evil.example'))
        with patch('sample.MAX_PAGE', 10):
            with self.assertRaisesRegex(CatalogError,'page-too-large'):
                acquire(plan(1000,1)[0]['url'],Opener([b'x'*11]),10000,1)
        for url in ['https://evil.example/rows','http://datasets-server.huggingface.co/rows','https://datasets-server.huggingface.co/rows#x']:
            with self.assertRaisesRegex(CatalogError,'unsafe-sample-url'): acquire(url,Opener([]),1000,1)
        with self.assertRaisesRegex(CatalogError,'deadline'):
            capture(self.root,plan(1000,1),Opener([]),time_budget=0)

    def test_timeout_and_population_change_stop_without_second_request(self):
        with self.assertRaisesRegex(CatalogError,'sample-timeout'):
            acquire(plan(1000,1)[0]['url'],Opener([TimeoutError()]),10000,1)
        opener=Opener([json.dumps(envelope(total=1001)).encode()])
        with self.assertRaisesRegex(CatalogError,'population-changed'):
            capture(self.root,plan(1000,2),opener)
        self.assertEqual(opener.calls,1)
    def test_partial_truncated_schema_changed_and_duplicate_indices_abort(self):
        bad=envelope(); bad['rows'][0]['truncated_cells']=['nutriments']
        for responses in [[bad],[envelope(),envelope()],[envelope(),envelope(1,1001)]]:
            with tempfile.TemporaryDirectory() as folder:
                requests=plan(1000,len(responses))
                with self.assertRaises(CatalogError): capture(Path(folder),requests,Opener([json.dumps(x).encode() for x in responses]))
                self.assertFalse(json.loads((Path(folder)/'sample-manifest.json').read_text())['complete'])
    def test_exclusive_capture_does_not_overwrite_previous_bytes(self):
        (self.root/'page-000.json').write_bytes(b'precious capture')
        with self.assertRaises(FileExistsError): capture(self.root,plan(1000,1),Opener([json.dumps(envelope()).encode()]))
        self.assertEqual((self.root/'page-000.json').read_bytes(),b'precious capture')

    def test_nonfinite_duplicate_and_poison_json_cannot_be_a_complete_capture(self):
        for body in [b'{"x":NaN}',b'{"x":1,"x":2}',b'{"__proto__":{}}']:
            with tempfile.TemporaryDirectory() as folder:
                with self.assertRaises(CatalogError): capture(Path(folder),plan(1000,1),Opener([body]))
                self.assertFalse(json.loads((Path(folder)/'sample-manifest.json').read_text())['complete'])

    def test_cli_error_uses_sys_stderr_and_never_a_name_error(self):
        result=subprocess.run([sys.executable,str(Path(__file__).with_name('sample.py')),'--total','1','--pages','20'],capture_output=True,text=True)
        self.assertEqual(result.returncode,1)
        self.assertEqual(json.loads(result.stderr)['error'],'overlapping-sampling-plan')
        self.assertEqual(result.stdout,'')

    def test_network_categories_and_http_status_are_precise(self):
        for error,code in [(PermissionError(errno.EPERM,'blocked'),'network-permission-denied'),(ConnectionRefusedError(errno.ECONNREFUSED,'refused'),'connection-error'),(http.client.IncompleteRead(b'part'),'truncated-response')]:
            opener=Opener([urllib.error.URLError(error)])
            with self.assertRaisesRegex(CatalogError,code): acquire(plan(1000,1)[0]['url'],opener,10000,1)
            self.assertEqual(opener.calls,1)
        with self.assertRaisesRegex(CatalogError,'http-error-404'):
            acquire(plan(1000,1)[0]['url'],Opener([urllib.error.HTTPError('url',404,'missing',Message(),None)]),10000,1)

    def test_truncated_content_length_refused(self):
        class Short(Opener):
            def open(self,*args,**kwargs):
                response=Response(b'{}');response.headers['Content-Length']='20';return response
        with self.assertRaisesRegex(CatalogError,'truncated-response'): acquire(plan(1000,1)[0]['url'],Short([]),10000,1)

    def test_partial_disk_write_cannot_publish_capture_and_cleans_owned_temporary(self):
        with patch('sample.os.fsync',side_effect=OSError(errno.ENOSPC,'disk full')):
            with self.assertRaises(OSError): save(self.root,'page-000.json',b'partial data')
        self.assertFalse((self.root/'page-000.json').exists())
        self.assertEqual(list(self.root.glob('.sample-*.tmp')),[])
        (self.root/'page-000.json').write_bytes(b'previous')
        with self.assertRaises(FileExistsError): save(self.root,'page-000.json',b'replacement')
        self.assertEqual((self.root/'page-000.json').read_bytes(),b'previous')

    def test_short_write_without_exception_is_detected_before_publication(self):
        original=Path.open
        class Short:
            def __init__(self,file):self.file=file
            def __enter__(self):return self
            def __exit__(self,*_):self.file.close()
            def write(self,data):return self.file.write(data[:len(data)//2])
        def opening(path,*args,**kwargs):
            file=original(path,*args,**kwargs)
            return Short(file) if args and args[0]=='xb' else file
        with patch.object(Path,'open',new=opening):
            with self.assertRaisesRegex(CatalogError,'incomplete-write'):save(self.root,'page-000.json',b'longer data')
        self.assertFalse((self.root/'page-000.json').exists());self.assertEqual(list(self.root.glob('.sample-*.tmp')),[])

if __name__=='__main__': unittest.main()
