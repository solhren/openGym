"""Development-only immutable wger/OFF join. No HTTP or personal storage.

The auxiliary generation holds search metadata and proven UUID bindings, never a
second copy of Food payloads. Original generations are always opened read-only.
"""
import argparse,fcntl,hashlib,importlib.util,math,os,re,resource,sqlite3,sys,time,uuid
from pathlib import Path
from catalog import canonical,digest_file,fsync_directory,parse_json,require,search_text,resources

def load(name,file):
 s=importlib.util.spec_from_file_location(name,Path(__file__).with_name(file));m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m

off=load('off_reference','off-reference-overlay.py')
quality=load('wger_quality','wger-complement.py')
FORMAT='opengym-wger-off-search-index'
MAX_DB=768*1024**2
MAX_WORKSPACE=1024**3

def variants(code):
 """Only verified GS1 zero-padding equivalences, never integer coercion."""
 key=off.ids.canonical(code)
 if key.startswith('exact:'):return [code]
 return list(dict.fromkeys([code,*[key[-n:]for n in (8,12,13,14)if not key[:-n].strip('0')and off.ids.gtin_valid(key[-n:])and off.ids.canonical(key[-n:])==key]]))

def reference(root,verify=True):
 p=root/'current.json';require(not p.is_symlink()and p.stat().st_size<=65536,'unsafe-reference-manifest');v=parse_json(p.read_text())
 require(v.get('format')==off.FORMAT and v.get('version')==1 and v.get('complete')is True and v.get('fullDumpVerified')is True and v.get('productionAllowed')is False,'unverified-reference-generation')
 require(type(v.get('rows'))is int and 0<v['rows']<=1000000 and type(v.get('accepted'))is int and 0<v['accepted']<=v['rows'],'invalid-reference-count')
 require(type(v.get('acceptedObservedInFrance'))is int and 0<=v['acceptedObservedInFrance']<=v['accepted']and v.get('apiCapture')is None,'invalid-reference-cohort')
 require(re.fullmatch(r'reference-[a-f0-9]{32}\.sqlite',v.get('file',''))and type(v.get('bytes'))is int and 0<v['bytes']<=2*1024**3 and re.fullmatch('[a-f0-9]{64}',v.get('sha256','')),'invalid-reference-generation')
 a=v.get('sourceAttestation');require(type(a)is dict and set(a)=={'run','reportSha256','stagingSha256','compressedSha256','source','lines'}and all(re.fullmatch('[a-f0-9]{64}',a.get(k,''))for k in ('reportSha256','stagingSha256','compressedSha256')),'missing-reference-attestation')
 f=root/v['file'];require(f.is_file()and not f.is_symlink()and f.stat().st_size==v['bytes'],'unsafe-reference-file')
 if verify:require(digest_file(f)==v['sha256'],'corrupt-reference-generation')
 return v

def read_manifest(root,base_sha,quality_sha,ref_sha):
 p=root/'current.json';require(not p.is_symlink()and p.stat().st_size<=65536,'unsafe-search-manifest');v=parse_json(p.read_text())
 require(v.get('format')==FORMAT and v.get('version')==1 and v.get('complete')is True and v.get('developmentOnly')is True and v.get('literalOnly')is True,'invalid-search-generation')
 require((v.get('baseSha256'),v.get('qualitySha256'),v.get('referenceSha256'))==(base_sha,quality_sha,ref_sha),'search-source-mismatch')
 require(re.fullmatch(r'search-[a-f0-9]{32}\.sqlite',v.get('file',''))and type(v.get('bytes'))is int and 0<v['bytes']<=MAX_DB and type(v.get('rows'))is int and 0<v['rows']<=1000000 and type(v.get('bindings'))is int and 0<=v['bindings']<=5000000,'invalid-search-size')
 f=root/v['file'];require(not f.is_symlink()and f.stat().st_size==v['bytes']and digest_file(f)==v.get('sha256'),'corrupt-search-generation')
 return v

