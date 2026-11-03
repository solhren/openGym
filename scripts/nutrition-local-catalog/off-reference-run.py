"""One explicitly authorized, pinned OFF stream. No retries or archive on disk.
Global and staging locks, verified HTTPS, conditional HEAD/GET, resource watchdog.
Never publishes an application catalogue. An incomplete attempt is not replayed.
"""
import argparse,fcntl,importlib.util,json,os,re,resource,signal,sys,threading,time,urllib.parse,urllib.request,urllib.error
from pathlib import Path
from catalog import BASE,CatalogError,canonical,require,resources
from export_http import EXPORTS,IDENTITY,export_opener,validate_export_url
s=importlib.util.spec_from_file_location('stream',Path(__file__).with_name('off-reference-stream.py'));stream=importlib.util.module_from_spec(s);s.loader.exec_module(stream)

def verified_headers(response,expected):
 require(response.status==200,'source-http-status')
 require(response.headers.get('Content-Length')==str(expected['expectedBytes']),'source-size-changed')
 require(response.headers.get('ETag')==expected['etag'],'source-etag-changed')
 require(response.headers.get('x-amz-version-id')==expected['sourceVersionId'],'source-version-changed')
 require((response.headers.get('Content-Encoding')or'identity')=='identity','source-content-encoding')

