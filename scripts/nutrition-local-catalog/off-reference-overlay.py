"""Offline-only reference proof/target index; no bulk network downloader.
Sealed sample overlays cannot be activated in production. Existing bases are RO.
"""
import argparse,collections,hashlib,importlib.util,json,os,re,selectors,shutil,signal,sqlite3,subprocess,sys,time,urllib.parse,uuid
from pathlib import Path
from catalog import BASE,CatalogError,canonical,digest_file,parse_json,require,resources,fsync_directory
s=importlib.util.spec_from_file_location('off_ids',Path(__file__).with_name('off-overlay-audit.py'));ids=importlib.util.module_from_spec(s);s.loader.exec_module(ids)
FORMAT='opengym-off-reference-proof'
FIELDS=('code','product_name','product_name_fr','generic_name','brands','schema_version','last_modified_t','no_nutrition_data','data_quality_errors_tags','product_type')
PROJECTION_VERSION=2
def root(name,new=False):
 require(type(name)is str and re.fullmatch('[A-Za-z0-9_-]{1,40}',name) and not BASE.is_symlink(),'unsafe-workspace');p=BASE/name;require(not p.is_symlink(),'unsafe-workspace')
 if new:
  p.mkdir(mode=0o700)
  # Persist the new workspace entry as well as its later files/manifests.
  fsync_directory(BASE)
 require(p.is_dir(),'missing-workspace');return p

def ro(file):
 require(file.is_file() and not file.is_symlink(),'unsafe-database');return sqlite3.connect(file.resolve().as_uri()+'?mode=ro&immutable=1',uri=True)

def write(root,name,value):
 require(re.fullmatch(r'(?:current|report|receipt)\.json',name),'unsafe-file')
 temporary=root/('.manifest-'+uuid.uuid4().hex+'.tmp')
 try:
  with temporary.open('x') as f:os.fchmod(f.fileno(),0o600);f.write(canonical(value));f.flush();os.fsync(f.fileno())
  os.link(temporary,root/name);fsync_directory(root)
 finally:temporary.unlink(missing_ok=True)

def targets(output):
 dest=root(output,True);budget=resources(dest);require(budget['freeDiskBytes']>=21*1024**3,'insufficient-free-disk')
 sources=[root('off-overlay-audit-20261026')/'targets.sqlite',root('prices-fr-pq-20261026')/'dedup.sqlite']
 db=sqlite3.connect(dest/'targets.sqlite');os.chmod(dest/'targets.sqlite',0o600)
 db.executescript('PRAGMA cache_size=-8192;PRAGMA temp_store=FILE;PRAGMA max_page_count=32768;CREATE TABLE targets(key TEXT PRIMARY KEY, flags INTEGER NOT NULL);')
 start=time.monotonic()
 try:
  for i,file in enumerate(sources):
   source=ro(file)
   try:
    query='SELECT canonical FROM codes' if i==0 else 'SELECT key FROM identities WHERE code IS NOT NULL'
    for n,(key,) in enumerate(source.execute(query)):
     require(type(key)is str and len(key)<=24,'invalid-target-key')
     db.execute('INSERT INTO targets VALUES (?,?) ON CONFLICT(key) DO UPDATE SET flags=flags|excluded.flags',(key,1<<i))
     if n%4096==0:resources(dest);require(time.monotonic()-start<300,'target-deadline');db.commit()
   finally:source.close()
  db.commit();require(db.execute('PRAGMA integrity_check').fetchone()[0]=='ok','target-integrity')
  counts={str(k):n for k,n in db.execute('SELECT flags,count(*) FROM targets GROUP BY flags')}
 finally:db.close()
 receipt={'format':'opengym-off-reference-targets','version':1,'complete':True,'count':sum(counts.values()),'flags':counts,'sourceHashes':[digest_file(f) for f in sources],'sha256':digest_file(dest/'targets.sqlite'),'bytes':(dest/'targets.sqlite').stat().st_size,'seconds':time.monotonic()-start}
 write(dest,'receipt.json',receipt);return receipt

