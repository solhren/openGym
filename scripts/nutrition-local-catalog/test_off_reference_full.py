"""Offline full-pass attestation/build/audit proof using actual Node normalization."""
import gzip,hashlib,importlib.util,io,json,sqlite3,tempfile,unittest
from pathlib import Path
from unittest.mock import patch

def load(name,file):
 s=importlib.util.spec_from_file_location(name,Path(__file__).with_name(file));m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m

stream=load('full_stream','off-reference-stream.py')
m=load('full_overlay','off-reference-overlay.py')
audit=load('full_report','off-reference-full-report.py')

class FullReferenceTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
  budget={'freeDiskBytes':35*1024**3,'availableMemoryBytes':4*1024**3}
  self.patches=[patch.object(m,'BASE',self.root),patch.object(stream.m,'BASE',self.root),patch.object(audit.m,'BASE',self.root),patch.object(m,'resources',return_value=budget),patch.object(stream,'resources',return_value=budget),patch.object(audit,'resources',return_value=budget)]
  for p in self.patches:p.start()
  self.codes=['3017620422003','5449000000996','3250392190484','3760295170051']
  root=self.root/'targets';root.mkdir();db=sqlite3.connect(root/'targets.sqlite');db.execute('CREATE TABLE targets(key TEXT PRIMARY KEY,flags INTEGER)')
  db.executemany('INSERT INTO targets VALUES(?,3)',[(m.ids.canonical(c),)for c in self.codes]);db.commit();db.close()
  self.targets_sha=m.digest_file(root/'targets.sqlite');(root/'receipt.json').write_text(json.dumps({'format':'opengym-off-reference-targets','complete':True,'sha256':self.targets_sha}))
 def tearDown(self):
  for p in reversed(self.patches):p.stop()
  self.tmp.cleanup()
 def fixture(self,code,unit):
  return {'code':code,'product_name':'Fixture '+unit,'brands':'Fixture','schema_version':1004,'nutrition':{'input_sets':[{'source':'packaging','preparation':'as_sold','per':'100'+unit,'per_unit':unit,'per_quantity':100,'nutrients':{k:{'value':v,'unit':u}for k,v,u in [('energy-kcal',40,'kcal'),('proteins',0,'g'),('carbohydrates',10,'g'),('fat',0,'g')]}}]}}
 def build(self):
  products=[self.fixture(self.codes[0],'g'),self.fixture(self.codes[1],'ml'),self.fixture(self.codes[2],'g'),{'code':self.codes[3],'product_name':'Missing nutrition'}]
  conflicting=json.loads(json.dumps(products[2]['nutrition']['input_sets'][0]));conflicting['nutrients']['carbohydrates']['value']=9
  products[2]['nutrition']['input_sets'].append(conflicting)
  b=gzip.compress(b''.join((json.dumps(p)+'\n').encode()for p in products));snapshot={'versionId':'fixture','etag':'"fixture"','compressedBytes':len(b)}
  result=stream.stage('targets','stage',io.BytesIO(b),snapshot,commit_every=1,invalid_identity_policy='exclude-non-target-v1')
  approved={'sourceVersionId':'fixture','etag':'"fixture"','expectedBytes':len(b)}
  (self.root/'off-ref-bulk-preflight.json').write_text(json.dumps(approved))
  run=self.root/'run';run.mkdir();(run/'report.json').write_text(json.dumps({'format':'opengym-authorized-off-full-pass','version':1,'complete':True,'fullGzipCrcAndLengthVerified':True,'networkGetAttempts':1,'automaticRetries':0,'archiveRetained':False,'productionActivated':False,'stage':'stage','extraction':result,'approvedSnapshot':approved,'sourceUrl':'https://openfoodfacts-ds.s3.eu-west-3.amazonaws.com/openfoodfacts-products.jsonl.gz?versionId=fixture'}))
  return m.build('targets','normalized',staged_name='stage',source_run='run')
 def test_attested_full_pipeline_keeps_units_and_conflicts_and_frozen_benchmark(self):
  result=self.build();self.assertTrue(result['fullDumpVerified']);self.assertFalse(result['productionAllowed']);self.assertEqual(result['accepted'],2)
  frame=self.root/'benchmark';frame.mkdir();cases=[{'caseId':str(i),'expectedCode':c,'query':None}for i,c in enumerate(self.codes+['8076809513729'])]+[{'caseId':'no-code','expectedCode':None}]
  wire=''.join(json.dumps(c)+'\n'for c in cases);(frame/'cases.jsonl').write_text(wire)
  (frame/'benchmark.json').write_text(json.dumps({'complete':True,'cases':6,'casesSha256':hashlib.sha256(wire.encode()).hexdigest()}))
  report=audit.audit('normalized','benchmark','audit')
  self.assertEqual(report['acceptedByReferenceUnit'],{'g':1,'ml':1});self.assertEqual(report['benchmarkCapturedCodes'],4);self.assertEqual(report['validatedBenchmarkCodes'],2)
  self.assertEqual(report['benchmarkReferenceStatusCounts'],{'accepted':2,'conflicting-valid-input-sets':1,'original-input-sets-unavailable':1,'not-captured':1})
  self.assertEqual((frame/'cases.jsonl').read_text(),wire);self.assertIsNone(report['precisionAt5']);self.assertFalse(report['applicationActivated'])
  self.assertTrue(all(v['sourceQuery']is None and v['relevance']=='exact-expected-barcode'for v in report['benchmarkMatches']))
  self.assertEqual([r['status']for r in report['curatedControls']],['accepted','accepted','conflicting-valid-input-sets','original-input-sets-unavailable','not-captured','not-captured'])
  self.assertEqual(report['journalSampleFoods'],2)
  self.assertEqual(report['memoryMetric'],'linux-process-VmHWM')
  self.assertGreater(report['pythonPeakRssKiB'],0);self.assertLessEqual(report['pythonPeakRssKiB'],512*1024)
  self.assertEqual(report['memoryCheckpoints'][-1]['phase'],'journal-sample-written')
 def test_tampered_source_attestation_cannot_build_an_experimental_generation(self):
  self.build();file=self.root/'run'/'report.json';data=json.loads(file.read_text());data['extraction']['lines']+=1;file.write_text(json.dumps(data))
  with self.assertRaisesRegex(Exception,'source-attestation-mismatch'):m.build('targets','untrusted',staged_name='stage',source_run='run')
  self.assertFalse((self.root/'untrusted').exists())

if __name__=='__main__':unittest.main()
