"""Full wger generation builder and immutable read-only V1 reader.

Maintenance-only publication is atomic within a NEW isolated workspace. Its
manifest format deliberately cannot be mistaken for the existing OFF catalogue.
No fuzzy index, external provider, arbitrary filesystem path, or user storage.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import shutil
import sqlite3
import sys
import time
import uuid
from catalog import BASE, CatalogError, canonical, digest_file, fsync_directory, parse_json, require, search_text
from wger_sqlite_loader import literal_matches

FORMAT='opengym-wger-full-generation'
MAX_DB=8*1024**3
MAX_ROWS=5_000_000
MAX_LINE=256*1024
QUERIES=('Nutella','Coca-Cola','lait','riz','pâtes','yaourt','œuf','œufs','banane','poulet','Carrefour','Auchan','Leclerc','Danone','Nestlé','Lactel','Bonne Maman')

def root_for(name, exists=True):
    require(type(name) is str and re.fullmatch(r'[A-Za-z0-9_-]{1,40}',name),'invalid-workspace')
    root=BASE/name;require(not BASE.is_symlink() and not root.is_symlink() and (not exists or root.is_dir()),'unsafe-workspace');return root

def guard(root):
    mem=next(int(v.split()[1])*1024 for v in Path('/proc/meminfo').read_text().splitlines() if v.startswith('MemAvailable:'))
    disk=shutil.disk_usage(root).free
    require(mem>=2*1024**3,'insufficient-available-memory');require(disk>=20*1024**3,'insufficient-free-disk')
    used=sum(p.stat().st_size for p in root.iterdir() if p.is_file() and not p.is_symlink())
    require(used<=MAX_DB+256*1024**2,'workspace-disk-budget-exceeded')
    return {'availableMemoryBytes':mem,'freeDiskBytes':disk,'workspaceBytes':used}

def atomic_json(root,name,value):
    require(name in ('current.json','report.json','interrupted.json'),'invalid-output')
    temp=root/(name+'.'+uuid.uuid4().hex+'.tmp')
    with temp.open('x') as f:f.write(canonical(value));f.flush();os.fsync(f.fileno())
    os.replace(temp,root/name);fsync_directory(root)

def increment(counter,key):
    key=str(key);require(len(key)<=1000 and (key in counter or len(counter)<5000),'metadata-cardinality-limit');counter[key]=counter.get(key,0)+1

def build(root,incoming,replay=False):
    existing_files=list(root.glob('catalog-*.sqlite'))
    require(not (root/'current.json').exists() and (len(existing_files)==1 if replay else not existing_files),'generation-exists')
    initial=guard(root);start=time.monotonic();cpu=time.process_time();min_mem=initial['availableMemoryBytes'];min_disk=initial['freeDiskBytes']
    generation=existing_files[0].name if replay else 'catalog-'+uuid.uuid4().hex+'.sqlite';file=root/generation;header=None;finish=None;c=None
    counts={'inputAccepted':0,'indexed':0,'duplicates':0,'incompatibleDuplicates':0,'fourMacros':0,'fourMacrosValid':0,'technicallyAddableComplete':0,'technicallyAddablePartial':0,'needsVerification':0,'barcodeMissing':0}
    distributions={key:{} for key in ('languages','sourceKinds','licenses','issues','warnings')}
    samples={};messages=0
    try:
        for raw in iter(lambda:incoming.readline(MAX_LINE+1),b''):
            require(len(raw)<=MAX_LINE and raw.endswith(b'\n'),'oversized-or-truncated-message');msg=parse_json(raw.decode('utf8'));messages+=1
            require(type(msg) is dict and finish is None,'invalid-import-message')
            if header is None:
                require(msg.keys()=={'header'},'missing-import-header');header=msg['header']
                require(header.get('format')==FORMAT and header.get('version')==1 and re.fullmatch(r'[a-f0-9]{64}',header.get('sourceSha256','')) and type(header.get('expectedRows')) is int and 0<header['expectedRows']<=MAX_ROWS,'invalid-import-header')
                require(type(header.get('registry')) is dict and type(header['registry'].get('verified')) is bool,'invalid-registry-status')
                c=sqlite3.connect(file)
                if replay:
                    previous=parse_json(c.execute("SELECT value FROM meta WHERE key='header'").fetchone()[0])
                    require(previous['sourceSha256']==header['sourceSha256'] and previous['expectedRows']==header['expectedRows'] and canonical(previous['registry'])==canonical(header['registry']),'incompatible-replay-source')
                    c.executescript('PRAGMA max_page_count=2097152; PRAGMA cache_size=-8192; PRAGMA temp_store=FILE; PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE;')
                else:c.executescript('''PRAGMA page_size=4096; PRAGMA max_page_count=2097152; PRAGMA cache_size=-8192; PRAGMA temp_store=FILE; PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE;
                  CREATE TABLE products(id INTEGER PRIMARY KEY,uid TEXT NOT NULL UNIQUE,barcode TEXT,name TEXT NOT NULL,folded TEXT NOT NULL,frfold TEXT NOT NULL,brandfold TEXT NOT NULL,language TEXT,complete INTEGER NOT NULL,addable INTEGER NOT NULL,payload TEXT NOT NULL,digest TEXT NOT NULL,conflict INTEGER NOT NULL DEFAULT 0);
                  CREATE TABLE collisions(uid TEXT NOT NULL,digest TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(uid,digest));
                  CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);''')
                c.execute('INSERT OR REPLACE INTO meta VALUES (?,?)',('header',canonical(header)));c.commit();continue
            if msg.keys()=={'finish'}:
                finish=msg['finish'];continue
            require(msg.keys()=={'record','sourceLine'} and type(msg['sourceLine']) is int and 0<msg['sourceLine']<=header['expectedRows'],'invalid-record-message')
            row=msg['record'];require(type(row) is dict and type(row.get('id')) is str and re.fullmatch(r'wger:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}',row['id']),'invalid-record-id')
            require(type(row.get('name')) is str and 0<len(row['name'])<=300 and type(row.get('brand')) is str and len(row['brand'])<=300,'invalid-record-text')
            counts['inputAccepted']+=1;require(counts['inputAccepted']<=MAX_ROWS,'row-limit')
            payload=canonical(row);digest=hashlib.sha256(payload.encode()).hexdigest()
            existing=c.execute('SELECT id,digest,payload FROM products WHERE uid=?',(row['id'],)).fetchone()
            if replay:
                require(existing is not None and existing[0]<=counts['indexed']+1,'replay-missing-or-reordered-row')
                require(existing[1]==digest or c.execute('SELECT 1 FROM collisions WHERE uid=? AND digest=?',(row['id'],digest)).fetchone() is not None,'replay-payload-mismatch')
                if existing[0]==counts['indexed']+1:existing=None
            if existing:
                counts['duplicates']+=1
                if existing[1]!=digest:
                    counts['incompatibleDuplicates']+=1
                    if not replay:
                        c.execute('INSERT OR IGNORE INTO collisions VALUES (?,?,?)',(row['id'],existing[1],existing[2]));c.execute('INSERT OR IGNORE INTO collisions VALUES (?,?,?)',(row['id'],digest,payload))
                        c.execute('UPDATE products SET conflict=1,addable=0 WHERE id=?',(existing[0],))
            else:
                if not replay:c.execute('INSERT INTO products(uid,barcode,name,folded,frfold,brandfold,language,complete,addable,payload,digest) VALUES (?,?,?,?,?,?,?,?,?,?,?)',(row['id'],row['barcode'],row['name'],search_text(row['name']),search_text(row['nameFr']),search_text(row['brand']),row['language'],int(row['complete']),int(row['food'] is not None),payload,digest))
                counts['indexed']+=1;counts['fourMacros']+=row['complete'];counts['fourMacrosValid']+=row['complete'] and row['nutritionValuesValid'];counts['barcodeMissing']+=row['barcode'] is None
                category='technicallyAddableComplete' if row['food'] and row['complete'] else 'technicallyAddablePartial' if row['food'] else 'needsVerification';counts[category]+=1
                for key,value in [('languages',row['language']),('sourceKinds',row['sourceKind']),('licenses',(row['provenance'].get('license') or {}).get('id','unresolved'))]:increment(distributions[key],value)
                for key in ('issues','warnings'):
                    for value in row[key]:increment(distributions[key],value)
                if row['food'] and row['sourceKind'] not in samples:samples[row['sourceKind']]=row
            if counts['inputAccepted']%1000==0:
                c.commit();state=guard(root);min_mem=min(min_mem,state['availableMemoryBytes']);min_disk=min(min_disk,state['freeDiskBytes'])
                require(counts['incompatibleDuplicates']<=1000,'massive-identity-conflicts')
        require(header is not None and finish is not None,'interrupted-before-finish')
        require(finish.get('gzipCrcVerified') is True and finish.get('sourceHashVerified') is True and finish.get('scanned')==header['expectedRows'] and counts['inputAccepted']+finish.get('rejected',-1)==finish['scanned'],'invalid-end-receipt')
        require(c.execute('SELECT count(*) FROM products').fetchone()[0]==counts['indexed'],'replay-unverified-extra-rows')
        c.execute('INSERT OR REPLACE INTO meta VALUES (?,?)',('finish',canonical({'receipt':finish,'counts':counts,'distributions':distributions})));c.commit();state=guard(root)
        print(canonical({'event':'wger-generation-phase','phase':'indexing','rows':counts['indexed']}),file=sys.stderr,flush=True)
        # External-content FTS reads immutable table columns; no duplicate full
        # product body or fuzzy/trigram index is generated. SQLite spills to disk.
        guard_error=[];last_guard=time.monotonic()
        def progress():
            nonlocal last_guard,min_mem,min_disk
            if time.monotonic()-last_guard<.5:return 0
            last_guard=time.monotonic()
            try:
                state=guard(root);min_mem=min(min_mem,state['availableMemoryBytes']);min_disk=min(min_disk,state['freeDiskBytes']);return 0
            except CatalogError as error:guard_error.append(str(error));return 1
        c.set_progress_handler(progress,10000)
        if not replay:c.executescript('''CREATE INDEX barcode_idx ON products(barcode); CREATE INDEX language_idx ON products(language);
          CREATE VIRTUAL TABLE products_fts USING fts5(folded,frfold,brandfold,content='products',content_rowid='id',tokenize='unicode61 remove_diacritics 2',prefix='3 4');
          INSERT INTO products_fts(products_fts) VALUES ('rebuild');''')
        # Keep ranking heads in a compact covering B-tree. Payloads (including
        # long credits and Food snapshots) are fetched only for the final page.
        c.execute('CREATE INDEX IF NOT EXISTS search_rank_idx ON products(id,folded,frfold,brandfold,language,addable,complete,uid)')
        c.commit();guard(root)
        print(canonical({'event':'wger-generation-phase','phase':'integrity-checks'}),file=sys.stderr,flush=True)
        require(c.execute('PRAGMA integrity_check').fetchone()[0]=='ok','sqlite-integrity-failed')
        c.execute("INSERT INTO products_fts(products_fts,rank) VALUES ('integrity-check',1)");c.commit()
        c.set_progress_handler(None,0)
        print(canonical({'event':'wger-generation-phase','phase':'final-counts-and-sealing'}),file=sys.stderr,flush=True)
        require(c.execute('SELECT count(*) FROM products').fetchone()[0]==counts['indexed'],'index-count-mismatch')
        sizes=dict(c.execute('SELECT name,sum(pgsize) FROM dbstat GROUP BY name'))
        # Count conflicts from final state; never report stale pre-conflict eligibility.
        counts['technicallyAddableComplete']=c.execute('SELECT count(*) FROM products WHERE addable=1 AND complete=1 AND conflict=0').fetchone()[0]
        counts['technicallyAddablePartial']=c.execute('SELECT count(*) FROM products WHERE addable=1 AND complete=0 AND conflict=0').fetchone()[0]
        counts['needsVerification']=counts['indexed']-counts['technicallyAddableComplete']-counts['technicallyAddablePartial']
        counts['directlyAddable']=counts['technicallyAddableComplete']+counts['technicallyAddablePartial'] if header['registry']['verified'] else 0
        c.close();c=None
        with file.open('rb') as f:os.fsync(f.fileno())
        file.chmod(0o444);fsync_directory(root)
        manifest={'format':FORMAT,'version':1,'complete':True,'file':generation,'bytes':file.stat().st_size,'sha256':digest_file(file),'sourceSha256':header['sourceSha256'],'rows':counts['indexed'],'registryVerified':header['registry']['verified'],'publicationBlocked':True,'literalOnly':True}
        # Benchmark before the manifest switch: publication never masks a failed
        # integrity or representative-query check. Report marks provisional IDs.
        reader=Reader(root,manifest);search_report={}
        try:
            for query in QUERIES:
                elapsed=[];result=None
                for _ in range(15):
                    tick=time.perf_counter();result=reader.search(query);elapsed.append((time.perf_counter()-tick)*1000)
                elapsed.sort();search_report[query]={'count':result['count'],'addableOnPage':sum(bool(p['food']) for p in result['products']),'technicallyAddableOnPage':sum(bool(p['technicallyAddable']) for p in result['products']),'firstNames':[p['name'] for p in result['products'][:5]],'meanMs':sum(elapsed)/len(elapsed),'p95Ms':elapsed[-1]}
        finally:reader.close()
        report={'format':FORMAT,'version':1,'complete':True,'buildMode':'verified-source-replay' if replay else 'fresh','counts':counts,**distributions,'registry':header['registry'],'sourceSha256':header['sourceSha256'],'sourceBytes':header['sourceBytes'],'gzipCrcVerified':True,'bytes':manifest['bytes'],'ftsBytes':sum(v for k,v in sizes.items() if k.startswith('products_fts')),'indexBytes':sizes,'seconds':time.monotonic()-start,'pythonCpuSeconds':time.process_time()-cpu,'pythonPeakRssKiB':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,'node':finish,'minAvailableMemoryBytes':min_mem,'minFreeDiskBytes':min_disk,'finalResources':guard(root),'search':search_report,'samples':samples,'publicationBlocked':manifest['publicationBlocked'],'sqliteVersion':sqlite3.sqlite_version,'networkCalls':0}
        atomic_json(root,'report.json',report);manifest['reportSha256']=digest_file(root/'report.json');atomic_json(root,'current.json',manifest)
        return {key:value for key,value in report.items() if key not in ('samples','indexBytes','search','registry')}
    except BaseException:
        if c:c.close()
        # Keep forensic files; do not delete an old or partially written database.
        if not (root/'interrupted.json').exists():atomic_json(root,'interrupted.json',{'complete':False,'accepted':counts['inputAccepted'],'phase':'unsealed-import'})
        raise

class Reader:
    def __init__(self,root,manifest=None):
        self.root=root
        if manifest is None:
            file=root/'current.json';require(not file.is_symlink() and file.stat().st_size<=65536,'unsafe-manifest');manifest=parse_json(file.read_text())
        require(type(manifest) is dict and manifest.get('format')==FORMAT and manifest.get('version')==1 and manifest.get('complete') is True and manifest.get('literalOnly') is True and type(manifest.get('registryVerified')) is bool,'incompatible-manifest')
        require(re.fullmatch(r'catalog-[a-f0-9]{32}\.sqlite',manifest.get('file','')) is not None,'unsafe-generation')
        file=root/manifest['file'];require(not file.is_symlink() and file.stat().st_size==manifest['bytes']<=MAX_DB and digest_file(file)==manifest['sha256'],'corrupt-generation')
        self.manifest=manifest;self.c=sqlite3.connect(file.as_uri()+'?mode=ro&immutable=1',uri=True);self.c.execute('PRAGMA query_only=ON');self.c.execute('PRAGMA cache_size=-8192')
    def close(self):self.c.close()
    def present(self,payload,conflict):
        row=parse_json(payload);row['technicallyAddable']=row['food'] is not None and not conflict
        if not self.manifest['registryVerified'] or conflict:row['food']=None
        row['validationStatus']='validated' if row['food'] and row['complete'] else 'partial' if row['food'] else 'needs-verification'
        return row
    def search(self,query,page=1,page_size=20,language='fr',usable_only=False):
        require(type(page) is int and 1<=page<=50 and type(page_size) is int and 1<=page_size<=20 and type(language) is str and re.fullmatch(r'[a-z]{2}(?:-[a-z]{2})?',language),'invalid-pagination')
        match=literal_matches(query);folded=search_text(query);prefix=folded if len(folded.split()[-1])>=3 else folded+' '
        deadline=time.monotonic()+2;self.c.set_progress_handler(lambda:int(time.monotonic()>deadline),2000)
        try:
            require(type(usable_only) is bool,'invalid-search-mode')
            if usable_only and not self.manifest['registryVerified']:
                return {'products':[],'count':0,'page':page,'pageSize':page_size,'catalogueVersion':self.manifest['sha256'],'source':'wger','literalOnly':True,'registryVerified':False}
            eligible=' AND p.addable=1' if usable_only else ''
            count=self.c.execute('SELECT count(*) FROM products_fts JOIN products p INDEXED BY search_rank_idx ON p.id=products_fts.rowid WHERE products_fts MATCH ?'+eligible,(match,)).fetchone()[0] if usable_only else self.c.execute('SELECT count(*) FROM products_fts WHERE products_fts MATCH ?',(match,)).fetchone()[0]
            rows=self.c.execute('''WITH ranked AS MATERIALIZED (
              SELECT p.id,CASE WHEN ? IN (p.folded,p.frfold) THEN 3 WHEN substr(p.folded,1,?)=? OR substr(p.frfold,1,?)=? THEN 2 WHEN p.brandfold=? THEN 1 ELSE 0 END AS exact,
              (p.language=?) AS native,p.addable,p.complete,bm25(products_fts,4,6,2) AS score,p.uid
              FROM products_fts JOIN products p INDEXED BY search_rank_idx ON p.id=products_fts.rowid WHERE products_fts MATCH ?'''+eligible+'''
              ORDER BY exact DESC,p.addable DESC,p.complete DESC,native DESC,score,p.uid LIMIT ? OFFSET ?)
              SELECT p.payload,p.conflict FROM ranked JOIN products p ON p.id=ranked.id ORDER BY ranked.exact DESC,ranked.addable DESC,ranked.complete DESC,ranked.native DESC,ranked.score,ranked.uid''',(folded,len(prefix),prefix,len(prefix),prefix,folded,language,match,page_size,(page-1)*page_size)).fetchall()
            return {'products':[self.present(*r) for r in rows],'count':count,'page':page,'pageSize':page_size,'catalogueVersion':self.manifest['sha256'],'source':'wger','literalOnly':True,'registryVerified':self.manifest['registryVerified']}
        finally:self.c.set_progress_handler(None,0)
    def product(self,uid):
        require(type(uid) is str and re.fullmatch(r'wger:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}',uid),'invalid-product-id')
        row=self.c.execute('SELECT payload,conflict FROM products WHERE uid=?',(uid,)).fetchone();return self.present(*row) if row else None
    def barcode(self,code):
        require(type(code) is str and re.fullmatch(r'(?:\d{8}|\d{12,14})',code,re.ASCII),'invalid-barcode')
        rows=self.c.execute('SELECT payload,conflict FROM products WHERE barcode=? ORDER BY (language=\'fr\') DESC,addable DESC,uid LIMIT 20',(code,)).fetchall()
        return [self.present(*r) for r in rows]

def serve(root):
    reader=None
    try:
        for raw in iter(lambda:sys.stdin.buffer.readline(4097),b''):
            if len(raw)>4096 or not raw.endswith(b'\n'):return 2
            identity=None
            try:
                msg=parse_json(raw.decode('utf8'));require(type(msg) is dict and msg.keys()=={'v','id','op','args'} and msg['v']==1 and type(msg['id']) is int and 0<msg['id']<=2**53-1,'invalid-worker-request');identity=msg['id'];args=msg['args'];require(type(args) is dict,'invalid-worker-request')
                if reader is None:reader=Reader(root)
                if msg['op']=='search':
                    require(set(args) in ({'query','page','pageSize'},{'query','page','pageSize','language'}),'invalid-worker-arguments');value=reader.search(args['query'],args['page'],args['pageSize'],args.get('language','fr'))
                elif msg['op']=='product':require(args.keys()=={'uid'},'invalid-worker-arguments');value=reader.product(args['uid'])
                elif msg['op']=='barcode':require(args.keys()=={'code'},'invalid-worker-arguments');value=reader.barcode(args['code'])
                else:require(msg['op']=='inspect' and not args,'invalid-worker-operation');value=reader.manifest
                response={'v':1,'id':identity,'ok':True,'result':value};require(len(canonical(response).encode())<=256*1024,'response-too-large')
            except (CatalogError,OSError,sqlite3.Error,UnicodeError):response={'v':1,'id':identity,'ok':False,'error':'catalogue-unavailable-or-invalid-request'}
            print(canonical(response),flush=True)
    finally:
        if reader:reader.close()
    return 0

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('operation',choices=('build','serve','search'));p.add_argument('workspace');p.add_argument('--query',default='lait');p.add_argument('--replay',action='store_true');a=p.parse_args()
    resource.setrlimit(resource.RLIMIT_AS,(512*1024**2,512*1024**2))
    try:
        root=root_for(a.workspace)
        if a.operation=='build':print(canonical(build(root,sys.stdin.buffer,a.replay)))
        elif a.operation=='serve':sys.exit(serve(root))
        else:
            r=Reader(root)
            try:print(canonical(r.search(a.query)))
            finally:r.close()
    except (CatalogError,OSError,sqlite3.Error,MemoryError) as error:print(canonical({'error':str(error) if isinstance(error,CatalogError) else 'wger-generation-failed'}),file=sys.stderr);sys.exit(1)
