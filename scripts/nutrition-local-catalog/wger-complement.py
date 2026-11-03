"""Small, separately sealed French search aliases over an immutable wger base.

No guessed nutrition: an alias identifies an existing complete, addable Food.
Snapshots keep their original source name and licence; labels are explicitly
curated translations, not manufacturer statements. No network or user storage.
"""
import argparse
import fcntl
import hashlib
import importlib.util
import os
from pathlib import Path
import re
import resource
import sqlite3
import sys
import time
import uuid
from catalog import canonical, digest_file, fsync_directory, parse_json, require, search_text

spec=importlib.util.spec_from_file_location('wger_base',Path(__file__).with_name('wger-generation.py'))
wger=importlib.util.module_from_spec(spec);spec.loader.exec_module(wger)
FORMAT='opengym-wger-french-complement'
MAX_BYTES=16*1024**2
MAX_ALIASES=1000

def read_manifest(root,name='current.json'):
    p=root/name
    require(not p.is_symlink() and p.stat().st_size<=4096,'unsafe-complement-manifest')
    value=parse_json(p.read_text())
    require(type(value) is dict and set(value)=={'format','version','file','bytes','sha256','baseSha256','rows','excludedRows','qualityRule','complete','publicationBlocked'},'invalid-complement-manifest')
    require(value['format']==FORMAT and type(value['version']) is int and value['version']==2 and value['complete'] is True and value['publicationBlocked'] is True,'incompatible-complement')
    require(value['qualityRule']=='zero-only-review-v1' and type(value['excludedRows']) is int and 0<=value['excludedRows']<=100000,'invalid-quality-audit')
    require(type(value['rows']) is int and 0<value['rows']<=MAX_ALIASES and type(value['bytes']) is int and 0<value['bytes']<=MAX_BYTES,'invalid-complement-size')
    require(all(type(value[k]) is str and re.fullmatch(r'[a-f0-9]{64}',value[k]) for k in ('sha256','baseSha256')),'invalid-complement-digest')
    require(type(value['file']) is str and re.fullmatch(r'aliases-[a-f0-9]{32}\.sqlite',value['file']),'unsafe-complement-generation')
    p=root/value['file'];require(not p.is_symlink() and p.stat().st_size==value['bytes'] and digest_file(p)==value['sha256'],'corrupt-complement')
    return value

def atomic(root,name,value):
    require(name in ('current.json','previous.json'),'unsafe-complement-output')
    tmp=root/(name+'.'+uuid.uuid4().hex+'.tmp')
    with tmp.open('x') as f:f.write(canonical(value));f.flush();os.fsync(f.fileno())
    os.replace(tmp,root/name);fsync_directory(root)

def check_workspace(root):
    wger.guard(root)
    require(sum(p.stat().st_size for p in root.iterdir() if p.is_file())<=64*1024**2,'complement-workspace-budget')

