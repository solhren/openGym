import io
import unittest
import urllib.error
import socket
from email.message import Message
from preflight import estimate,probe,RESERVE

class PreflightTest(unittest.TestCase):
    def test_disk_reserve_and_three_generations(self):
        report=estimate(50<<30,5<<30,5_000_000,2000,2<<30)
        self.assertEqual(report['requiredAdditionalBytesConservative'],(7<<30)+30_000_000_000)
        self.assertFalse(report['arithmeticFits']);self.assertFalse(report['fullImportAuthorized'])
        self.assertTrue(estimate(RESERVE+100,0,1,10,0)['arithmeticFits'])
    def test_unknown_and_negative_inputs_refused(self):
        for value in [None,-1,True,'3']:
            with self.assertRaises(ValueError):estimate(40<<30,0,10,value,0)
    def test_head_only_fixed_host_without_retry(self):
        class Reply(io.BytesIO):
            status=200
            headers=Message()
        Reply.headers['Content-Length']='123';Reply.headers['Accept-Ranges']='bytes'
        class Opener:
            calls=0
            def open(self,request,**options):
                self.calls+=1;self.request=request
                return Reply()
        opener=Opener();report=probe('jsonl',opener)
        self.assertEqual(opener.request.get_method(),'HEAD');self.assertEqual(opener.calls,1)
        self.assertEqual(report['compressedBytes'],123);self.assertEqual(report['acceptRanges'],'bytes')
    def test_html_challenge_is_not_a_dump_size(self):
        class Reply(io.BytesIO):
            status=200
            headers={'Content-Type':'text/html','Content-Length':'1234'}
        class Opener:
            def open(self,*args,**kwargs):return Reply()
        report=probe('jsonl',Opener());self.assertEqual(report['error'],'export-head-not-archive');self.assertIsNone(report['compressedBytes'])
    def test_network_and_http_failure_once(self):
        for error in [urllib.error.URLError(socket.gaierror()),TimeoutError(),urllib.error.HTTPError('url',503,'down',{},None)]:
            class Opener:
                calls=0
                def open(self,*a,**kw):self.calls+=1;raise error
            opener=Opener();self.assertIn('error',probe('jsonl',opener));self.assertEqual(opener.calls,1)


class RedirectTest(unittest.TestCase):
    def test_https_off_bucket_redirect_preserves_head_and_strips_credentials(self):
        import urllib.request
        from export_http import SafeExportRedirect,EXPORTS
        handler=SafeExportRedirect('tsv')
        req=urllib.request.Request(EXPORTS['tsv'],method='HEAD',headers={'User-Agent':'openGym','Authorization':'secret','Cookie':'secret','Accept-Encoding':'identity'})
        req.timeout=15
        target='https://openfoodfacts-ds.s3.eu-west-3.amazonaws.com/en.openfoodfacts.org.products.csv.gz'
        redirected=handler.redirect_request(req,None,302,'found',{},target)
        self.assertEqual(redirected.get_method(),'HEAD');self.assertEqual(redirected.full_url,target)
        self.assertIsNone(redirected.get_header('Authorization'));self.assertIsNone(redirected.get_header('Cookie'))
        self.assertEqual(redirected.get_header('User-agent'),'openGym');self.assertEqual(len(handler.chain),1)
    def test_http_other_bucket_host_object_port_credentials_and_query_refused(self):
        from export_http import validate_export_url
        from catalog import CatalogError
        good='https://openfoodfacts-ds.s3.eu-west-3.amazonaws.com/en.openfoodfacts.org.products.csv.gz'
        for target in [good.replace('https:','http:'),good.replace('openfoodfacts-ds','attacker'),good.replace('amazonaws.com','amazonaws.com.evil.test'),good.replace('en.openfoodfacts.org.products.csv.gz','openfoodfacts-products.jsonl.gz'),good.replace('.com/','.com:444/'),good.replace('https://','https://secret@'),good+'?token=secret',good+'#fragment',good.replace('/en.','/%2e%2e/en.')]:
            with self.subTest(target=target),self.assertRaises(CatalogError):validate_export_url(target,'tsv')
    def test_loop_and_expired_deadline_fail_without_followup(self):
        import urllib.request,time
        from export_http import SafeExportRedirect,EXPORTS
        from catalog import CatalogError
        req=urllib.request.Request(EXPORTS['tsv'],method='HEAD')
        with self.assertRaises(CatalogError):SafeExportRedirect('tsv').redirect_request(req,None,302,'',{},EXPORTS['tsv'])
        target='https://openfoodfacts-ds.s3.eu-west-3.amazonaws.com/en.openfoodfacts.org.products.csv.gz'
        with self.assertRaisesRegex(CatalogError,'deadline'):SafeExportRedirect('tsv',time.monotonic()-1).redirect_request(req,None,302,'',{},target)
    def test_verified_default_tls_context(self):
        import ssl,urllib.request
        from export_http import export_opener
        opener,_=export_opener('tsv')
        context=next(h._context for h in opener.handlers if isinstance(h,urllib.request.HTTPSHandler))
        self.assertEqual(context.verify_mode,ssl.CERT_REQUIRED);self.assertTrue(context.check_hostname)

if __name__=='__main__':unittest.main()
