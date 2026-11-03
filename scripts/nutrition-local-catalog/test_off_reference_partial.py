import gzip,hashlib,importlib.util,io,json,os,sqlite3,tempfile,unittest
from pathlib import Path
from unittest.mock import patch

def module(name,file):
 s=importlib.util.spec_from_file_location(name,Path(__file__).with_name(file));m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
p=module('partial_audit','off-reference-partial-audit.py');stream=module('stream_for_partial','off-reference-stream.py')
class PartialAuditTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);budget={'freeDiskBytes':35*1024**3,'availableMemoryBytes':4*1024**3}
  self.patches=[patch.object(p,'BASE',self.root),patch.object(p.m,'BASE',self.root),patch.object(stream.m,'BASE',self.root),patch.object(p,'resources',return_value=budget),patch.object(stream,'resources',return_value=budget)]
  for patcher in self.patches:patcher.start()
  target=self.root/'targets';target.mkdir();db=sqlite3.connect(target/'targets.sqlite');db.execute('CREATE TABLE targets(key TEXT PRIMARY KEY,flags INTEGER)');db.execute('INSERT INTO targets VALUES(?,3)',(p.m.ids.canonical('3017620422003'),));db.commit();db.close();sha=p.m.digest_file(target/'targets.sqlite');(target/'receipt.json').write_text(json.dumps({'format':'opengym-off-reference-targets','complete':True,'sha256':sha}))
  b=gzip.compress(b'{"code":"3017620422003","product_name":"Fixture"}\n{"code":"bad-code"}\n');snapshot={'versionId':'fixture','etag':'fixture','compressedBytes':len(b)}
  with self.assertRaises(Exception):stream.stage('targets','stage',io.BytesIO(b),snapshot,commit_every=1)
  approved={'sourceVersionId':'fixture','etag':'fixture','expectedBytes':len(b)};(self.root/'off-ref-bulk-preflight.json').write_text(json.dumps(approved))
  run=self.root/'run';run.mkdir();(run/'report.json').write_text(json.dumps({'format':'opengym-authorized-off-full-pass','complete':False,'error':'invalid-stream-code','networkGetAttempts':1,'automaticRetries':0,'approvedSnapshot':approved,'stage':'stage','targets':'targets'}))
  frame=self.root/'benchmark';frame.mkdir();raw=json.dumps({'caseId':'case-one','expectedCode':'3017620422003'})+'\n';(frame/'cases.jsonl').write_text(raw);(frame/'benchmark.json').write_text(json.dumps({'cases':1,'casesSha256':hashlib.sha256(raw.encode()).hexdigest()}))
 def tearDown(self):
  for patcher in reversed(self.patches):patcher.stop()
  self.tmp.cleanup()
 def fake_row(self,product,evidence):
  lineage={**evidence,'source':'packaging'};food={'schemaVersion':1,'kind':'food','id':'fixture-food','name':'Fixture','brand':'','reference':{'amount':100,'unit':'ml'},'nutrients':{'kcal':40,'protein':0,'carbs':10,'fat':0},'portions':[],'source':{'kind':'open-food-facts','offReference':lineage}}
  return {'ok':True,'code':product['code'],'reference':food['reference'],'food':food,'lineage':lineage}
 def test_partial_analysis_never_creates_a_complete_source_or_a_current_generation(self):
  before=p.m.digest_file(self.root/'stage'/'staging.sqlite')
  with patch.object(p.m,'Normalizer')as normalizer:
   normalizer.return_value.p.pid=os.getpid();normalizer.return_value.row.side_effect=self.fake_row
   result=p.audit('run','benchmark','analysis')
  self.assertFalse(result['complete']);self.assertTrue(result['analysisComplete']);self.assertFalse(result['fullDumpVerified']);self.assertFalse(result['productionAllowed']);self.assertEqual(result['validatedBenchmarkCodes'],1)
  self.assertEqual(p.m.digest_file(self.root/'stage'/'staging.sqlite'),before);self.assertFalse((self.root/'analysis'/'current.json').exists())
  sample=json.loads((self.root/'analysis'/'journal-sample.json').read_text());self.assertTrue(sample['partialSourceCoverage']);self.assertEqual(sample['foods'][0]['food']['source']['offReference']['sourceIntegrity'],'partial-checkpoint-no-full-gzip-crc')
 def test_successful_or_unrelated_failed_runs_do_not_enter_partial_analysis(self):
  f=self.root/'run'/'report.json';r=json.loads(f.read_text());r['complete']=True;f.write_text(json.dumps(r))
  with self.assertRaises(Exception):p.audit('run','benchmark','invalid')

if __name__=='__main__':unittest.main()