def build(base,root,config):
    """Publish only after source pin, semantic selectors and FTS integrity pass.
    Interrupted files are forensic, never current; no generation is deleted.
    """
    check_workspace(root)
    lock=root/'writer.lock';require(not lock.is_symlink(),'unsafe-complement-lock')
    with lock.open('a') as f:
        fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
        require(type(config) is dict and set(config)=={'baseSha256','aliases'} and config['baseSha256']==base.manifest['sha256'] and base.manifest['registryVerified'] is True,'complement-base-mismatch')
        rows=config['aliases'];require(type(rows) is list and 0<len(rows)<=MAX_ALIASES,'invalid-alias-count')
        old=read_manifest(root) if (root/'current.json').exists() else None
        if old:require(old['baseSha256']==base.manifest['sha256'],'complement-base-mismatch')
        file=root/('aliases-'+uuid.uuid4().hex+'.sqlite');c=sqlite3.connect(file)
        try:
            c.executescript('''PRAGMA page_size=4096;PRAGMA max_page_count=4096;PRAGMA cache_size=-2048;PRAGMA temp_store=FILE;PRAGMA journal_mode=DELETE;PRAGMA synchronous=FULL;
              CREATE TABLE aliases(id INTEGER PRIMARY KEY,uid TEXT NOT NULL UNIQUE,label TEXT NOT NULL,terms TEXT NOT NULL,originalName TEXT NOT NULL,baseDigest TEXT NOT NULL);
              CREATE TABLE exclusions(uid TEXT PRIMARY KEY,reason TEXT NOT NULL) WITHOUT ROWID;
              CREATE VIRTUAL TABLE aliases_fts USING fts5(label,terms,originalName,content='aliases',content_rowid='id',tokenize='unicode61 remove_diacritics 2',prefix='3 4');''')
            for row in rows:
                require(type(row) is dict and set(row)=={'uid','label','terms','expectedName'},'invalid-alias')
                require(all(type(row[k]) is str and 0<len(row[k])<=300 and not re.search(r'[\x00-\x1f\x7f]',row[k]) for k in row),'invalid-alias-text')
                original=base.product(row['uid'])
                require(original is not None and original['food'] is not None and original['complete'] and original['name']==row['expectedName'] and original['brand']=='' and original['sourceKind'] in ('usda','wger'),'alias-source-changed')
                food=original['food']
                require(food['reference']=={'amount':100,'unit':'g'} and all(type(food['nutrients'].get(k)) in (int,float) for k in ('kcal','protein','carbs','fat')) and any(food['nutrients'][k]>0 for k in ('kcal','protein','carbs','fat')),'alias-not-complete')
                source_digest=base.c.execute('SELECT digest FROM products WHERE uid=?',(row['uid'],)).fetchone()[0]
                c.execute('INSERT INTO aliases(uid,label,terms,originalName,baseDigest) VALUES(?,?,?,?,?)',(row['uid'],row['label'],row['terms'],row['expectedName'],source_digest))
            # wger's numeric zeros cannot distinguish an unknown imported value
            # from a genuinely zero food. Keep these identities, but require a
            # source review instead of asserting that four zeros prove nutrition.
            # Read only existing eligible payloads, spilling the small reject index
            # to disk. No rescan/reconstruction of the three-million-row payloads.
            excluded=0
            for i,(uid,raw) in enumerate(base.c.execute('SELECT uid,payload FROM products INDEXED BY search_rank_idx WHERE addable=1'),1):
                source=parse_json(raw);nutrients=source['food']['nutrients']
                if all(nutrients.get(k)==0 for k in ('kcal','protein','carbs','fat')):
                    c.execute('INSERT INTO exclusions VALUES(?,?)',(uid,'zero-only-nutrition-needs-verification'));excluded+=1
                    require(excluded<=100000,'quality-audit-budget')
                if i%1000==0:check_workspace(root)
            c.execute("INSERT INTO aliases_fts(aliases_fts) VALUES('rebuild')");c.execute("INSERT INTO aliases_fts(aliases_fts,rank) VALUES('integrity-check',1)");c.commit()
            require(c.execute('PRAGMA integrity_check').fetchone()[0]=='ok','complement-integrity-failed')
        finally:c.close()
        check_workspace(root)
        with file.open('rb') as f:os.fsync(f.fileno())
        file.chmod(0o444);fsync_directory(root)
        value={'format':FORMAT,'version':2,'file':file.name,'bytes':file.stat().st_size,'sha256':digest_file(file),'baseSha256':base.manifest['sha256'],'rows':len(rows),'excludedRows':excluded,'qualityRule':'zero-only-review-v1','complete':True,'publicationBlocked':True}
        if old:atomic(root,'previous.json',old)
        atomic(root,'current.json',value)
        return value

def rollback(base,root):
    check_workspace(root)
    lock=root/'writer.lock';require(not lock.is_symlink(),'unsafe-complement-lock')
    with lock.open('a') as f:
        fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
        value=read_manifest(root,'previous.json')
        require(value['baseSha256']==base.manifest['sha256'],'complement-base-mismatch')
        atomic(root,'current.json',value)
        return value

