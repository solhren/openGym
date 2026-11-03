"""Read-only analysis of a failed run's DURABLE checkpoint, never a generation.
The full gzip is unverified. No completed-state fabrication or network replay.
"""
import argparse,collections,fcntl,hashlib,importlib.util,json,os,signal,sys,time
from pathlib import Path
from catalog import BASE,CatalogError,canonical,digest_file,parse_json,require,resources
s=importlib.util.spec_from_file_location('overlay',Path(__file__).with_name('off-reference-overlay.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
def rss(pid):
 try:return next(int(l.split()[1])for l in Path(f'/proc/{pid}/status').read_text().splitlines()if l.startswith('VmHWM:'))
 except(FileNotFoundError,ProcessLookupError):return 0

def audit(run_name,benchmark_name,output):
 run=m.root(run_name);receipt=parse_json((run/'report.json').read_text());require(receipt.get('format')=='opengym-authorized-off-full-pass'and receipt.get('complete')is False and receipt.get('error')=='invalid-stream-code'and receipt.get('networkGetAttempts')==1 and receipt.get('automaticRetries')==0,'unsupported-partial-run')
 approved=parse_json((BASE/'off-ref-bulk-preflight.json').read_text());require(receipt.get('approvedSnapshot')==approved,'source-plan-mismatch')
 stage=m.root(receipt['stage']);file=stage/'staging.sqlite';db=m.ro(file);require(db.execute('PRAGMA integrity_check').fetchone()[0]=='ok','partial-staging-corrupt')
 state=dict(db.execute('SELECT key,value FROM state'));require('complete'not in state and 'checkpoint'in state,'not-an-interrupted-checkpoint')
 checkpoint=parse_json(state['checkpoint']);identity=parse_json(state['identity']);snapshot=identity['snapshot']
 require(snapshot=={'versionId':approved['sourceVersionId'],'etag':approved['etag'],'compressedBytes':approved['expectedBytes']}and identity.get('projectionVersion')==m.PROJECTION_VERSION,'source-identity-mismatch')
 target_root=m.root(receipt['targets']);target_receipt=parse_json((target_root/'receipt.json').read_text());require(digest_file(target_root/'targets.sqlite')==target_receipt['sha256']==identity['targetsSha256'],'target-hash-mismatch');targets=m.ro(target_root/'targets.sqlite')
 frame=m.root(benchmark_name);bm=parse_json((frame/'benchmark.json').read_text());require(digest_file(frame/'cases.jsonl')==bm['casesSha256'],'benchmark-hash-mismatch')
 cases=[parse_json(line)for line in(frame/'cases.jsonl').read_text().splitlines()];require(len(cases)==bm['cases']<=2000,'benchmark-count');expected={m.ids.canonical(c['expectedCode']):c for c in cases if c.get('expectedCode')}
 root=m.root(output,True);budget=resources(BASE);require(budget['availableMemoryBytes']>=3*1024**3,'insufficient-analysis-headroom')
 lock=os.fdopen(os.open(BASE/'.off-reference-import.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600),'ab')
 try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 except OSError:lock.close();raise CatalogError('another-import-is-running')from None
 start=time.monotonic();last=start;counts=collections.Counter();units=collections.Counter();cohorts=collections.Counter();input_reasons=collections.Counter();strata={};samples={};matches=[];normalizer=m.Normalizer()
 stats={'minFreeDiskBytes':budget['freeDiskBytes'],'minAvailableMemoryBytes':budget['availableMemoryBytes'],'pythonPeakRssKiB':rss(os.getpid()),'nodePeakRssKiB':0};rows=db.execute('SELECT count(*)FROM products').fetchone()[0]
 report={'format':'opengym-off-partial-reference-audit','version':1,'complete':False,'analysisComplete':False,'extractionComplete':False,'fullDumpVerified':False,'productionAllowed':False,'sourceRun':run_name,'stage':receipt['stage'],'checkpoint':checkpoint,'sourceSnapshot':snapshot,'committedTargetIdentities':rows,'networkCalls':0,'noGenerationPublished':True,'benchmarkCases':len(cases),'benchmarkSupportedBarcodes':len(expected)}
 try:
  for key,code,payload,sha,conflict in db.execute('SELECT key,code,payload,row_sha,conflict FROM products ORDER BY key'):
   if counts['examined']%128==0:
    b=resources(BASE);require(b['freeDiskBytes']>=int(20.25*1024**3)and b['availableMemoryBytes']>=int(2.25*1024**3),'partial-audit-watchdog-margin');stats['minFreeDiskBytes']=min(stats['minFreeDiskBytes'],b['freeDiskBytes']);stats['minAvailableMemoryBytes']=min(stats['minAvailableMemoryBytes'],b['availableMemoryBytes']);stats['pythonPeakRssKiB']=max(stats['pythonPeakRssKiB'],rss(os.getpid()));stats['nodePeakRssKiB']=max(stats['nodePeakRssKiB'],rss(normalizer.p.pid));require(max(stats['pythonPeakRssKiB'],stats['nodePeakRssKiB'])<=512*1024,'partial-audit-process-memory');require(time.monotonic()-start<14400,'partial-audit-deadline')
    if time.monotonic()-last>=30:print(canonical({'event':'partial-audit-progress','seconds':time.monotonic()-start,'counts':dict(counts),'references':dict(units),'resources':stats}),flush=True);last=time.monotonic()
   counts['examined']+=1;p=parse_json(payload);require(p.get('code')==code and len(payload.encode())<=64*1024,'partial-row-identity')
   evidence={'kind':'raw-jsonl','rowSha256':sha,'captureSha256':checkpoint['sha256'],'captureScope':'decoded-prefix-checkpoint','sourceIntegrity':'partial-checkpoint-no-full-gzip-crc','checkpointLineCount':checkpoint['line']}
   result={'ok':False,'code':'conflicting-source-records'}if conflict else normalizer.row(p,evidence)
   if not result.get('ok'):
    counts[result.get('code','rejected')]+=1
    for reason in result.get('rejectedInputSets',[]):input_reasons[reason['reason']]+=1
    continue
   counts['coherentReference']+=1;food=result['food'];unit=food['reference']['unit'];units[unit]+=1
   flags=targets.execute('SELECT flags FROM targets WHERE key=?',(key,)).fetchone();require(flags is not None,'unmatched-target-record');cohorts['observedInFrance']+=bool(flags[0]&2);cohorts['wgerFrenchLanguage']+=bool(flags[0]&1)
   group=(unit,result['lineage']['source']);rank=hashlib.sha256(('partial-journal-v1\0'+key).encode()).hexdigest();item={'key':key,'code':code,'food':food,'scopes':['partial-checkpoint-stratum'],'rank':rank};bucket=strata.setdefault(group,[])
   if len(bucket)<10 or rank<bucket[-1]['rank']:bucket.append(item);bucket.sort(key=lambda x:x['rank']);del bucket[10:]
   if key in expected:
    samples[key]={**item,'scopes':['independent-benchmark-partial-checkpoint']};matches.append({'caseId':expected[key]['caseId'],'code':expected[key]['expectedCode'],'reference':food['reference']})
  require(counts['examined']==rows,'incomplete-partial-analysis')
  for bucket in strata.values():
   for item in bucket:
    if item['key']not in samples:samples[item['key']]=item
  sample={'format':'opengym-off-journal-sample','version':1,'complete':True,'partialSourceCoverage':True,'overlay':'no-complement-published','overlaySha256':digest_file(file),'foods':list(samples.values())}
  data=(canonical(sample)+'\n').encode();require(len(data)<=16*1024**2 and len(samples)<=1000,'sample-budget')
  with(root/'journal-sample.json').open('xb')as f:os.fchmod(f.fileno(),0o600);f.write(data);f.flush();os.fsync(f.fileno())
  report.update(analysisComplete=True,counts=dict(counts),references=dict(units),cohorts=dict(cohorts),inputSetRejectionReasons=dict(input_reasons),validatedBenchmarkCodes=len(matches),benchmarkMatches=matches,journalSampleFoods=len(samples),journalSampleSha256=hashlib.sha256(data).hexdigest(),overlaySha256=sample['overlaySha256'],sqliteIntegrity='ok',stagingBytes=file.stat().st_size,nationalCoverageClaim=False)
 except BaseException as e:report['error']=str(e)if isinstance(e,CatalogError)else type(e).__name__;raise
 finally:
  normalizer.close();db.close();targets.close();lock.close();report.update(seconds=time.monotonic()-start,resources=stats);m.write(root,'report.json',report)
 return report
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--source-run',required=True);p.add_argument('--benchmark',required=True);p.add_argument('--workspace',required=True);a=p.parse_args();os.nice(10)
 signal.signal(signal.SIGALRM,lambda *_:(_ for _ in ()).throw(CatalogError('partial-audit-deadline')));signal.alarm(14400)
 try:r=audit(a.source_run,a.benchmark,a.workspace);print(canonical({**r,'benchmarkMatches':'see report.json'}))
 except(Exception,KeyboardInterrupt)as e:print(canonical({'error':str(e)if isinstance(e,CatalogError)else type(e).__name__,'fullDumpVerified':False,'networkCalls':0}),file=sys.stderr);sys.exit(1)