def checked(file,size,sha):
 require(file.is_file()and not file.is_symlink() and type(size)is int and 0<size<=32*1024**2 and file.stat().st_size==size and digest_file(file)==sha,'corrupt-capture');return file

def captured_rows(raw_name,api_name):
 if raw_name:
  r=root(raw_name);receipt=parse_json((r/'capture.json').read_text());require(receipt.get('format')=='opengym-off-raw-prefix'and receipt.get('complete')is True,'invalid-raw-capture')
  f=checked(r/'rows.jsonl',receipt['bytes'],receipt['sha256']);n=0
  with f.open('rb')as stream:
   for line in stream:
    require(len(line)<=8*1024**2 and line.endswith(b'\n'),'raw-line-limit');n+=1
    yield json.loads(line),{'kind':'raw-jsonl','rowSha256':hashlib.sha256(line).hexdigest(),'captureSha256':receipt['sha256']}
  require(n==receipt['rows'],'capture-count')
 if api_name:
  r=root(api_name);receipt=parse_json((r/'capture.json').read_text());require(receipt.get('format')=='opengym-off-reference-api-probe'and receipt.get('complete')is True,'invalid-api-capture')
  for item in receipt['rows']:
   if not item.get('file'):continue
   require(re.fullmatch(r'\d{8,14}\.json',item['file']),'unsafe-source-file');f=checked(r/item['file'],item['bytes'],item['sha256'])
   p=json.loads(f.read_bytes())['product'];require(p['code']==item['code'],'source-identity-mismatch')
   yield p,{'kind':'api-v3.5','rowSha256':item['sha256']}

def projection(p):
 out={k:p[k]for k in FIELDS if k in p}
 # Preserve narrowly scoped legacy evidence for future offline review. None of
 # these fields authorizes a Food or a g/ml conversion in the current adapter.
 for k in ('nutrition_data_per','serving_quantity','serving_quantity_unit','serving_size','product_quantity_unit'):
  if k in p:out[k]=p[k]
 if type(p.get('nutriments'))is dict:
  keys=[name+suffix for name in ('energy','energy-kcal','energy-kj','proteins','carbohydrates','fat')for suffix in ('_100g','_serving','_value','_unit','_modifier')]
  out['nutriments']={k:p['nutriments'][k]for k in keys if k in p['nutriments']}
 nutrition=p.get('nutrition')
 if type(nutrition)is dict and 'input_sets'in nutrition:
  sets=nutrition['input_sets'];require(type(sets)is list and len(sets)<=32,'input-set-limit')
  result=[]
  for v in sets:
   require(type(v)is dict,'invalid-input-set');r={k:v[k]for k in ('source','preparation','per','per_unit','per_quantity')if k in v}
   if type(v.get('nutrients'))is dict:r['nutrients']={k:v['nutrients'][k]for k in ('energy-kcal','energy-kj','proteins','carbohydrates','fat')if k in v['nutrients']}
   result.append(r)
  out['nutrition']={'input_sets':result}
 return out

def staged_rows(name,targets_sha):
 stage=root(name);file=stage/'staging.sqlite';source=ro(file)
 try:
  complete=source.execute("SELECT value FROM state WHERE key='complete'").fetchone();require(complete is not None,'incomplete-staging')
  receipt=parse_json(complete[0]);require(receipt.get('complete')is True and receipt.get('targetsSha256')==targets_sha and type(receipt.get('retained'))is int and 0<=receipt['retained']<=1000000,'invalid-staging')
  count=0
  for code,payload,sha,conflict in source.execute('SELECT code,payload,row_sha,conflict FROM products ORDER BY key'):
   require(len(payload.encode())<=64*1024 and re.fullmatch('[a-f0-9]{64}',sha),'invalid-staged-row');p=parse_json(payload);require(p.get('code')==code,'staging-identity');count+=1
   yield p,{'kind':'raw-jsonl','rowSha256':sha,'captureSha256':receipt['compressedSha256'],'captureConflict':bool(conflict)}
  require(count==receipt['retained'],'staging-count-mismatch')
 finally:source.close()

