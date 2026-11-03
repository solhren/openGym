"""Offline normalization supervisor: own import lock/resources, no network.
Never alters the extraction or any previous catalogue; new output workspace only.
"""
import argparse,fcntl,hashlib,json,os,selectors,signal,subprocess,sys,time
from pathlib import Path
from catalog import BASE,CatalogError,canonical,require,resources
import importlib.util
s=importlib.util.spec_from_file_location('overlay',Path(__file__).with_name('off-reference-overlay.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
def proc_memory(pid):
 try:return next(int(v.split()[1])for v in Path(f'/proc/{pid}/status').read_text().splitlines()if v.startswith('VmHWM:'))
 except(FileNotFoundError,ProcessLookupError):return 0

def run(source,stage,targets,output,report_name):
 for name in (source,stage,targets):m.root(name)
 require(not(BASE/output).exists(),'output-workspace-already-exists');root=m.root(report_name,True);b=resources(BASE)
 require(b['freeDiskBytes']>=23*1024**3 and b['availableMemoryBytes']>=3*1024**3,'insufficient-normalization-headroom')
 fd=os.open(BASE/'.off-reference-import.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600);lock=os.fdopen(fd,'ab')
 try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 except OSError:lock.close();raise CatalogError('another-off-import-is-running')from None
 command=[sys.executable,str(Path(__file__).with_name('off-reference-overlay.py')),'build','--targets',targets,'--workspace',output,'--staged-capture',stage,'--source-run',source,'--progress']
 start=time.monotonic();stats={'minFreeDiskBytes':b['freeDiskBytes'],'minAvailableMemoryBytes':b['availableMemoryBytes'],'pythonPeakRssKiB':0,'nodePeakRssKiB':0};report={'complete':False,'sourceRun':source,'stage':stage,'output':output,'networkCalls':0,'activated':False}
 child=subprocess.Popen(command,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,env={**os.environ,'TMPDIR':str(BASE/'parquet-runtime-tmp')})
 selector=selectors.DefaultSelector();selector.register(child.stdout,selectors.EVENT_READ);buffer=b'';node_pid=None;last=0
 log=(root/'events.jsonl').open('x',buffering=1);os.fchmod(log.fileno(),0o600)
 def emit(v):log.write(canonical(v)+'\n');print(canonical(v),flush=True)
 try:
  while child.poll()is None:
   b=resources(BASE);stats['minFreeDiskBytes']=min(stats['minFreeDiskBytes'],b['freeDiskBytes']);stats['minAvailableMemoryBytes']=min(stats['minAvailableMemoryBytes'],b['availableMemoryBytes'])
   require(b['freeDiskBytes']>=int(20.25*1024**3)and b['availableMemoryBytes']>=int(2.25*1024**3),'normalization-watchdog-margin')
   stats['pythonPeakRssKiB']=max(stats['pythonPeakRssKiB'],proc_memory(child.pid));stats['nodePeakRssKiB']=max(stats['nodePeakRssKiB'],proc_memory(node_pid)if node_pid else 0)
   require(stats['pythonPeakRssKiB']<=512*1024 and stats['nodePeakRssKiB']<=512*1024,'normalization-process-memory-budget');require(time.monotonic()-start<14430,'normalization-deadline')
   if time.monotonic()-last>=30:emit({'event':'normalization-resources','seconds':time.monotonic()-start,**stats});last=time.monotonic()
   if selector.select(2):
    data=os.read(child.stdout.fileno(),65536);buffer+=data;require(len(buffer)<=1024**2,'normalization-log-line-limit')
    while b'\n'in buffer:
     line,buffer=buffer.split(b'\n',1)
     try:value=json.loads(line)
     except(ValueError,UnicodeError):value={'event':'normalizer-diagnostic','line':line.decode('utf8','replace')[:1000]}
     if type(value)is dict and type(value.get('normalizerPid'))is int:node_pid=value['normalizerPid']
     emit(value)
  remainder=child.stdout.read(1024**2+1);require(len(remainder)<=1024**2,'normalization-log-limit');buffer+=remainder
  if buffer:log.write(buffer.decode('utf8','replace'))
  require(child.returncode==0,'normalization-failed-see-events')
  manifest=json.loads((m.root(output)/'current.json').read_text());require(manifest.get('complete')is True and manifest.get('fullDumpVerified')is True and manifest.get('productionAllowed')is False,'unverified-normalized-output')
  report.update(complete=True,manifest=manifest,processExit=child.returncode);emit({'event':'normalization-completed','accepted':manifest['accepted'],'rows':manifest['rows'],'seconds':time.monotonic()-start})
 except BaseException as e:
  report['error']=str(e)if isinstance(e,CatalogError)else type(e).__name__
  if child.poll()is None:
   child.terminate()
   try:child.wait(timeout=5)
   except subprocess.TimeoutExpired:child.kill();child.wait()
  raise
 finally:
  selector.close();child.stdout.close();log.close();lock.close();report.update(seconds=time.monotonic()-start,resources=stats);m.write(root,'report.json',report)
 return report
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--source-run',required=True);p.add_argument('--stage',required=True);p.add_argument('--targets',required=True);p.add_argument('--workspace',required=True);p.add_argument('--report-workspace',required=True);a=p.parse_args()
 try:os.nice(10);run(a.source_run,a.stage,a.targets,a.workspace,a.report_workspace)
 except(Exception,KeyboardInterrupt)as e:print(canonical({'error':str(e)if isinstance(e,CatalogError)else type(e).__name__,'networkCalls':0}),file=sys.stderr);sys.exit(1)