def food_record(key,result):
 f=result.get('food');require(result.get('ok')is True and type(f)is dict and f.get('schemaVersion')==1 and f.get('kind')=='food','invalid-reference-food')
 code=result.get('code');require(type(code)is str and re.fullmatch(r'(?:\d{8}|\d{12,14})',code,re.ASCII)and off.ids.canonical(code)==key,'reference-barcode-mismatch')
 ref=f.get('reference');source=f.get('source',{});lineage=source.get('offReference',{})
 require(ref==result.get('reference')and ref.get('amount')==100 and ref.get('unit')in('g','ml')and source.get('kind')=='open-food-facts'and source.get('license',{}).get('id')=='ODbL-1.0'and source.get('contentLicense')=='DbCL-1.0','invalid-reference-provenance')
 require(lineage==result.get('lineage')and lineage.get('kind')=='raw-jsonl'and lineage.get('captureConflict')is False and lineage.get('policy')=='coherent-as-sold-input-set-v1'and lineage.get('source')in('manufacturer','packaging','usda')and lineage.get('per')==('100g'if ref['unit']=='g'else'100ml')and lineage.get('preparation')=='as_sold','invalid-reference-lineage')
 require(all(type(f.get('nutrients',{}).get(k))in(int,float)and math.isfinite(f['nutrients'][k])and f['nutrients'][k]>=0 for k in ('kcal','protein','carbs','fat')),'incomplete-reference-food')
 require(all(type(f.get(k))is str and len(f[k])<=300 for k in ('name','brand'))and f['name'].strip(),'invalid-reference-name')
 return f

