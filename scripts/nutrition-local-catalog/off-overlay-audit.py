"""Read-only wger/OFF identity audit and a prepared French coverage benchmark.
Writes only to a NEW analysis workspace; never imports an OFF dump or changes a
catalogue. Distinct identifiers live on disk rather than in a million-row set.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import resource
import sqlite3
import time
from urllib.parse import urlsplit
from catalog import BASE,parse_json,require,search_text
spec=importlib.util.spec_from_file_location('wger_generation',Path(__file__).with_name('wger-generation.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

GENERIC_CASES=(
 ('Banane mûre crue','bananas raw'),('Œuf de poule entier cru, sans coquille','egg whole raw'),
 ('Lait entier nature, quantité en g','milk whole'),('Riz blanc cru','rice white raw'),
 ('Pâtes de blé sèches','pasta dry'),('Yaourt nature au lait entier','yogurt plain'),
 ('Blanc de poulet cru sans peau','chicken breast raw'))
BRANDS=('Nutella','Coca-Cola','Carrefour','Auchan','Danone','Lactel','Panzani','Taureau Ailé','Bonne Maman')

def gtin_valid(code):
    if type(code) is not str or not re.fullmatch(r'(?:\d{8}|\d{12,14})',code,re.ASCII) or not code.strip('0'):return False
    return sum(int(v)*(3 if i%2==0 else 1) for i,v in enumerate(reversed(code[:-1])))%10 == (10-int(code[-1]))%10

def canonical(code):
    # GS1 fixed-length representation is an alias, never replacement of source.
    return code.zfill(14) if gtin_valid(code) else 'exact:'+code

def source_code(url):
    if type(url) is not str:return None
    try:u=urlsplit(url)
    except ValueError:return None
    if u.scheme not in ('http','https') or u.username or u.password or not (u.hostname=='openfoodfacts.org' or (u.hostname or '').endswith('.openfoodfacts.org')):return None
    match=re.fullmatch(r'/api/v[123](?:\.5)?/product/(\d+)(?:\.json)?/?',u.path)
    return match[1] if match else None

def run(base_name,output_name):
    root=m.root_for(output_name,exists=False);require(not root.exists(),'analysis-workspace-exists');m.guard(BASE);root.mkdir(mode=0o700)
    reader=m.Reader(m.root_for(base_name));start=time.monotonic();cpu=time.process_time();db=root/'targets.sqlite'
    c=sqlite3.connect(db);c.executescript('PRAGMA cache_size=-8192;PRAGMA temp_store=FILE;PRAGMA max_page_count=65536;PRAGMA synchronous=FULL;CREATE TABLE codes(code TEXT PRIMARY KEY,canonical TEXT NOT NULL,refs INTEGER NOT NULL);')
    counts={k:0 for k in ('frenchRows','offRows','missingStoredBarcode','placeholderBarcode','checksumInvalid','leadingZeros','sourceUrlMissing','sourceUrlExact','sourceUrlEquivalent','sourceUrlMismatch','targetRows')}
    try:
        for (raw,) in reader.c.execute("SELECT payload FROM products WHERE language='fr'"):
            p=parse_json(raw);counts['frenchRows']+=1
            if counts['frenchRows']%5000==0:c.commit();m.guard(root)
            if p['sourceKind']!='off-derived':continue
            counts['offRows']+=1;code=p['barcode'];url_code=source_code(p['provenance'].get('sourceUrl'))
            if code is None:counts['missingStoredBarcode']+=1;continue
            if not code.strip('0'):counts['placeholderBarcode']+=1;continue
            counts['leadingZeros']+=code.startswith('0');counts['checksumInvalid']+=not gtin_valid(code)
            if url_code is None:counts['sourceUrlMissing']+=1
            elif code==url_code:counts['sourceUrlExact']+=1
            elif gtin_valid(url_code) and canonical(code)==canonical(url_code):counts['sourceUrlEquivalent']+=1
            else:counts['sourceUrlMismatch']+=1;continue
            c.execute('INSERT INTO codes VALUES(?,?,1) ON CONFLICT(code) DO UPDATE SET refs=refs+1',(code,canonical(code)));counts['targetRows']+=1
        c.commit();m.guard(root);c.execute('CREATE INDEX canonical_idx ON codes(canonical)');c.commit()
        counts['distinctExactCodes']=c.execute('SELECT count(*) FROM codes').fetchone()[0]
        counts['distinctCanonicalCodes']=c.execute('SELECT count(DISTINCT canonical) FROM codes').fetchone()[0]
        counts['repeatedExactCodes']=c.execute('SELECT count(*) FROM codes WHERE refs>1').fetchone()[0]
        counts['canonicalAliasGroups']=c.execute('SELECT count(*) FROM (SELECT canonical FROM codes GROUP BY canonical HAVING count(*)>1)').fetchone()[0]
        generic=[]
        for label,query in GENERIC_CASES:
            match=m.literal_matches(query)
            deadline=time.monotonic()+3;reader.c.set_progress_handler(lambda:int(time.monotonic()>deadline),2000)
            try:
                ids=reader.c.execute('''SELECT p.id FROM products_fts JOIN products p INDEXED BY search_rank_idx ON p.id=products_fts.rowid WHERE products_fts MATCH ? AND p.addable=1
                  ORDER BY (p.brandfold='') DESC,bm25(products_fts,4,6,2),p.uid LIMIT 8''',(match,)).fetchall()
            finally:reader.c.set_progress_handler(None,0)
            candidates=[]
            for (identity,) in ids:
                p=parse_json(reader.c.execute('SELECT payload FROM products WHERE id=?',(identity,)).fetchone()[0])
                candidates.append({key:p[key] for key in ('id','name','brand','language','sourceKind','provenance','food')})
            generic.append({'frenchLabel':label,'sourceQuery':query,'reviewStatus':'requires-human-semantic-review','candidates':candidates})
        brands=[]
        for query in BRANDS:
            result=reader.search(query);brands.append({'query':query,'matches':result['count'],'usableOnPage':sum(p['food'] is not None for p in result['products']),'reviewStatus':'not-a-verified-relevance-score','candidates':[{'id':p['id'],'code':p['barcode'],'name':p['name'],'brand':p['brand'],'validationStatus':p['validationStatus']} for p in result['products'][:5]]})
        report={'complete':True,'source':'wger registered generation, no OFF raw dump available','baseSha256':reader.manifest['sha256'],'counts':counts,'genericBenchmark':generic,'brandBenchmark':brands,'rawOffReferenceCoverageMeasured':False,'networkCalls':0,'seconds':time.monotonic()-start,'cpuSeconds':time.process_time()-cpu,'peakRssKiB':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,'targetIndexBytes':db.stat().st_size,'resources':m.guard(root)}
        with (root/'report.json').open('x') as f:json.dump(report,f,ensure_ascii=False,indent=2);f.flush();os.fsync(f.fileno())
        return report
    finally:c.close();reader.close()

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--base',default='wger-full-registered-20261025');p.add_argument('--workspace',required=True);a=p.parse_args()
    resource.setrlimit(resource.RLIMIT_AS,(512*1024**2,512*1024**2))
    r=run(a.base,a.workspace);print(json.dumps({k:v for k,v in r.items() if k not in ('genericBenchmark','brandBenchmark')},ensure_ascii=False,indent=2))