class Normalizer:
 def __init__(self):
  node=shutil.which('node');require(node is not None,'node-required');self.p=subprocess.Popen([node,'--max-old-space-size=128',str(Path(__file__).with_name('off-reference-normalize.mjs'))],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
  self.selector=selectors.DefaultSelector();self.selector.register(self.p.stdout,selectors.EVENT_READ)
 def row(self,p,evidence):
  wire=(canonical({'product':projection(p),'evidence':evidence})+'\n').encode();require(len(wire)<=256*1024,'normalizer-input-limit')
  self.p.stdin.write(wire);self.p.stdin.flush();require(self.selector.select(10),'normalizer-timeout')
  line=self.p.stdout.readline(65537);require(line.endswith(b'\n')and len(line)<=65536,'normalizer-output-limit');return parse_json(line.decode())
 def close(self):
  self.selector.close()
  try:self.p.stdin.close();self.p.wait(timeout=3)
  except (OSError,subprocess.TimeoutExpired):self.p.kill();self.p.wait()
  finally:self.p.stdout.close()

def attest_source(run_name,staged_name,targets_sha):
 run=root(run_name);file=run/'report.json';require(not file.is_symlink()and file.stat().st_size<=65536,'unsafe-source-attestation');receipt=parse_json(file.read_text())
 require(receipt.get('format')=='opengym-authorized-off-full-pass'and receipt.get('version')==1 and receipt.get('complete')is True and receipt.get('fullGzipCrcAndLengthVerified')is True and receipt.get('networkGetAttempts')==1 and receipt.get('automaticRetries')==0 and receipt.get('archiveRetained')is False and receipt.get('productionActivated')is False and receipt.get('stage')==staged_name,'unverified-full-source')
 stage=root(staged_name);db=ro(stage/'staging.sqlite')
 try:
  value=db.execute("SELECT value FROM state WHERE key='complete'").fetchone();require(value is not None,'incomplete-staging');state=parse_json(value[0])
 finally:db.close()
 require(state==receipt.get('extraction')and state.get('targetsSha256')==targets_sha and state.get('complete')is True,'source-attestation-mismatch')
 approved=receipt.get('approvedSnapshot',{});snapshot=state.get('source',{})
 expected=parse_json((BASE/'off-ref-bulk-preflight.json').read_text());require(approved==expected,'unapproved-source-attestation')
 source_url='https://openfoodfacts-ds.s3.eu-west-3.amazonaws.com/openfoodfacts-products.jsonl.gz?'+urllib.parse.urlencode({'versionId':expected['sourceVersionId']})
 require(receipt.get('sourceUrl')==source_url,'source-attestation-url')
 require(snapshot.get('versionId')==approved.get('sourceVersionId')and snapshot.get('etag')==approved.get('etag')and snapshot.get('compressedBytes')==approved.get('expectedBytes')==state.get('compressedBytes'),'source-attestation-mismatch')
 return {'run':run_name,'reportSha256':digest_file(file),'stagingSha256':digest_file(stage/'staging.sqlite'),'compressedSha256':state['compressedSha256'],'source':snapshot,'lines':state['lines']}

def build(target_name,output,raw_name=None,api_name=None,staged_name=None,source_run=None,progress=None):
 require((raw_name or api_name)and not staged_name or staged_name and not(raw_name or api_name),'capture-required');target_root=root(target_name);tr=parse_json((target_root/'receipt.json').read_text())
 require(tr.get('format')=='opengym-off-reference-targets'and tr.get('complete')is True and digest_file(target_root/'targets.sqlite')==tr['sha256'],'corrupt-targets')
 require(not source_run or staged_name,'source-run-requires-staging')
 attestation=attest_source(source_run,staged_name,tr['sha256'])if source_run else None
 target=ro(target_root/'targets.sqlite');dest=root(output,True);budget=resources(BASE)
 if staged_name:require(budget['freeDiskBytes']>=23*1024**3 and budget['availableMemoryBytes']>=3*1024**3,'insufficient-normalization-headroom')
 start=time.monotonic();last_progress=start;counter=collections.Counter();normalizer=Normalizer();file=dest/('reference-'+uuid.uuid4().hex+'.sqlite')
 db=sqlite3.connect(file);os.chmod(file,0o600);db.executescript('PRAGMA cache_size=-8192;PRAGMA max_page_count='+str(524288 if staged_name else 32768)+';CREATE TABLE records(key TEXT PRIMARY KEY,code TEXT, flags INTEGER,status TEXT,payload TEXT,signature TEXT);')
 try:
  for p,evidence in (staged_rows(staged_name,tr['sha256'])if staged_name else captured_rows(raw_name,api_name)):
   counter['examined']+=1;require(counter['examined']<=(1000000 if staged_name else 1008) and time.monotonic()-start<(14400 if staged_name else 300),'proof-budget')
   if counter['examined']%128==1:
    resources(BASE);require(sum(f.stat().st_size for f in dest.iterdir()if f.is_file())<=int(2.5*1024**3),'normalization-disk-budget');db.commit()
    if progress and time.monotonic()-last_progress>=30:
     progress({'examined':counter['examined']-1,'counts':{**counter,'examined':counter['examined']-1},'seconds':time.monotonic()-start,'normalizerPid':normalizer.p.pid});last_progress=time.monotonic()
   code=p.get('code');require(type(code)is str and re.fullmatch(r'\d{8,14}',code),'invalid-capture-code');key=ids.canonical(code)
   match=target.execute('SELECT flags FROM targets WHERE key=?',(key,)).fetchone()
   if not match:counter['outsideTargets']+=1;continue
   result={'ok':False,'code':'conflicting-source-records'}if evidence.get('captureConflict')else normalizer.row(p,evidence);status='accepted'if result.get('ok')is True else result.get('code','rejected');counter[status]+=1
   # Conflicting captures never pick a winner, including changed provenance.
   signature=hashlib.sha256(canonical(result).encode()).hexdigest()
   old=db.execute('SELECT signature FROM records WHERE key=?',(key,)).fetchone()
   if old and old[0]!=signature:status='conflicting-capture-versions';result={'ok':False,'code':status};signature=status
   db.execute('INSERT INTO records VALUES (?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET status=excluded.status,payload=excluded.payload,signature=excluded.signature',(key,code,match[0],status,canonical(result),signature))
  db.commit();require(db.execute('PRAGMA integrity_check').fetchone()[0]=='ok','overlay-integrity')
  rows=db.execute('SELECT count(*)FROM records').fetchone()[0];accepted=db.execute("SELECT count(*) FROM records WHERE status='accepted'").fetchone()[0]
  france=db.execute("SELECT count(*) FROM records WHERE status='accepted'AND(flags&2)!=0").fetchone()[0]
  stats={k:n for k,n in db.execute('SELECT status,count(*) FROM records GROUP BY status')}
  db.close();db=None
  with file.open('rb')as f:os.fsync(f.fileno())
  manifest={'format':FORMAT,'version':1,'complete':True,'file':file.name,'sha256':digest_file(file),'bytes':file.stat().st_size,'targetsSha256':tr['sha256'],'rawCapture':raw_name,'apiCapture':api_name,'stagedCapture':staged_name,'sourceAttestation':attestation,'rows':rows,'accepted':accepted,'acceptedObservedInFrance':france,'statusCounts':stats,'scanned':dict(counter),'fullDumpVerified':bool(attestation),'productionAllowed':False,'sourcePolicy':'single coherent as-sold non-estimated input set','seconds':time.monotonic()-start,'license':'ODbL-1.0','contentLicense':'DbCL-1.0','attribution':'Open Food Facts contributors'}
  write(dest,'current.json',manifest);return manifest
 finally:
  if db:db.close()
  normalizer.close();target.close()

def coverage(overlay_name,benchmark_name,output):
 overlay=root(overlay_name);m=parse_json((overlay/'current.json').read_text());require(m.get('format')==FORMAT and m.get('complete')is True and re.fullmatch(r'reference-[a-f0-9]{32}\.sqlite',m.get('file','')),'invalid-overlay')
 file=overlay/m['file'];require(digest_file(file)==m['sha256'],'corrupt-overlay');db=ro(file);benchmark=root(benchmark_name);bm=parse_json((benchmark/'benchmark.json').read_text());require(digest_file(benchmark/'cases.jsonl')==bm['casesSha256'],'corrupt-benchmark')
 dest=root(output,True);hits=[];count=barcodes=0
 try:
  for line in (benchmark/'cases.jsonl').read_text().splitlines():
   case=parse_json(line);count+=1;code=case.get('expectedCode')
   if not code:continue
   barcodes+=1;row=db.execute("SELECT payload FROM records WHERE key=?AND status='accepted'",(ids.canonical(code),)).fetchone()
   if row:
    p=parse_json(row[0]);hits.append({'caseId':case['caseId'],'code':code,'name':p['food']['name'],'reference':p['food']['reference'],'nutrients':p['food']['nutrients'],'sourceKind':p['sourceKind']})
 finally:db.close()
 require(count==bm['cases'],'incomplete-benchmark');report={'complete':True,'benchmarkSha256':digest_file(benchmark/'benchmark.json'),'overlaySha256':m['sha256'],'cases':count,'supportedBarcodes':barcodes,'validatedExpectedBarcodes':len(hits),'hits':hits,'networkCalls':0,'partialSourceCoverage':not m.get('fullDumpVerified',False),'nationalCoverageClaim':False,'applicationActivated':False,'note':'Exact barcode reference coverage only. No ranking or semantic relevance claim.'if m.get('fullDumpVerified')else'Exact barcode reference coverage only. No ranking or semantic relevance claim; source probes are curated and not the full OFF dump.'}
 write(dest,'report.json',report);return report

def foods(overlay_name):
 overlay=root(overlay_name);m=parse_json((overlay/'current.json').read_text())
 require(m.get('format')==FORMAT and m.get('complete')is True and m.get('productionAllowed')is False and re.fullmatch(r'reference-[a-f0-9]{32}\.sqlite',m.get('file','')),'invalid-overlay')
 file=overlay/m['file'];require(digest_file(file)==m['sha256']and file.stat().st_size==m['bytes'],'corrupt-overlay');db=ro(file)
 try:
  result=[parse_json(r[0])for r in db.execute("SELECT payload FROM records WHERE status='accepted' ORDER BY code LIMIT 1001")]
  require(len(result)==m['accepted']<=1000,'overlay-size-or-count');return {'complete':True,'overlaySha256':m['sha256'],'foods':result}
 finally:db.close()
if __name__=='__main__':
 signal.signal(signal.SIGALRM,lambda *_:(_ for _ in ()).throw(CatalogError('overlay-deadline')));signal.alarm(14400)
 p=argparse.ArgumentParser();sub=p.add_subparsers(dest='command',required=True)
 t=sub.add_parser('targets');t.add_argument('--workspace',required=True)
 b=sub.add_parser('build');b.add_argument('--targets',required=True);b.add_argument('--workspace',required=True);b.add_argument('--raw-capture');b.add_argument('--api-capture');b.add_argument('--staged-capture');b.add_argument('--source-run');b.add_argument('--progress',action='store_true')
 c=sub.add_parser('coverage');c.add_argument('--overlay',required=True);c.add_argument('--benchmark',required=True);c.add_argument('--workspace',required=True)
 f=sub.add_parser('foods');f.add_argument('--overlay',required=True)
 a=p.parse_args()
 try:print(canonical(targets(a.workspace)if a.command=='targets'else build(a.targets,a.workspace,a.raw_capture,a.api_capture,a.staged_capture,a.source_run,(lambda p:print(canonical({'event':'normalization-checkpoint',**p}),flush=True))if a.progress else None)if a.command=='build'else foods(a.overlay)if a.command=='foods'else coverage(a.overlay,a.benchmark,a.workspace)))
 except (CatalogError,OSError,ValueError,sqlite3.Error)as e:print(canonical({'error':str(e)if isinstance(e,CatalogError)else'overlay-storage-or-input-error'}),file=sys.stderr);sys.exit(1)