class Reader:
    """Pins two immutable files. A live reader cannot mix alias generations.
    Usable results are filtered BEFORE ranking; ambiguous OFF identities remain
    available by barcode/UUID but cannot displace usable search results.
    """
    def __init__(self,base,root=None):
        self.base=base;self.c=None;self.manifest=None
        require(root is not None,'verified-complement-required')
        if root is not None:
            value=read_manifest(root);require(value['baseSha256']==base.manifest['sha256'],'complement-base-mismatch')
            self.c=sqlite3.connect((root/value['file']).as_uri()+'?mode=ro&immutable=1',uri=True)
            try:
                self.c.execute('PRAGMA query_only=ON');self.c.execute('PRAGMA cache_size=-1024')
                require(self.c.execute('SELECT count(*) FROM aliases').fetchone()[0]==value['rows'],'complement-count-mismatch')
                require(self.c.execute('SELECT count(*) FROM exclusions').fetchone()[0]==value['excludedRows'],'complement-count-mismatch')
                # A copied/misbound index cannot relabel a different Food.
                for uid,name,digest in self.c.execute('SELECT uid,originalName,baseDigest FROM aliases'):
                    r=base.c.execute('SELECT name,digest,addable,conflict FROM products WHERE uid=?',(uid,)).fetchone()
                    require(r is not None and r==(name,digest,1,0) and base.manifest['registryVerified'],'alias-source-changed')
            except BaseException:self.c.close();self.c=None;raise
            self.manifest=value
            # URI mode=ro also applies to the attached database. No writable
            # handle or arbitrary client path is introduced by this join.
            base.c.execute('ATTACH DATABASE ? AS quality',((root/value['file']).as_uri()+'?mode=ro&immutable=1',))
        self.version=hashlib.sha256(canonical({'base':base.manifest['sha256'],'complement':self.manifest['sha256'] if self.manifest else None}).encode()).hexdigest()
    def close(self):
        if self.c:self.c.close()
        self.base.close()
    def product(self,uid):
        product=self.base.product(uid)
        if product and self.c:
            excluded=self.c.execute('SELECT reason FROM exclusions WHERE uid=?',(uid,)).fetchone()
            if excluded:
                product['food']=None;product['reference']=None;product['validationStatus']='needs-verification';product['issues']=[*product['issues'],excluded[0]]
            alias=self.c.execute('SELECT label FROM aliases WHERE uid=?',(uid,)).fetchone()
            if alias:
                product['originalName']=product['name'];product['name']=alias[0]
                product['translation']={'language':'fr','author':'openGym','status':'curated-search-label','originalName':product['originalName']}
        return product
    def barcode(self,code):
        return [self.product(r['id']) for r in self.base.barcode(code)]
    def search(self,query,page=1,page_size=20,language='fr'):
        # Validate pagination/tokens even for an empty base/alias result.
        require(type(page) is int and 1<=page<=20 and type(page_size) is int and 1<=page_size<=20 and type(language) is str and re.fullmatch(r'[a-z]{2}(?:-[a-z]{2})?',language),'invalid-pagination')
        match=wger.literal_matches(query);aliases=[]
        if self.c:
            deadline=time.monotonic()+.25;self.c.set_progress_handler(lambda:int(time.monotonic()>deadline),1000)
            try:
                aliases=self.c.execute('''SELECT a.uid FROM aliases_fts JOIN aliases a ON a.id=aliases_fts.rowid WHERE aliases_fts MATCH ?
                 ORDER BY (a.label=?) DESC,bm25(aliases_fts,8,4,1),a.uid LIMIT 1000''',(match,query)).fetchall()
            finally:self.c.set_progress_handler(None,0)
        heads=[uid for (uid,) in aliases]
        if not self.base.manifest['registryVerified']:heads=[]
        # Fetch only the requested page of UUID heads. Count and rank share a
        # single deadline; pagination never replays all preceding pages/payloads.
        exclusion=' AND p.uid NOT IN ('+','.join('?' for _ in heads)+')' if heads else ''
        where=' FROM products_fts JOIN products p INDEXED BY search_rank_idx ON p.id=products_fts.rowid WHERE products_fts MATCH ? AND p.addable=1 AND p.uid NOT IN (SELECT uid FROM quality.exclusions)'+exclusion
        deadline=time.monotonic()+2;self.base.c.set_progress_handler(lambda:int(time.monotonic()>deadline),2000)
        try:
            count=self.base.c.execute('SELECT count(*)'+where,(match,*heads)).fetchone()[0] if self.base.manifest['registryVerified'] else 0
            start=(page-1)*page_size;chosen=heads[start:start+page_size]
            if len(chosen)<page_size and count:
                folded=search_text(query)
                sql='SELECT p.uid'+where+' ORDER BY (? IN (p.folded,p.frfold)) DESC,(p.language=?) DESC,p.complete DESC,bm25(products_fts,4,6,2),p.uid LIMIT ? OFFSET ?'
                chosen.extend(uid for (uid,) in self.base.c.execute(sql,(match,*heads,folded,language,page_size-len(chosen),max(0,start-len(heads)))))
            products=[self.product(uid) for uid in chosen]
        finally:self.base.c.set_progress_handler(None,0)
        return {'products':products,'count':len(heads)+count,'page':page,'pageSize':page_size,'catalogueVersion':self.version,'source':'wger','literalOnly':True,'registryVerified':self.base.manifest['registryVerified']}

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('operation',choices=('build','rollback'));p.add_argument('--base',required=True);p.add_argument('--workspace',required=True);a=p.parse_args()
    resource.setrlimit(resource.RLIMIT_AS,(512*1024**2,512*1024**2))
    base=wger.Reader(wger.root_for(a.base));root=wger.root_for(a.workspace,exists=False);root.mkdir(exist_ok=True,mode=0o700)
    try:
        raw=sys.stdin.buffer.read(1024*1024+1) if a.operation=='build' else b'';require(len(raw)<=1024*1024,'oversized-curation')
        print(canonical(build(base,root,parse_json(raw)) if a.operation=='build' else rollback(base,root)))
    finally:base.close()
