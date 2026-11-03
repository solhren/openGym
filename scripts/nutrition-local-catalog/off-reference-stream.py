"""Local/stdin gzip streaming staging, NEVER a downloader or publisher.
Replay from gzip byte zero resumes a pinned source; do not seek into plain gzip.
The full network transfer remains an explicit operator decision outside this tool.
"""
import argparse,fcntl,gzip,hashlib,importlib.util,io,json,os,re,resource,signal,sqlite3,sys,time
from pathlib import Path
from catalog import BASE,CatalogError,canonical,digest_file,require,resources
s=importlib.util.spec_from_file_location('overlay',Path(__file__).with_name('off-reference-overlay.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
MAX_COMPRESSED=14*1024**3
MAX_EXPANDED=256*1024**3
MAX_LINE=8*1024**2
MAX_PAYLOAD=64*1024
MAX_SECONDS=4*3600
MAX_WORKSPACE=int(2.5*1024**3)
MAX_INVALID_IDENTITIES=1000
def guard(root):
 # The general prototype's 2 GiB workspace ceiling cannot include a 2 GiB DB
 # plus its rollback journal. Keep its system reserves, add our explicit cap.
 budget=resources(BASE)
 require(sum(f.stat().st_size for f in root.iterdir()if f.is_file())<=MAX_WORKSPACE,'staging-disk-budget')
 return budget
class Counting:
 def __init__(self,raw,expected):self.raw=raw;self.expected=expected;self.count=0;self.sha=hashlib.sha256()
 def read(self,n=-1):
  require(self.count<=self.expected,'compressed-size-exceeded');amount=min(n if n>=0 else 65536,65536,self.expected-self.count+1)
  b=self.raw.read(amount);self.count+=len(b);require(self.count<=self.expected,'compressed-size-exceeded');self.sha.update(b);return b

def stage(target_name,output,raw,snapshot,resume=False,fail_after=None,commit_every=1000,progress=None,invalid_identity_policy='stop'):
 require(invalid_identity_policy in('stop','exclude-non-target-v1'),'invalid-identity-policy')
 require(type(snapshot)is dict and set(snapshot)=={'versionId','etag','compressedBytes'} and type(snapshot['compressedBytes'])is int and 0<snapshot['compressedBytes']<=MAX_COMPRESSED and all(type(snapshot[k])is str and 1<=len(snapshot[k])<=512 for k in ('versionId','etag')),'invalid-source-snapshot')
 require(type(commit_every)is int and 1<=commit_every<=1000,'invalid-checkpoint-budget')
 target_root=m.root(target_name);receipt=json.loads((target_root/'receipt.json').read_text());require(receipt.get('complete')is True and receipt.get('format')=='opengym-off-reference-targets' and digest_file(target_root/'targets.sqlite')==receipt['sha256'],'corrupt-targets')
 root=m.root(output,not resume);budget=guard(root);require(budget['freeDiskBytes']>=24*1024**3 and budget['availableMemoryBytes']>=3*1024**3,'insufficient-stream-headroom')
 require(not(root/'staging.sqlite').is_symlink() and(not resume or(root/'staging.sqlite').is_file()),'missing-or-unsafe-staging')
 fd=os.open(root/'.writer.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600);os.fchmod(fd,0o600);lock=os.fdopen(fd,'ab')
 try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 except OSError:lock.close();raise CatalogError('stream-writer-busy') from None
 db=sqlite3.connect(root/'staging.sqlite');os.chmod(root/'staging.sqlite',0o600);target=m.ro(target_root/'targets.sqlite')
 db.executescript('PRAGMA synchronous=FULL;PRAGMA cache_size=-16384;PRAGMA temp_store=FILE;PRAGMA max_page_count=524288;CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,value TEXT NOT NULL);CREATE TABLE IF NOT EXISTS products(key TEXT PRIMARY KEY,code TEXT NOT NULL,payload TEXT NOT NULL,row_sha TEXT NOT NULL,conflict INTEGER NOT NULL DEFAULT 0);')
 identity=canonical({'snapshot':snapshot,'targetsSha256':receipt['sha256'],'projectionVersion':m.PROJECTION_VERSION})
 if invalid_identity_policy!='stop':identity=canonical({'snapshot':snapshot,'targetsSha256':receipt['sha256'],'projectionVersion':m.PROJECTION_VERSION,'invalidIdentityPolicy':invalid_identity_policy})
 def ensure(condition,code):
  if not condition:db.close();target.close();lock.close();raise CatalogError(code)
 old=db.execute("SELECT value FROM state WHERE key='identity'").fetchone()
 if old:ensure(old[0]==identity and resume,'different-source-or-targets')
 else:
  ensure(not resume,'missing-resume-identity');db.execute("INSERT INTO state VALUES('identity',?)",(identity,));db.commit()
 checkpoint=db.execute("SELECT value FROM state WHERE key='checkpoint'").fetchone();checkpoint=json.loads(checkpoint[0])if checkpoint else {'line':0,'sha256':hashlib.sha256(b'').hexdigest(),'expandedBytes':0}
 completed=db.execute("SELECT value FROM state WHERE key='complete'").fetchone()
 if completed:
  db.close();target.close();lock.close();return {**json.loads(completed[0]),'replayed':True}
 counted=Counting(raw,snapshot['compressedBytes']);decoded=gzip.GzipFile(fileobj=counted,mode='rb');digest=hashlib.sha256();line_count=expanded=0;start=time.monotonic();last_progress=start
 excluded=checkpoint.get('excludedInvalidIdentities',0);excluded_samples=checkpoint.get('excludedIdentitySamples',[]);current_code=None
 try:
  while True:
   line=decoded.readline(MAX_LINE+1)
   if not line:break
   require(line.endswith(b'\n')and len(line)<=MAX_LINE,'invalid-stream-line');line_count+=1;expanded+=len(line);require(expanded<=MAX_EXPANDED and time.monotonic()-start<=MAX_SECONDS,'stream-budget')
   digest.update(line)
   if line_count%commit_every==0:
    guard(root)
    peak=next(int(v.split()[1])for v in Path('/proc/self/status').read_text().splitlines()if v.startswith('VmHWM:'))
    require(peak<=512*1024,'stream-memory-budget')
   if line_count<=checkpoint['line']:
    if line_count==checkpoint['line']:require(digest.hexdigest()==checkpoint['sha256']and expanded==checkpoint['expandedBytes'],'replay-prefix-mismatch')
    continue
   current_code=None
   p=json.loads(line,parse_constant=lambda _:(_ for _ in ()).throw(CatalogError('nonfinite-json')));require(type(p)is dict and type(p.get('code'))is str,'invalid-stream-product')
   code=p['code'];current_code=code;key=m.ids.canonical(code)if re.fullmatch(r'\d{1,64}',code)else None
   if key is None:
    require(invalid_identity_policy=='exclude-non-target-v1','invalid-stream-code')
    require(target.execute('SELECT 1 FROM targets WHERE key=?',('exact:'+code,)).fetchone()is None,'invalid-identity-matches-target')
    excluded+=1;require(excluded<=MAX_INVALID_IDENTITIES,'too-many-invalid-source-identities')
    if len(excluded_samples)<10:excluded_samples.append({'line':line_count,'length':len(code),'sha256':hashlib.sha256(code.encode()).hexdigest(),'reason':'empty-code'if not code else'non-digit-or-oversized-code'})
   if key is not None and target.execute('SELECT 1 FROM targets WHERE key=?',(key,)).fetchone():
    projected=canonical(m.projection(p));require(len(projected.encode())<=MAX_PAYLOAD,'target-projection-limit');sha=hashlib.sha256(line).hexdigest()
    # Repeated conflicting identities are preserved but never silently selected.
    db.execute('INSERT INTO products(key,code,payload,row_sha) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET conflict=CASE WHEN products.payload=excluded.payload THEN products.conflict ELSE 1 END',(key,code,projected,sha))
   if line_count%commit_every==0:
    guard(root)
    value=canonical({'line':line_count,'sha256':digest.hexdigest(),'expandedBytes':expanded,**({'excludedInvalidIdentities':excluded,'excludedIdentitySamples':excluded_samples}if invalid_identity_policy!='stop'else{})});db.execute("INSERT INTO state VALUES('checkpoint',?) ON CONFLICT(key)DO UPDATE SET value=excluded.value",(value,));db.commit()
    if progress and time.monotonic()-last_progress>=30:
     progress({'lines':line_count,'compressedBytes':counted.count,'expandedBytes':expanded,'retained':db.execute('SELECT count(*)FROM products').fetchone()[0],'seconds':time.monotonic()-start});last_progress=time.monotonic()
   if fail_after and line_count==fail_after:raise CatalogError('simulated-interruption')
  require(line_count>=checkpoint['line'],'replay-too-short');require(counted.count==snapshot['compressedBytes'],'source-length-mismatch')
  # gzip must reach EOF/CRC before any completed state can be recorded.
  require(db.execute('PRAGMA integrity_check').fetchone()[0]=='ok','staging-integrity')
  result={'complete':True,'lines':line_count,'expandedBytes':expanded,'compressedBytes':counted.count,'compressedSha256':counted.sha.hexdigest(),'decodedSha256':digest.hexdigest(),'retained':db.execute('SELECT count(*)FROM products').fetchone()[0],'conflicts':db.execute('SELECT count(*)FROM products WHERE conflict=1').fetchone()[0],'source':snapshot,'targetsSha256':receipt['sha256'],'seconds':time.monotonic()-start,'networkPerformedByTool':False,'published':False}
  if invalid_identity_policy!='stop':result.update(excludedInvalidIdentities=excluded,excludedIdentitySamples=excluded_samples,invalidIdentityPolicy=invalid_identity_policy)
  db.execute("INSERT INTO state VALUES('complete',?)",(canonical(result),));db.commit();return result
 except BaseException as error:
  # Bounded, non-sensitive diagnostics; never turn a failed stream into complete.
  info={'complete':False,'error':str(error)if isinstance(error,CatalogError)else type(error).__name__,'observedLine':line_count,'compressedBytesRead':counted.count,'expandedBytesRead':expanded,'codeLength':len(current_code)if type(current_code)is str else None,'codeSha256':hashlib.sha256(current_code.encode()).hexdigest()if type(current_code)is str else None}
  try:
   import uuid
   with(root/('failure-'+uuid.uuid4().hex+'.json')).open('x')as f:os.fchmod(f.fileno(),0o600);f.write(canonical(info));f.flush();os.fsync(f.fileno())
  except OSError:pass
  raise
 finally:db.close();target.close();decoded.close();lock.close()
if __name__=='__main__':
 resource.setrlimit(resource.RLIMIT_AS,(768*1024**2,768*1024**2))
 signal.signal(signal.SIGALRM,lambda *_:(_ for _ in ()).throw(CatalogError('stream-deadline')));signal.alarm(MAX_SECONDS)
 p=argparse.ArgumentParser();p.add_argument('--targets',required=True);p.add_argument('--workspace',required=True);p.add_argument('--version-id',required=True);p.add_argument('--etag',required=True);p.add_argument('--compressed-bytes',type=int,required=True);p.add_argument('--resume',action='store_true');p.add_argument('--stdin-gzip',action='store_true');a=p.parse_args()
 try:
  require(a.stdin_gzip,'stdin-gzip-required-no-network-is-performed')
  print(canonical(stage(a.targets,a.workspace,sys.stdin.buffer,{'versionId':a.version_id,'etag':a.etag,'compressedBytes':a.compressed_bytes},a.resume)))
 except (CatalogError,OSError,ValueError,sqlite3.Error,EOFError,MemoryError,RecursionError)as e:print(canonical({'error':str(e)if isinstance(e,CatalogError)else'stream-input-or-storage-error','published':False}),file=sys.stderr);sys.exit(1)
