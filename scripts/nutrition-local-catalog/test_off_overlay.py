import copy
import gzip
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
import urllib.error
from unittest.mock import patch

def module(name,file):
    s=importlib.util.spec_from_file_location(name,Path(__file__).with_name(file));m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
a=module('off_overlay_audit','off-overlay-audit.py');p=module('off_raw_probe','off-jsonl-sample.py');i=module('off_raw_inspect','off-jsonl-inspect.py')

class IdentityTests(unittest.TestCase):
    def test_gtin_and_zero_preserving_aliases(self):
        self.assertTrue(a.gtin_valid('3017620422003'));self.assertTrue(a.gtin_valid('0036000291452'))
        self.assertEqual(a.canonical('036000291452'),a.canonical('0036000291452'))
        self.assertEqual(a.canonical('036000291452'),'00036000291452')
        for v in ('00000000','3017620422004','not-a-code',3017620422003):self.assertFalse(a.gtin_valid(v))
        self.assertEqual(a.canonical('3017620422004'),'exact:3017620422004')
    def test_provider_url_identity_is_exact_not_an_arbitrary_http_source(self):
        self.assertEqual(a.source_code('https://world.openfoodfacts.org/api/v2/product/0036000291452.json'),'0036000291452')
        for v in ('https://evil.test/api/v2/product/3017620422003.json','https://user:secret@world.openfoodfacts.org/api/v2/product/3017620422003.json','https://openfoodfacts.org.evil.test/api/v2/product/3017620422003.json','javascript:alert(1)'):
            self.assertIsNone(a.source_code(v))

def product(per='100g'):
    return {'code':'3017620422003','product_name':'Synthetic fixture','nutrition':{'aggregated_set':{'per':per,'preparation':'as_sold','nutrients':{k:{'value':v,'source':'packaging','unit':'kcal' if k=='energy-kcal' else 'g'} for k,v in [('energy-kcal',100),('proteins',3),('carbohydrates',10),('fat',4)]}}}}

class InspectionTests(unittest.TestCase):
    def test_g_and_ml_are_distinct_no_density_guesses(self):
        result=i.summarize([product(),product('100ml')]);self.assertEqual(result['counts']['explicitAsSold_100g'],1);self.assertEqual(result['counts']['explicitAsSold_100ml'],1);self.assertIsNone(result['finalValidatedFoods'])
    def test_legacy_100g_and_package_units_are_not_explicit_reference(self):
        row={'code':'3017620422003','nutrition_data_per':'100g','product_quantity_unit':'g','nutriments':{'fat_100g':4}}
        counts=i.summarize([row])['counts'];self.assertEqual(counts['aggregateMissing'],1);self.assertNotIn('candidateForEngineValidation',counts)
    def test_prepared_estimated_qualified_and_computed_values_are_not_candidates(self):
        rows=[]
        for patch in ['prepared','estimate','modifier','computed','unit','negative','quality']:
            row=product();v=row['nutrition']['aggregated_set'];n=v['nutrients']['energy-kcal']
            if patch=='prepared':v['preparation']='prepared'
            elif patch=='estimate':n['source']='estimate'
            elif patch=='modifier':n['modifier']='~'
            elif patch=='computed':n['value_computed']=n.pop('value')
            elif patch=='unit':n['unit']='g'
            elif patch=='negative':n['value']=-1
            else:row['data_quality_errors_tags']=['en:nutrition-value-error']
            rows.append(row)
        self.assertNotIn('candidateForEngineValidation',i.summarize(rows)['counts'])
    def test_input_sets_are_identified_without_synthetic_aggregation(self):
        row={'code':'3017620422003','nutrition':{'input_sets':[{'per':'100ml','preparation':'as_sold','source':'manufacturer'}]}}
        c=i.summarize([row])['counts'];self.assertEqual(c['explicitAsSoldInputSet'],1);self.assertNotIn('candidateForEngineValidation',c)

class Response(io.BytesIO):
    status=206
    headers={'Content-Range':'bytes 0-999/13132516914','ETag':'"fixture"'}

class CaptureTests(unittest.TestCase):
    def setUp(self):self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.guard=patch.object(p,'resources',return_value={});self.guard.start()
    def tearDown(self):self.guard.stop();self.tmp.cleanup()
    def opener(self,data):return type('Opener',(),{'open':lambda _,req,timeout:data})()
    def test_bounded_prefix_and_checksums(self):
        raw=(json.dumps(product())+'\n'+json.dumps(product('100ml'))+'\n').encode();r=p.capture(self.root,1,self.opener(Response(gzip.compress(raw))))
        self.assertTrue(r['complete']);self.assertFalse(r['representative']);self.assertEqual(r['rows'],1);self.assertEqual(len((self.root/'rows.jsonl').read_text().splitlines()),1)
    def test_ignored_range_is_rejected_before_reading_body(self):
        response=Response(b'never read');response.status=200
        with self.assertRaisesRegex(Exception,'range-required'):p.capture(self.root,1,self.opener(response))
        self.assertFalse((self.root/'rows.jsonl').exists());self.assertFalse(json.loads((self.root/'capture.json').read_text())['complete'])
    def test_dns_and_timeout_are_single_attempt_failures(self):
        for error in [urllib.error.URLError('Name or service not known'),TimeoutError()]:
            with tempfile.TemporaryDirectory() as tmp:
                calls=[]
                def failure(*args,**kwargs):calls.append(1);raise error
                with self.assertRaises(Exception):p.capture(Path(tmp),1,type('Opener',(),{'open':failure})())
                self.assertEqual(len(calls),1);self.assertFalse(json.loads((Path(tmp)/'capture.json').read_text())['complete'])
    def test_http_429_and_503_are_not_retried(self):
        for status in (429,503):
            with tempfile.TemporaryDirectory() as tmp:
                def failure(*args,**kwargs):raise urllib.error.HTTPError(p.EXPORTS['jsonl'],status,'fixture',{},None)
                with self.assertRaisesRegex(Exception,str(status)):p.capture(Path(tmp),1,type('Opener',(),{'open':failure})())
    def test_bad_gzip_and_resource_limits_do_not_publish_complete_rows(self):
        with self.assertRaises(Exception):p.capture(self.root,1,self.opener(Response(b'bad gzip')))
        self.assertFalse((self.root/'rows.jsonl').exists())
    def test_expansion_and_line_limits(self):
        with patch.object(p,'MAX_EXPANDED',10),self.assertRaisesRegex(Exception,'expanded-limit'):
            p.capture(self.root,1,self.opener(Response(gzip.compress((json.dumps(product())+'\n').encode()))))
