"""Reproducible old/new ranking comparison on immutable laboratory copies.

Baseline is diagnostics only: it may read an unsealed failed-import database but
never claims that database is fit for publication. No cache flush, no write SQL.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import resource
import sqlite3
import time
from catalog import parse_json,search_text,require
spec=importlib.util.spec_from_file_location('wger_generation',Path(__file__).with_name('wger-generation.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

def baseline(c,query):
    folded=search_text(query);prefix=folded if len(folded.split()[-1])>=3 else folded+' ';match=m.literal_matches(query)
    deadline=time.monotonic()+2;c.set_progress_handler(lambda:int(time.monotonic()>deadline),2000)
    try:
        count=c.execute('SELECT count(*) FROM products_fts WHERE products_fts MATCH ?',(match,)).fetchone()[0]
        rows=c.execute('''SELECT p.payload,p.conflict FROM products_fts JOIN products p ON p.id=products_fts.rowid WHERE products_fts MATCH ?
          ORDER BY CASE WHEN ? IN (p.folded,p.frfold) THEN 3 WHEN substr(p.folded,1,?)=? OR substr(p.frfold,1,?)=? THEN 2 WHEN p.brandfold=? THEN 1 ELSE 0 END DESC,
          (p.language='fr') DESC,p.addable DESC,p.complete DESC,bm25(products_fts,4,6,2),p.uid LIMIT 20''',(match,folded,len(prefix),prefix,len(prefix),prefix,folded)).fetchall()
        return {'count':count,'products':[parse_json(v[0]) for v in rows]}
    finally:c.set_progress_handler(None,0)

def run(workspace,mode):
    root=m.root_for(workspace);m.guard(root);start=time.monotonic();cpu=time.process_time()
    if mode=='baseline':
        files=list(root.glob('catalog-*.sqlite'));require(len(files)==1 and not files[0].is_symlink(),'invalid-benchmark-file')
        c=sqlite3.connect(files[0].as_uri()+'?mode=ro&immutable=1',uri=True);c.execute('PRAGMA query_only=ON');c.execute('PRAGMA cache_size=-8192');read=lambda q:baseline(c,q)
        source=parse_json(c.execute("SELECT value FROM meta WHERE key='header'").fetchone()[0])['sourceSha256'];close=c.close
    else:
        reader=m.Reader(root);source=reader.manifest['sourceSha256'];read=reader.search;close=reader.close
    results={}
    try:
        for query in m.QUERIES:
            elapsed=[];result=None;error=None
            for _ in range(15):
                m.guard(root);tick=time.perf_counter()
                try:result=read(query)
                except sqlite3.Error as problem:error=getattr(problem,'sqlite_errorname','sqlite-error');elapsed.append((time.perf_counter()-tick)*1000);break
                elapsed.append((time.perf_counter()-tick)*1000)
            elapsed.sort();results[query]={'completed':error is None,'error':error,'attempts':len(elapsed),'meanMs':sum(elapsed)/len(elapsed),'p95Ms':elapsed[-1],'count':result['count'] if result else None,'firstNames':[p['name'] for p in result['products'][:3]] if result else []}
    finally:close()
    report={'mode':mode,'realRows':True,'sourceSha256':source,'cache':'warm iterations, first included; OS cache uncontrolled, no global flush','deadlineMs':2000,'search':results,'seconds':time.monotonic()-start,'cpuSeconds':time.process_time()-cpu,'peakRssKiB':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss}
    with (root/('rank-'+mode+'.json')).open('x') as f:json.dump(report,f,ensure_ascii=False,indent=2)
    return report

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('workspace');p.add_argument('--mode',choices=('baseline','optimized'),required=True);args=p.parse_args();print(json.dumps(run(args.workspace,args.mode),ensure_ascii=False,indent=2))
