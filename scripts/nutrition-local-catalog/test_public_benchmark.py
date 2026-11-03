import copy
import csv
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

def module(name,file):
    s=importlib.util.spec_from_file_location(name,Path(__file__).with_name(file));m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
m=module('public_benchmark','public-benchmark.py');sampler=module('public_sampler','public-benchmark-sample.py')

class PublicBenchmarkTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.base=patch.object(m,'BASE',self.root);self.base.start();self.budget=patch.object(m,'resources',return_value={});self.budget.start()
    def tearDown(self):self.budget.stop();self.base.stop();self.temp.cleanup()
    def source(self,name='source'):
        p=self.root/name;p.mkdir();rows=[['00012345','Pâtes complètes','Marque','en:france'],['00012346','Lait','Autre','en:france'],['00012347','Lait','Troisième','en:france'],['00012345','Different observation','Marque','en:france'],['00012348','Milk','Elsewhere','en:united-states'],['00012349','','Unknown','en:france']]
        with (p/'sample.tsv').open('w',newline='') as f:
            w=csv.writer(f,delimiter='\t');w.writerow(['code','product_name','brands','countries_tags']);w.writerows(rows)
        b=(p/'sample.tsv').read_bytes();(p/'sample-manifest.json').write_text(json.dumps({'complete':True,'format':'opengym-off-tsv-sample','source':'https://static.openfoodfacts.org/data/en.openfoodfacts.org.products.csv.gz','sampleBytes':len(b),'sampleSha256':hashlib.sha256(b).hexdigest(),'rows':len(rows),'fixture':True}))
        return p
    def test_seeded_public_selection_retains_missing_labels_and_failures_without_catalogue_access(self):
        self.source();report=m.prepare('source','frozen',100,'public-seed');self.assertEqual(report['cases'],4);self.assertFalse(report['selectedUsingCatalogueResults']);self.assertFalse(report['sourceIsQueryLog']);self.assertTrue(report['source']['fixture'])
        cases=[json.loads(s) for s in (self.root/'frozen'/'cases.jsonl').read_text().splitlines()]
        self.assertEqual(sum(not c['query'] for c in cases),1);self.assertEqual(report['sourceCounts']['duplicateProductObservations'],1)
        same=[c for c in cases if c['query']=='Lait'];self.assertEqual(len(same),2);self.assertEqual(same[0]['split'],same[1]['split'])
        second=m.prepare('source','same',100,'public-seed');self.assertEqual(second['casesSha256'],report['casesSha256'])
        with self.assertRaises(Exception):m.prepare('source','frozen',100)
    def test_tampering_and_incomplete_captures_never_create_a_benchmark(self):
        p=self.source();(p/'sample.tsv').write_text('tampered')
        with self.assertRaisesRegex(Exception,'corrupt'):m.prepare('source','out',100)
        self.assertFalse((self.root/'out').exists())
    def test_row_strata_are_reproducible_nonoverlapping_and_not_only_first_rows(self):
        offsets=sampler.offsets(1000000,20,100,'seed')
        self.assertEqual(offsets,sampler.offsets(1000000,20,100,'seed'));self.assertTrue(all(i*50000<=v<=(i+1)*50000-100 for i,v in enumerate(offsets)))
        self.assertGreater(offsets[-1],950000);self.assertNotEqual(offsets[0],0)
        for args in [(20,20,100,'seed'),(10000,21,100,'seed'),(10000,1,101,'seed')]:
            with self.assertRaises(Exception):sampler.offsets(*args)
    def test_sampler_uses_documented_country_language_filters_without_search_terms(self):
        from urllib.parse import urlsplit,parse_qs
        a=parse_qs(urlsplit(sampler.url('prices-fr',10,100)).query);b=parse_qs(urlsplit(sampler.url('off-fr',20,100)).query)
        self.assertEqual(a['dataset'],['openfoodfacts/open-prices']);self.assertEqual(a['where'],['"location_osm_address_country_code"=\'FR\'']);self.assertEqual(b['where'],['"lang"=\'fr\''])
        self.assertNotIn('search',a);self.assertNotIn('nutella',sampler.url('off-fr',20,100))
    def test_truncated_duplicate_and_unsafe_json_are_rejected(self):
        data={'partial':False,'features':[],'rows':[{'row_idx':1,'truncated_cells':[],'row':{}}],'num_rows_total':10}
        self.assertEqual(sampler.envelope(json.dumps(data).encode())['num_rows_total'],10)
        bad=copy.deepcopy(data);bad['rows'][0]['truncated_cells']=['product_name']
        for raw in [json.dumps(bad).encode(),b'{"__proto__":{}}',b'{bad',b'{"partial":false,"partial":true}']:
            with self.assertRaises(Exception):sampler.envelope(raw)
        irrelevant=copy.deepcopy(data);irrelevant['rows'][0]['truncated_cells']=['images']
        self.assertEqual(sampler.envelope(json.dumps(irrelevant).encode())['rows'][0]['truncated_cells'],['images'])
    def test_failed_acquisition_keeps_incomplete_receipt_and_never_retries(self):
        with patch.object(sampler,'BASE',self.root),patch.object(sampler,'resources',return_value={}),patch.object(sampler,'acquire',side_effect=sampler.CatalogError('sample-dns-error')) as acquire:
            with self.assertRaisesRegex(Exception,'dns'):sampler.capture('prices-fr','capture',1,1)
        self.assertEqual(acquire.call_count,1);receipt=json.loads((self.root/'capture'/'sample-manifest.json').read_text());self.assertFalse(receipt['complete']);self.assertEqual(receipt['error'],'sample-dns-error')

if __name__=='__main__':unittest.main()