def build(base_name,quality_name,reference_name,output,fail_after=None):
 dest=off.root(output,True);initial=resources(off.BASE);require(initial['freeDiskBytes']>=22*1024**3 and initial['availableMemoryBytes']>=3*1024**3,'insufficient-search-index-headroom')
 lockfd=os.open(off.BASE/'.off-reference-import.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600);lock=os.fdopen(lockfd,'ab')
 try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 except OSError:lock.close();raise
 base=None;src=None;c=None;start=time.monotonic();cpu=time.process_time();rows=bindings=0;last=start
 def guard():
  b=resources(off.BASE);require(b['freeDiskBytes']>=int(20.25*1024**3)and b['availableMemoryBytes']>=int(2.25*1024**3),'search-index-resource-margin')
  require(sum(p.stat().st_size for p in dest.iterdir()if p.is_file())<=MAX_WORKSPACE and time.monotonic()-start<14400,'search-index-budget')
  peak=next(int(v.split()[1])for v in Path('/proc/self/status').read_text().splitlines()if v.startswith('VmHWM:'));require(peak<=256*1024,'search-index-memory-budget')
  return b,peak
 try:
  qroot=quality.wger.root_for(quality_name);qm=quality.read_manifest(qroot);rroot=off.root(reference_name);rm=reference(rroot)
  require(off.attest_source(rm['sourceAttestation']['run'],rm['stagedCapture'],rm['targetsSha256'])==rm['sourceAttestation'],'reference-attestation-mismatch')
  base=quality.wger.Reader(quality.wger.root_for(base_name));require(base.manifest['registryVerified']is True and qm['baseSha256']==base.manifest['sha256'],'search-base-mismatch')
  src=off.ro(rroot/rm['file']);file=dest/('search-'+uuid.uuid4().hex+'.sqlite');c=sqlite3.connect(file);os.chmod(file,0o600)
  c.executescript('''PRAGMA synchronous=FULL;PRAGMA cache_size=-8192;PRAGMA temp_store=FILE;PRAGMA max_page_count=196608;
   CREATE TABLE refs(id INTEGER PRIMARY KEY,key TEXT NOT NULL UNIQUE,code TEXT NOT NULL,name TEXT NOT NULL,brand TEXT NOT NULL,folded TEXT NOT NULL,brandfold TEXT NOT NULL,fr INTEGER NOT NULL,signature TEXT NOT NULL);
   CREATE TABLE bindings(uid TEXT PRIMARY KEY,key TEXT NOT NULL) WITHOUT ROWID;
   CREATE VIRTUAL TABLE refs_fts USING fts5(name,brand,terms,content='',tokenize='unicode61 remove_diacritics 2',prefix='3 4');''')
  for key,code,flags,payload,signature in src.execute("SELECT key,code,flags,payload,signature FROM records WHERE status='accepted' ORDER BY key"):
   result=parse_json(payload);f=food_record(key,result);require(code==result['code']and re.fullmatch('[a-f0-9]{64}',signature),'invalid-reference-signature')
   require(f['source']['offReference']['captureSha256']==rm['sourceAttestation']['compressedSha256'],'foreign-reference-capture')
   require(hashlib.sha256(canonical(result).encode()).hexdigest()==signature,'reference-signature-mismatch')
   folded=search_text(f['name']);brandfold=search_text(f['brand']);rows+=1;require(rows<=1000000,'search-index-row-budget')
   c.execute('INSERT INTO refs VALUES (?,?,?,?,?,?,?,?,?)',(rows,key,code,f['name'],f['brand'],folded,brandfold,int(bool(flags&1)),signature))
   terms=(folded+' '+brandfold).replace('œ','oe').replace('æ','ae')
   c.execute('INSERT INTO refs_fts(rowid,name,brand,terms)VALUES(?,?,?,?)',(rows,f['name'],f['brand'],terms))
   aliases=variants(code)
   candidates=base.c.execute('SELECT uid,barcode,payload,conflict FROM products WHERE barcode IN ('+','.join('?'for _ in aliases)+') LIMIT 21',aliases).fetchall()
   if len(candidates)<=20:
    for uid,barcode,raw,conflict in candidates:
     if conflict:continue
     old=parse_json(raw);original=off.ids.source_code(old.get('provenance',{}).get('sourceUrl'))
     if old.get('sourceKind')!='off-derived'or original is None or off.ids.canonical(original)!=key or off.ids.canonical(barcode)!=key:continue
     c.execute('INSERT INTO bindings VALUES(?,?)',(uid,key));bindings+=1;require(bindings<=5000000,'binding-budget')
   if rows%1000==0:
    c.commit();b,peak=guard()
    if time.monotonic()-last>=30:print(canonical({'event':'search-index-progress','rows':rows,'bindings':bindings,'seconds':time.monotonic()-start,'resources':b,'pythonPeakRssKiB':peak}),flush=True);last=time.monotonic()
   if fail_after and rows==fail_after:raise quality.wger.CatalogError('simulated-index-interruption')
  require(rows==rm['accepted'],'reference-index-count-mismatch');c.commit();guard()
  c.execute("INSERT INTO refs_fts(refs_fts)VALUES('integrity-check')");require(c.execute('PRAGMA integrity_check').fetchone()[0]=='ok','search-index-integrity')
  c.close();c=None
  with file.open('rb')as f:os.fsync(f.fileno())
  fsync_directory(dest);b,peak=guard()
  manifest={'format':FORMAT,'version':1,'complete':True,'developmentOnly':True,'literalOnly':True,'file':file.name,'bytes':file.stat().st_size,'sha256':digest_file(file),'baseSha256':base.manifest['sha256'],'qualitySha256':qm['sha256'],'referenceSha256':rm['sha256'],'rows':rows,'bindings':bindings,'seconds':time.monotonic()-start,'cpuSeconds':time.process_time()-cpu,'pythonPeakRssKiB':peak,'resources':b,'networkCalls':0}
  off.write(dest,'current.json',manifest);return manifest
 finally:
  if c:c.close()
  if src:src.close()
  if base:base.close()
  lock.close()

class Reader:
 """Pinned, read-only union of literal indexes. Only selected payloads are read."""
 def __init__(self,base,reference_root,index_root):
  self.quality=base;self.base=base.base;self.c=None;self.source=None
  try:
   rm=reference(reference_root);im=read_manifest(index_root,self.base.manifest['sha256'],base.manifest['sha256'],rm['sha256'])
   self.manifest=im;self.reference_manifest=rm
   self.source=off.ro(reference_root/rm['file']);self.source.execute('PRAGMA cache_size=-4096')
   # Bounded, factual market evidence, not invented popularity or a language
   # guess. It is separate from Food values and pinned with the reference DB.
   self.france=set()
   for(key,)in self.source.execute("SELECT key FROM records WHERE status='accepted'AND(flags&2)!=0"):
    self.france.add(key);require(len(self.france)<=100000,'market-evidence-budget')
   require(len(self.france)==rm['acceptedObservedInFrance'],'market-evidence-count-mismatch')
   self.c=off.ro(index_root/im['file']);self.c.execute('PRAGMA cache_size=-2048')
   require(self.c.execute('SELECT count(*)FROM refs').fetchone()[0]==im['rows']and self.c.execute('SELECT count(*)FROM bindings').fetchone()[0]==im['bindings'],'search-index-count-mismatch')
   self.base.c.execute('ATTACH DATABASE ? AS certified',((index_root/im['file']).resolve().as_uri()+'?mode=ro&immutable=1',))
   self.base.c.execute('PRAGMA certified.cache_size=-8192')
   self.base.c.create_function('market_fr',1,lambda key:int(key in self.france),deterministic=True)
   # Hashing multiple large files can evict the base's hot metadata pages.
   # Warm only covering metadata / FTS document sizes, never Food payloads.
   # Optional bounded read; the search deadline remains two seconds.
   deadline=time.monotonic()+3;self.base.c.set_progress_handler(lambda:int(time.monotonic()>deadline),1000)
   try:
    # COUNT(*) has a fast path that ignores INDEXED BY and picks language_idx.
    # Count the non-null INTEGER PRIMARY KEY instead: same integrity check,
    # but actually read the covering index needed by the first broad search.
    require(self.base.c.execute('SELECT count(id)FROM products INDEXED BY search_rank_idx').fetchone()[0]==self.base.manifest['rows'],'base-metadata-count-mismatch')
    require(self.base.c.execute('SELECT count(*)FROM products_fts_docsize').fetchone()[0]==self.base.manifest['rows'],'base-fts-count-mismatch')
    require(self.base.c.execute('SELECT count(*)FROM certified.bindings').fetchone()[0]==im['bindings'],'binding-count-mismatch')
    require(self.base.c.execute('SELECT count(*),sum(length(name))FROM certified.refs').fetchone()[0]==im['rows'],'reference-metadata-count-mismatch')
   except sqlite3.OperationalError as e:
    if str(e)!='interrupted':raise
   finally:self.base.c.set_progress_handler(None,0)
   self.version=hashlib.sha256(canonical({'base':im['baseSha256'],'quality':im['qualitySha256'],'reference':rm['sha256'],'search':im['sha256']}).encode()).hexdigest()
  except BaseException:self.close();raise
 def close(self):
  if self.c:self.c.close()
  if self.source:self.source.close()
  self.quality.close()
 def off_product(self,key):
  meta=self.c.execute('SELECT code,name,brand,signature FROM refs WHERE key=?',(key,)).fetchone()
  if not meta:return None
  row=self.source.execute("SELECT payload,signature FROM records WHERE key=?AND status='accepted'",(key,)).fetchone();require(row and row[1]==meta[3]and hashlib.sha256(row[0].encode()).hexdigest()==row[1],'reference-index-mismatch')
  p=parse_json(row[0]);f=food_record(key,p);require((p['code'],f['name'],f['brand'])==meta[:3]and f['source']['offReference']['captureSha256']==self.reference_manifest['sourceAttestation']['compressedSha256'],'reference-metadata-mismatch')
  return {'id':'off:'+key,'barcode':p['code'],'name':f['name'],'brand':f['brand'],'language':None,'food':f,'reference':f['reference'],'validationStatus':'validated','issues':[],'warnings':[],'provenance':f['source']}
 def product(self,uid):
  require(type(uid)is str,'invalid-product-id')
  if re.fullmatch(r'off:(?:\d{14}|exact:(?:\d{8}|\d{12,14}))',uid,re.ASCII):return self.off_product(uid[4:])
  value=self.quality.product(uid)
  if value:
   binding=self.c.execute('SELECT key FROM bindings WHERE uid=?',(uid,)).fetchone()
   if binding:
    result=self.off_product(binding[0]);require(result is not None,'missing-bound-reference');result['lookupId']=uid;return result
  return value
 def barcode(self,code):
  require(type(code)is str and re.fullmatch(r'(?:\d{8}|\d{12,14})',code,re.ASCII),'invalid-barcode')
  p=self.off_product(off.ids.canonical(code))
  if p:return [p]
  result=[];seen=set()
  for alias in variants(code):
   for original in self.base.barcode(alias):
    p=self.quality.product(original['id'])
    if p['id']not in seen:result.append(p);seen.add(p['id'])
  return result[:20]
 def search(self,query,page=1,page_size=20,language='fr'):
  require(type(page)is int and 1<=page<=20 and type(page_size)is int and 1<=page_size<=20 and type(language)is str and re.fullmatch('[a-z]{2}',language),'invalid-pagination')
  match=quality.wger.literal_matches(query);folded=search_text(query);prefix=folded if len(folded.split()[-1])>=3 else folded+' '
  # Materialize FTS scores before window grouping: SQLite forbids bm25 inside
  # a window expression. Group verified identities BEFORE count/pagination.
  sql='''WITH candidates AS MATERIALIZED (
   SELECT CASE WHEN b.key IS NOT NULL THEN 'off:'||b.key ELSE p.uid END uid,
    CASE WHEN ? IN(p.folded,p.frfold)THEN 3 WHEN substr(p.folded,1,length(?))=? OR substr(p.frfold,1,length(?))=? THEN 2 WHEN p.brandfold=? THEN 1 ELSE 0 END exact,
    CASE WHEN b.key IS NOT NULL THEN 1 WHEN p.addable=1 AND e.uid IS NULL THEN 1 ELSE 0 END usable,
    CASE WHEN b.key IS NOT NULL THEN 1 ELSE p.complete END complete,CASE WHEN ?='fr'THEN market_fr(b.key)ELSE 0 END market,(p.language=?)native,bm25(products_fts,4,6,2)score
   FROM products_fts JOIN products p INDEXED BY search_rank_idx ON p.id=products_fts.rowid LEFT JOIN certified.bindings b ON b.uid=p.uid LEFT JOIN quality.exclusions e ON e.uid=p.uid WHERE products_fts MATCH ?
   UNION ALL SELECT 'off:'||r.key,CASE WHEN r.folded=? THEN 3 WHEN substr(r.folded,1,length(?))=? THEN 2 WHEN r.brandfold=? THEN 1 ELSE 0 END,1,1,CASE WHEN ?='fr'THEN market_fr(r.key)ELSE 0 END,CASE WHEN ?='fr'THEN r.fr ELSE 0 END,bm25(refs_fts,4,2,1)
   FROM certified.refs_fts JOIN certified.refs r ON r.id=refs_fts.rowid WHERE refs_fts MATCH ?
   UNION ALL SELECT a.uid,CASE WHEN a.label=? THEN 3 ELSE 2 END,1,1,0,1,bm25(aliases_fts,8,4,1)
   FROM quality.aliases_fts JOIN quality.aliases a ON a.id=aliases_fts.rowid WHERE aliases_fts MATCH ?),
   grouped AS (SELECT uid,max(exact)exact,max(usable)usable,max(complete)complete,max(market)market,max(native)native,min(score)score FROM candidates GROUP BY uid)
  '''
  args=(folded,prefix,prefix,prefix,prefix,folded,language,language,match,folded,prefix,prefix,folded,language,language,match,query,match)
  deadline=time.monotonic()+2;self.base.c.set_progress_handler(lambda:int(time.monotonic()>deadline),1000)
  try:
   chosen=self.base.c.execute(sql+'SELECT uid,count(*)OVER() FROM grouped ORDER BY exact DESC,usable DESC,complete DESC,market DESC,native DESC,score,uid LIMIT ? OFFSET ?',(*args,page_size,(page-1)*page_size)).fetchall()
   count=chosen[0][1]if chosen else self.base.c.execute(sql+'SELECT count(*)FROM grouped',args).fetchone()[0]if page>1 else 0
   products=[self.product(uid)for uid,_ in chosen]
  finally:self.base.c.set_progress_handler(None,0)
  require(all(p is not None for p in products),'missing-ranked-product')
  return {'products':products,'count':count,'page':page,'pageSize':page_size,'catalogueVersion':self.version,'source':'wger-off','literalOnly':True,'registryVerified':True}

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--base',required=True);p.add_argument('--quality',required=True);p.add_argument('--reference',required=True);p.add_argument('--workspace',required=True);a=p.parse_args()
 resource.setrlimit(resource.RLIMIT_AS,(512*1024**2,512*1024**2));os.nice(10)
 try:print(canonical(build(a.base,a.quality,a.reference,a.workspace)))
 except Exception as e:print(canonical({'error':str(e)if isinstance(e,quality.wger.CatalogError)else type(e).__name__,'applicationActivated':False}),file=sys.stderr);sys.exit(1)
