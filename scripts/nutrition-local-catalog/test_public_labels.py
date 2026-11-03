import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import urlsplit,parse_qs
s=importlib.util.spec_from_file_location('labels',Path(__file__).with_name('public-benchmark-labels.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)

class PublicLabelsTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
        self.base=patch.object(m.bench,'BASE',self.root);self.base.start();self.outer=patch.object(m,'BASE',self.root);self.outer.start();self.guard=patch.object(m,'resources',return_value={});self.guard.start()
    def tearDown(self):self.guard.stop();self.outer.stop();self.base.stop();self.tmp.cleanup()
    def request(self):return m.batches([{'expectedCode':'00012345'},{'expectedCode':'00012346'}])
    def raw(self,code='00012345'):
        return json.dumps({'partial':False,'features':[],'num_rows_total':1,'rows':[{'row_idx':4,'truncated_cells':[],'row':{'code':code,'product_name':[{'lang':'fr','text':'Riz'}],'lang':'fr','countries_tags':['en:france']}}]}).encode()
    def test_at_most_twenty_batch_filters_not_per_product_requests(self):
        cases=[{'expectedCode':f'{i:013d}'} for i in range(1,1001)];requests=m.batches(cases)
        self.assertEqual(len(requests),20);self.assertTrue(all(len(v['codes'])==50 for v in requests))
        parsed=parse_qs(urlsplit(requests[0]['url']).query);self.assertEqual(parsed['dataset'],['openfoodfacts/product-database']);self.assertEqual(parsed['split'],['food']);self.assertEqual(parsed['length'],['100']);self.assertEqual(parsed['where'][0].count(' OR '),49)
        self.assertTrue(all(len(v['url'])<=8192 for v in requests));self.assertNotIn('/api/v3/',requests[0]['url'])
    def test_invalid_ids_and_budgets_never_reach_url_construction(self):
        for cases in [[{'expectedCode':"123' OR 1=1"}],[{'expectedCode':[]}],[{}],[{'expectedCode':None}],[{'expectedCode':f'{i:013d}'} for i in range(1,1002)]]:
            with self.assertRaises(m.CatalogError):m.batches(cases)
    def test_missing_products_are_preserved_in_complete_label_receipt(self):
        with patch.object(m,'load',return_value=(self.request(),'a'*64)),patch.object(m,'acquire',return_value=(self.raw(),{})) as acquire:
            receipt=m.capture('frozen','labels',True)
        self.assertTrue(receipt['complete']);self.assertEqual(receipt['rows'],1);self.assertEqual(receipt['pages'][0]['missingCodes'],['00012346']);self.assertEqual(acquire.call_count,1)
        rows,info=m.bench.source_rows('labels');self.assertEqual(next(iter(rows))['name'],'Riz');self.assertEqual(info['source'],'openfoodfacts/product-database')
    def test_empty_batch_is_a_valid_missing_label_result_not_a_retry(self):
        raw=json.dumps({'partial':False,'features':[],'num_rows_total':0,'rows':[]}).encode()
        with patch.object(m,'load',return_value=(self.request(),'a'*64)),patch.object(m,'acquire',return_value=(raw,{})) as acquire:
            r=m.capture('frozen','empty',True)
        self.assertTrue(r['complete']);self.assertEqual(r['rows'],0);self.assertEqual(len(r['pages'][0]['missingCodes']),2);self.assertEqual(acquire.call_count,1)
    def test_independent_filter_batches_can_reuse_result_row_indexes(self):
        requests=[{'url':self.request()[0]['url'],'codes':['00012345']},{'url':self.request()[0]['url'],'codes':['00012346']}]
        with patch.object(m,'load',return_value=(requests,'a'*64)),patch.object(m,'acquire',side_effect=[(self.raw('00012345'),{}),(self.raw('00012346'),{})]):
            receipt=m.capture('frozen','separate',True)
        self.assertEqual(receipt['rows'],2)
        rows,_=m.bench.source_rows('separate');self.assertEqual([r['code'] for r in rows],['00012345','00012346'])
    def test_foreign_returned_code_and_http_error_leave_incomplete_receipts(self):
        with patch.object(m,'load',return_value=(self.request(),'a'*64)),patch.object(m,'acquire',return_value=(self.raw('00012347'),{})):
            with self.assertRaisesRegex(m.CatalogError,'unexpected'):m.capture('frozen','wrong',True)
        self.assertFalse(json.loads((self.root/'wrong'/'sample-manifest.json').read_text())['complete'])
        with patch.object(m,'load',return_value=(self.request(),'a'*64)),patch.object(m,'acquire',side_effect=m.CatalogError('sample-provider-rate-limited')) as acquire:
            with self.assertRaises(m.CatalogError):m.capture('frozen','limited',True)
        self.assertEqual(acquire.call_count,1)

if __name__=='__main__':unittest.main()