def run(name,stage_name,target_name,exclude_invalid_non_targets=False):
 require(all(type(v)is str and re.fullmatch('[A-Za-z0-9_-]{1,40}',v)for v in (name,stage_name,target_name)),'unsafe-workspace')
 root=stream.m.root(name,True);require(not(BASE/stage_name).exists(),'staging-workspace-already-exists')
 budget=resources(BASE);require(budget['freeDiskBytes']>=int(27.25*1024**3)and budget['availableMemoryBytes']>=3*1024**3,'insufficient-full-pass-headroom')
 fd=os.open(BASE/'.off-reference-import.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600);lock=os.fdopen(fd,'ab')
 try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 except OSError:lock.close();raise CatalogError('another-off-import-is-running')from None
 expected=json.loads((BASE/'off-ref-bulk-preflight.json').read_text())
 require(expected.get('massTransferStarted')is False and expected.get('status')==200 and expected['expectedBytes']<=stream.MAX_COMPRESSED,'invalid-approved-source')
 url='https://openfoodfacts-ds.s3.eu-west-3.amazonaws.com/openfoodfacts-products.jsonl.gz?'+urllib.parse.urlencode({'versionId':expected['sourceVersionId']});validate_export_url(url,'jsonl')
 headers={'User-Agent':IDENTITY,'Accept-Encoding':'identity','If-Match':expected['etag']}
 started=time.monotonic();cpu=time.process_time();stats={'minFreeDiskBytes':budget['freeDiskBytes'],'minAvailableMemoryBytes':budget['availableMemoryBytes'],'maxRssKiB':0};stopped=threading.Event();abort={};writing=threading.Lock()
 log=(root/'events.jsonl').open('x',buffering=1);os.fchmod(log.fileno(),0o600)
 def emit(event):
  event={'elapsedSeconds':round(time.monotonic()-started,3),**event}
  with writing:log.write(canonical(event)+'\n');print(canonical(event),flush=True)
 def watch():
  last=0
  while not stopped.wait(2):
   try:
    b=resources(BASE);stats['minFreeDiskBytes']=min(stats['minFreeDiskBytes'],b['freeDiskBytes']);stats['minAvailableMemoryBytes']=min(stats['minAvailableMemoryBytes'],b['availableMemoryBytes'])
    rss=next(int(v.split()[1])for v in Path('/proc/self/status').read_text().splitlines()if v.startswith('VmHWM:'));stats['maxRssKiB']=max(stats['maxRssKiB'],rss)
    require(b['freeDiskBytes']>=int(20.25*1024**3),'watchdog-disk-margin');require(b['availableMemoryBytes']>=int(2.25*1024**3),'watchdog-memory-margin');require(rss<=512*1024,'watchdog-process-memory')
    if time.monotonic()-last>=30:emit({'event':'resources',**b,'processPeakRssKiB':rss});last=time.monotonic()
   except (CatalogError,OSError,ValueError,StopIteration)as e:
    abort['reason']=str(e)if isinstance(e,CatalogError)else'watchdog-resource-read-error';os.kill(os.getpid(),signal.SIGUSR1);return
 def interrupted(*_):raise CatalogError(abort.get('reason','operator-interruption'))
 signal.signal(signal.SIGUSR1,interrupted);signal.signal(signal.SIGTERM,interrupted);signal.signal(signal.SIGALRM,lambda *_:(_ for _ in ()).throw(CatalogError('full-pass-deadline')));signal.alarm(stream.MAX_SECONDS)
 report={'format':'opengym-authorized-off-full-pass','version':1,'complete':False,'approvedSnapshot':expected,'sourceUrl':url,'targets':target_name,'stage':stage_name,'invalidIdentityPolicy':'exclude-non-target-v1'if exclude_invalid_non_targets else'stop','automaticRetries':0,'networkGetAttempts':0,'archiveRetained':False,'productionActivated':False,'license':'ODbL-1.0','contentLicense':'DbCL-1.0','attribution':'Open Food Facts contributors'}
 watcher=None
 try:
  # Check both current official object and the specifically approved public version.
  for target in [EXPORTS['jsonl'],url]:
   opener,_=export_opener('jsonl')
   with opener.open(urllib.request.Request(target,method='HEAD',headers=headers),timeout=15)as response:
    validate_export_url(response.geturl(),'jsonl');verified_headers(response,expected)
  emit({'event':'preflight-passed','versionId':expected['sourceVersionId'],'compressedBytes':expected['expectedBytes'],'resources':budget})
  watcher=threading.Thread(target=watch,name='off-resources',daemon=True);watcher.start()
  opener,_=export_opener('jsonl',time.monotonic()+30)
  report['networkGetAttempts']=1
  with opener.open(urllib.request.Request(url,headers=headers),timeout=30)as response:
   validate_export_url(response.geturl(),'jsonl');verified_headers(response,expected)
   snapshot={'versionId':expected['sourceVersionId'],'etag':expected['etag'],'compressedBytes':expected['expectedBytes']}
   result=stream.stage(target_name,stage_name,response,snapshot,progress=lambda p:emit({'event':'checkpoint',**p}),invalid_identity_policy='exclude-non-target-v1'if exclude_invalid_non_targets else'stop')
  report.update(complete=True,extraction=result,fullGzipCrcAndLengthVerified=True)
  emit({'event':'extraction-completed',**result})
 except BaseException as e:
  report['error']=str(e)if isinstance(e,CatalogError)else type(e).__name__
  if isinstance(e,urllib.error.HTTPError):report['httpStatus']=e.code;e.close()
  emit({'event':'stopped','error':report['error'],**({'httpStatus':report['httpStatus']}if'httpStatus'in report else{})});raise
 finally:
  stopped.set()
  if watcher:watcher.join(timeout=3)
  signal.alarm(0);report.update(seconds=time.monotonic()-started,cpuSeconds=time.process_time()-cpu,resources=stats)
  stream.m.write(root,'report.json',report);log.close();lock.close()
 return report
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--workspace',required=True);p.add_argument('--stage',required=True);p.add_argument('--targets',required=True);p.add_argument('--execute-authorized-pass',action='store_true');p.add_argument('--exclude-invalid-non-target-identities',action='store_true');a=p.parse_args()
 try:
  require(a.execute_authorized_pass,'explicit-authorized-pass-flag-required')
  resource.setrlimit(resource.RLIMIT_AS,(768*1024**2,768*1024**2));os.nice(10)
  run(a.workspace,a.stage,a.targets,a.exclude_invalid_non_target_identities)
 except (Exception,KeyboardInterrupt)as e:print(canonical({'error':str(e)if isinstance(e,CatalogError)else type(e).__name__,'noAutomaticReplay':True}),file=sys.stderr);sys.exit(1)
