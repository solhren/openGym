"""Isolated assessment schema: UUID IDs, nullable GTIN, per-row provenance.
Reuses SQLite/FTS5 and existing Unicode folding; never an API catalogue generation.
"""
import contextlib
import hashlib
import json
from pathlib import Path
import re
import resource
import sqlite3
import sys
import time
from catalog import Catalog, BASE, resources, search_text, parse_json, require
QUERIES=('Nutella','Coca-Cola','lait','riz','pâtes','yaourt','œuf','banane','poulet')

def matches(query):
    require(type(query) is str and 2<=len(query)<=120,'invalid-query')
    tokens=search_text(query).split();require(1<=len(tokens)<=8 and all(1<=len(t)<=40 for t in tokens),'invalid-query')
    return ' AND '.join('"'+v+'"'+('*' if i==len(tokens)-1 and len(v)>=3 else '') for i,v in enumerate(tokens))

def search(c,query):
    match=matches(query);folded=search_text(query);prefix=folded if len(folded.split()[-1])>=3 else folded+' '
    deadline=time.monotonic()+.15;c.set_progress_handler(lambda:int(time.monotonic()>deadline),1000)
    try:
        return c.execute('''SELECT p.payload FROM products_fts JOIN products p ON p.id=products_fts.rowid
          WHERE products_fts MATCH ? ORDER BY
          CASE WHEN ? IN (p.folded,p.frfold) THEN 3 WHEN substr(p.folded,1,?)=? OR substr(p.frfold,1,?)=? THEN 2 WHEN p.brandfold=? THEN 1 ELSE 0 END DESC,p.addable DESC,p.complete DESC,(p.language='fr') DESC,
          bm25(products_fts,4.0,6.0,2.0),p.uid LIMIT 20''',(match,folded,len(prefix),prefix,len(prefix),prefix,folded)).fetchall()
    finally:c.set_progress_handler(None,0)

def benchmark(c):
    result={}
    for query in QUERIES:
        values=[];rows=[]
        for _ in range(30):
            start=time.perf_counter();rows=search(c,query);values.append((time.perf_counter()-start)*1000)
        products=[parse_json(r[0]) for r in rows];values.sort()
        result[query]={'countOnPage':len(products),'addableOnPage':sum(p['food'] is not None for p in products),'firstNames':[p['name'] for p in products[:3]],'meanMs':sum(values)/len(values),'p95Ms':values[28],'matchMode':'literal-only'}
    return result

def evaluate(root):
    require(root.parent.resolve()==BASE.resolve() and re.fullmatch(r'[A-Za-z0-9_-]{1,40}',root.name),'unsafe-eval-root')
    resources(root);file=root/'evaluation.sqlite';require(not file.exists(),'eval-exists')
    started=time.monotonic();counts={'rows':0,'directComplete':0,'directPartial':0,'unusable':0,'barcodeMissing':0};sources={};licenses={};reasons={};languages={}
    c=sqlite3.connect(file)
    try:
        c.executescript('''PRAGMA cache_size=-4096; PRAGMA max_page_count=65536; PRAGMA synchronous=FULL;
          CREATE TABLE products(id INTEGER PRIMARY KEY,uid TEXT UNIQUE,barcode TEXT,name TEXT,folded TEXT,frfold TEXT,brandfold TEXT,language TEXT,complete INTEGER,addable INTEGER,payload TEXT);
          CREATE INDEX barcode_idx ON products(barcode);
          CREATE VIRTUAL TABLE products_fts USING fts5(name,name_fr,brand,content='',tokenize='unicode61 remove_diacritics 2',prefix='3 4');''')
        with (root/'normalized.jsonl').open('rb') as source:
            for raw in source:
                require(len(raw)<=65536 and counts['rows']<2200,'eval-row-limit');row=parse_json(raw.decode('utf8'));counts['rows']+=1
                status='directComplete' if row['food'] and row['complete'] else 'directPartial' if row['food'] else 'unusable';counts[status]+=1
                language=row['language'] or 'unresolved';languages[language]=languages.get(language,0)+1
                counts['barcodeMissing']+=row['barcode'] is None;sources[row['sourceKind']]=sources.get(row['sourceKind'],0)+1
                lic=(row['provenance'].get('license') or {}).get('id','unresolved');licenses[lic]=licenses.get(lic,0)+1
                for reason in row['issues']:reasons[reason]=reasons.get(reason,0)+1
                c.execute('INSERT INTO products(uid,barcode,name,folded,frfold,brandfold,language,complete,addable,payload) VALUES (?,?,?,?,?,?,?,?,?,?)',(row['id'],row['barcode'],row['name'],search_text(row['name']),search_text(row['nameFr']),search_text(row['brand']),row['language'],int(row['complete']),int(row['food'] is not None),json.dumps(row,ensure_ascii=False)))
                key=c.execute('SELECT last_insert_rowid()').fetchone()[0];c.execute('INSERT INTO products_fts(rowid,name,name_fr,brand) VALUES (?,?,?,?)',(key,row['name'],row['nameFr'],row['brand']))
        c.commit();require(c.execute('PRAGMA integrity_check').fetchone()[0]=='ok','eval-corrupt')
        duration=time.monotonic()-started;c.execute('PRAGMA query_only=ON');results=benchmark(c)
        sizes=dict(c.execute('SELECT name,sum(pgsize) FROM dbstat GROUP BY name'))
        report={'fixtureOrReal':'see captured metadata, never infer from product names','counts':counts,'sourceKinds':sources,'languages':languages,'licenses':licenses,'reasons':reasons,'importSeconds':duration,'bytes':file.stat().st_size,'ftsBytes':sum(v for k,v in sizes.items() if k.startswith('products_fts')),'search':results,'peakRssKiB':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,'sqlite':sqlite3.sqlite_version,'fullWgerCoverageMeasured':False}
        (root/'sqlite-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));print(json.dumps(report,ensure_ascii=False))
    finally:c.close()

if __name__=='__main__':
    try:evaluate(BASE/sys.argv[1])
    except Exception as error:print(json.dumps({'error':type(error).__name__}),file=sys.stderr);sys.exit(1)
