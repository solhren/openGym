import fcntl,gzip,hashlib,importlib.util,io,json,os,signal,sqlite3,tempfile,unittest,urllib.error
from pathlib import Path
from unittest.mock import patch

def load(name,file):
 s=importlib.util.spec_from_file_location(name,Path(__file__).with_name(file));m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
m=load('reference_overlay','off-reference-overlay.py');stream=load('reference_stream','off-reference-stream.py');capture=load('reference_capture','off-reference-capture.py')
class ReferenceTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);budget={'freeDiskBytes':35*1024**3,'availableMemoryBytes':4*1024**3}
  self.patches=[patch.object(m,'BASE',self.root),patch.object(stream.m,'BASE',self.root),patch.object(capture,'BASE',self.root),patch.object(m,'resources',return_value=budget),patch.object(stream,'resources',return_value=budget),patch.object(capture,'resources',return_value=budget)]
  for p in self.patches:p.start()
  r=self.root/'targets';r.mkdir();db=sqlite3.connect(r/'targets.sqlite');db.execute('CREATE TABLE targets(key TEXT PRIMARY KEY, flags INTEGER)');db.execute('INSERT INTO targets VALUES (?,3)',(m.ids.canonical('3017620422003'),));db.commit();db.close()
  (r/'receipt.json').write_text(json.dumps({'format':'opengym-off-reference-targets','complete':True,'sha256':m.digest_file(r/'targets.sqlite')}))
 def tearDown(self):
  for p in reversed(self.patches):p.stop()
  self.tmp.cleanup()
 def archive(self,n=4):return gzip.compress(b''.join((json.dumps({'code':'3017620422003','product_name':'Fixture','nutrition':{'input_sets':[]}})+'\n').encode()for _ in range(n)))
 def snapshot(self,b):return {'versionId':'fixture','etag':'"fixture"','compressedBytes':len(b)}
 def test_stream_crc_length_and_completed_state_are_verified(self):
  b=self.archive();r=stream.stage('targets','ok',io.BytesIO(b),self.snapshot(b),commit_every=1)
  self.assertTrue(r['complete']);self.assertEqual(r['lines'],4);self.assertEqual(r['retained'],1);self.assertFalse(r['published'])
  repeated=stream.stage('targets','ok',io.BytesIO(b''),self.snapshot(b),resume=True,commit_every=1);self.assertTrue(repeated['replayed'])
  db=m.ro(self.root/'ok'/'staging.sqlite');self.assertIsNotNone(db.execute("SELECT value FROM state WHERE key='complete'").fetchone());db.close()
 def test_interruption_replays_pinned_gzip_from_zero_without_duplicate_products(self):
  b=self.archive()
  with self.assertRaisesRegex(Exception,'simulated'):stream.stage('targets','resume',io.BytesIO(b),self.snapshot(b),fail_after=2,commit_every=1)
  r=stream.stage('targets','resume',io.BytesIO(b),self.snapshot(b),resume=True,commit_every=1);self.assertEqual(r['lines'],4);self.assertEqual(r['retained'],1)
 def test_sigkill_after_a_durable_checkpoint_can_replay_without_publishing_partial_data(self):
  b=self.archive();child=os.fork()
  if child==0:
   calls=[0]
   def guard(*args):
    calls[0]+=1
    if calls[0]==4:os.kill(os.getpid(),signal.SIGSTOP)
    return {'freeDiskBytes':35*1024**3,'availableMemoryBytes':4*1024**3}
   try:
    with patch.object(stream,'resources',side_effect=guard):stream.stage('targets','killed',io.BytesIO(b),self.snapshot(b),commit_every=1)
   finally:os._exit(0)
  _,status=os.waitpid(child,os.WUNTRACED);self.assertTrue(os.WIFSTOPPED(status));os.kill(child,signal.SIGKILL);os.waitpid(child,0)
  result=stream.stage('targets','killed',io.BytesIO(b),self.snapshot(b),resume=True,commit_every=1)
  self.assertTrue(result['complete']);self.assertEqual(result['retained'],1);self.assertFalse(result['published'])
 def test_corrupt_crc_and_wrong_length_never_record_a_completed_stage(self):
  b=self.archive()
  for name,data,snapshot in [('crc',b[:-5]+bytes([b[-5]^1])+b[-4:],self.snapshot(b)),('size',b,{**self.snapshot(b),'compressedBytes':len(b)+1})]:
   with self.assertRaises(Exception):stream.stage('targets',name,io.BytesIO(data),snapshot,commit_every=1)
   db=m.ro(self.root/name/'staging.sqlite');self.assertIsNone(db.execute("SELECT value FROM state WHERE key='complete'").fetchone());db.close()
 def test_replay_prefix_mismatch_stops_without_publication(self):
  b=self.archive()
  with self.assertRaises(Exception):stream.stage('targets','different',io.BytesIO(b),self.snapshot(b),fail_after=2,commit_every=1)
  other=gzip.compress(b'{"code":"3017620422003","product_name":"Changed"}\n'*4)
  # Equal pinned metadata is insufficient: the decoded prefix must match too.
  with self.assertRaisesRegex(Exception,'prefix-mismatch'):stream.stage('targets','different',io.BytesIO(other),self.snapshot(b),resume=True,commit_every=1)
 def test_resume_refuses_a_changed_source_or_a_concurrent_writer(self):
  b=self.archive()
  with self.assertRaises(Exception):stream.stage('targets','locked',io.BytesIO(b),self.snapshot(b),fail_after=2,commit_every=1)
  with self.assertRaisesRegex(Exception,'different-source'):stream.stage('targets','locked',io.BytesIO(b),{**self.snapshot(b),'etag':'changed'},resume=True)
  with (self.root/'locked'/'.writer.lock').open('ab')as lock:
   fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
   with self.assertRaisesRegex(Exception,'writer-busy'):stream.stage('targets','locked',io.BytesIO(b),self.snapshot(b),resume=True)
 def test_completed_staging_feeds_the_same_offline_normalizer_without_network(self):
  b=self.archive();stream.stage('targets','staged',io.BytesIO(b),self.snapshot(b),commit_every=1)
  with patch.object(m,'Normalizer')as normalizer:
   normalizer.return_value.row.return_value={'ok':False,'code':'fixture-no-food'}
   result=m.build('targets','normalized',staged_name='staged')
  self.assertTrue(result['complete']);self.assertEqual(result['stagedCapture'],'staged');self.assertEqual(result['rows'],1);self.assertFalse(result['productionAllowed'])
 def test_offline_builder_interruption_never_publishes_current_or_touches_old_generation(self):
  old=self.root/'old';old.mkdir();(old/'current.json').write_text('preserve')
  with patch.object(m,'captured_rows',side_effect=m.CatalogError('simulated-interruption')),patch.object(m,'Normalizer')as n:
   with self.assertRaisesRegex(Exception,'simulated'):m.build('targets','failed','fixture')
  self.assertFalse((self.root/'failed'/'current.json').exists());self.assertEqual((old/'current.json').read_text(),'preserve');n.return_value.close.assert_called_once()
 def test_reader_rejects_tampered_manifest_and_database(self):
  r=self.root/'bad';r.mkdir();(r/'current.json').write_text(json.dumps({'format':m.FORMAT,'complete':True,'productionAllowed':False,'file':'../../escape'}))
  with self.assertRaises(Exception):m.foods('bad')
 def test_stream_workspace_budget_aborts_without_a_complete_state(self):
  b=self.archive()
  with patch.object(stream,'MAX_WORKSPACE',100),self.assertRaisesRegex(Exception,'staging-disk-budget'):
   stream.stage('targets','full',io.BytesIO(b),self.snapshot(b),commit_every=1)
  db=m.ro(self.root/'full'/'staging.sqlite');self.assertIsNone(db.execute("SELECT value FROM state WHERE key='complete'").fetchone());db.close()
 def test_resume_does_not_write_into_an_unrelated_generation_or_follow_lock_symlinks(self):
  b=self.archive();old=self.root/'unrelated';old.mkdir();(old/'current.json').write_text('preserve')
  with self.assertRaisesRegex(Exception,'missing-or-unsafe-staging'):stream.stage('targets','unrelated',io.BytesIO(b),self.snapshot(b),resume=True)
  self.assertEqual(sorted(p.name for p in old.iterdir()),['current.json'])
  linked=self.root/'linked';linked.mkdir();sqlite3.connect(linked/'staging.sqlite').close();protected=self.root/'protected';protected.write_text('preserve');mode=protected.stat().st_mode
  (linked/'.writer.lock').symlink_to(protected)
  with self.assertRaises(OSError):stream.stage('targets','linked',io.BytesIO(b),self.snapshot(b),resume=True)
  self.assertEqual(protected.read_text(),'preserve');self.assertEqual(protected.stat().st_mode,mode)
 def test_capture_stops_on_503_without_retry_and_keeps_incomplete_receipt(self):
  opener=type('Opener',(),{'open':lambda *a,**k:(_ for _ in ()).throw(urllib.error.HTTPError('https://world.openfoodfacts.org',503,'fixture',{},None))})()
  with patch.object(capture.urllib.request,'build_opener',return_value=opener),patch.object(capture.time,'sleep'):
   with self.assertRaisesRegex(Exception,'503'):capture.capture('failed-network')
  self.assertFalse(json.loads((self.root/'failed-network'/'capture.json').read_text())['complete'])
 def test_projection_keeps_bounded_legacy_evidence_without_inventing_an_input_set(self):
  p={'code':'3017620422003','nutrition_data_per':'serving','serving_quantity':200,'serving_quantity_unit':'ml','nutriments':{'proteins_value':2,'proteins_100g':1,'unrelated':{'huge':'discard'}}}
  r=m.projection(p);self.assertEqual(r['serving_quantity_unit'],'ml');self.assertEqual(r['nutriments'],{'proteins_100g':1,'proteins_value':2});self.assertNotIn('nutrition',r)
 def test_non_numeric_unmatched_source_code_can_be_excluded_only_in_explicit_policy(self):
  lines=[{'code':'3017620422003','product_name':'Fixture'},{'code':'not-a-barcode'},{'code':'3017620422003','product_name':'Fixture'}]
  b=gzip.compress(b''.join((json.dumps(r)+'\n').encode()for r in lines))
  with self.assertRaisesRegex(Exception,'invalid-stream-code'):stream.stage('targets','strict-code',io.BytesIO(b),self.snapshot(b),commit_every=1)
  errors=list((self.root/'strict-code').glob('failure-*.json'));self.assertEqual(len(errors),1);self.assertEqual(json.loads(errors[0].read_text())['observedLine'],2)
  result=stream.stage('targets','exclude-code',io.BytesIO(b),self.snapshot(b),commit_every=1,invalid_identity_policy='exclude-non-target-v1')
  self.assertTrue(result['complete']);self.assertEqual(result['lines'],3);self.assertEqual(result['retained'],1);self.assertEqual(result['excludedInvalidIdentities'],1)
 def test_invalid_identity_exclusion_never_discards_a_target_and_has_a_fixed_cap(self):
  lines=b'{"code":"not-a-barcode"}\n';b=gzip.compress(lines)
  with patch.object(stream,'MAX_INVALID_IDENTITIES',0),self.assertRaisesRegex(Exception,'too-many-invalid'):
   stream.stage('targets','too-many',io.BytesIO(b),self.snapshot(b),invalid_identity_policy='exclude-non-target-v1')
  folder=self.root/'targets';db=sqlite3.connect(folder/'targets.sqlite');db.execute('INSERT INTO targets VALUES (?,1)',('exact:not-a-barcode',));db.commit();db.close()
  (folder/'receipt.json').write_text(json.dumps({'format':'opengym-off-reference-targets','complete':True,'sha256':m.digest_file(folder/'targets.sqlite')}))
  with self.assertRaisesRegex(Exception,'invalid-identity-matches-target'):
   stream.stage('targets','bad-target',io.BytesIO(b),self.snapshot(b),invalid_identity_policy='exclude-non-target-v1')
 def test_failed_full_run_cannot_be_attested_as_a_complete_source(self):
  folder=self.root/'failed-full';folder.mkdir();(folder/'report.json').write_text(json.dumps({'format':'opengym-authorized-off-full-pass','version':1,'complete':False}))
  with self.assertRaisesRegex(Exception,'unverified-full-source'):m.attest_source('failed-full','unused','a'*64)
 def test_new_workspace_syncs_its_parent_before_use(self):
  with patch.object(m,'fsync_directory',wraps=m.fsync_directory)as sync:
   folder=m.root('durable-workspace',True)
   self.assertTrue(folder.is_dir());sync.assert_called_once_with(self.root)
 def test_exclusions_are_counted_and_bounded_without_logging_raw_identity(self):
  sensitive='not-a-barcode-private-diagnostic'
  rows=[{'code':sensitive+str(i)}for i in range(12)]+[{'code':'3017620422003','product_name':'Fixture'}]
  b=gzip.compress(b''.join((json.dumps(v)+'\n').encode()for v in rows))
  result=stream.stage('targets','bounded-log',io.BytesIO(b),self.snapshot(b),commit_every=1,invalid_identity_policy='exclude-non-target-v1')
  self.assertEqual(result['excludedInvalidIdentities'],12);self.assertEqual(result['retained'],1)
  self.assertEqual(len(result['excludedIdentitySamples']),10)
  self.assertNotIn(sensitive,json.dumps(result))
  for v in result['excludedIdentitySamples']:
   self.assertEqual(set(v),{'line','length','sha256','reason'});self.assertEqual(len(v['sha256']),64)
  db=m.ro(self.root/'bounded-log'/'staging.sqlite')
  checkpoint=json.loads(db.execute("SELECT value FROM state WHERE key='checkpoint'").fetchone()[0]);db.close()
  self.assertEqual(checkpoint['excludedInvalidIdentities'],12);self.assertNotIn(sensitive,json.dumps(checkpoint))
 def test_exclusion_checkpoint_replay_does_not_double_count_or_change_policy(self):
  b=gzip.compress(b'{"code":"invalid"}\n{"code":"3017620422003"}\n{"code":"invalid-again"}\n')
  with self.assertRaisesRegex(Exception,'simulated'):
   stream.stage('targets','exclude-replay',io.BytesIO(b),self.snapshot(b),commit_every=1,fail_after=2,invalid_identity_policy='exclude-non-target-v1')
  with self.assertRaisesRegex(Exception,'different-source'):
   stream.stage('targets','exclude-replay',io.BytesIO(b),self.snapshot(b),resume=True)
  result=stream.stage('targets','exclude-replay',io.BytesIO(b),self.snapshot(b),resume=True,commit_every=1,invalid_identity_policy='exclude-non-target-v1')
  self.assertEqual(result['excludedInvalidIdentities'],2);self.assertEqual(len(result['excludedIdentitySamples']),2)
 def test_conflicting_target_aliases_are_quarantined_and_never_pick_a_winner(self):
  b=gzip.compress(b'{"code":"3017620422003","product_name":"First"}\n{"code":"03017620422003","product_name":"Changed"}\n')
  result=stream.stage('targets','collision',io.BytesIO(b),self.snapshot(b),commit_every=1,invalid_identity_policy='exclude-non-target-v1')
  self.assertEqual(result['retained'],1);self.assertEqual(result['conflicts'],1)
  row=next(m.staged_rows('collision',m.digest_file(self.root/'targets'/'targets.sqlite')))
  self.assertTrue(row[1]['captureConflict'])
 def test_oversized_malformed_target_is_not_excluded(self):
  bad='malformed-target-that-is-over-24-characters'
  db=sqlite3.connect(self.root/'targets'/'targets.sqlite');db.execute('INSERT INTO targets VALUES (?,1)',('exact:'+bad,));db.commit();db.close()
  (self.root/'targets'/'receipt.json').write_text(json.dumps({'format':'opengym-off-reference-targets','complete':True,'sha256':m.digest_file(self.root/'targets'/'targets.sqlite')}))
  b=gzip.compress((json.dumps({'code':bad})+'\n').encode())
  with self.assertRaisesRegex(Exception,'invalid-identity-matches-target'):
   stream.stage('targets','oversized-target',io.BytesIO(b),self.snapshot(b),invalid_identity_policy='exclude-non-target-v1')

if __name__=='__main__':unittest.main()
