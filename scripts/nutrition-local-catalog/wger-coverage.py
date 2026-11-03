"""Maintenance coverage report: distinguish matches from addable candidates.
All reads are local, parameterized and restricted to a sealed laboratory workspace.
Candidate Foods in this report are test fixtures, never an API bypass of registry
verification. Keep that qualification when using them in journal-proof tests.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import resource
import time
from catalog import parse_json,search_text
spec=importlib.util.spec_from_file_location('wger_generation',Path(__file__).with_name('wger-generation.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

def run(name):
    root=m.root_for(name);m.guard(root);reader=m.Reader(root);results={};proofs=[];barcodes={}
    try:
        for query in m.QUERIES:
            m.guard(root);match=m.literal_matches(query)
            deadline=time.monotonic()+2;reader.c.set_progress_handler(lambda:int(time.monotonic()>deadline),2000)
            try:
                counts=reader.c.execute('SELECT count(*),sum(p.addable=1) FROM products_fts JOIN products p INDEXED BY search_rank_idx ON p.id=products_fts.rowid WHERE products_fts MATCH ?',(match,)).fetchone()
                rows=reader.c.execute('SELECT p.id,p.uid FROM products_fts JOIN products p INDEXED BY search_rank_idx ON p.id=products_fts.rowid WHERE products_fts MATCH ? AND p.addable=1 ORDER BY (p.folded=?) DESC,p.uid LIMIT 3',(match,search_text(query))).fetchall()
            finally:reader.c.set_progress_handler(None,0)
            samples=[]
            for identity,uid in rows:
                p=parse_json(reader.c.execute('SELECT payload FROM products WHERE id=?',(identity,)).fetchone()[0]);food=p['food']
                samples.append({'id':uid,'name':p['name'],'language':p['language'],'sourceKind':p['sourceKind'],'reference':food['reference'],'nutrients':food['nutrients']})
                if query in ('Nutella','Coca-Cola','lait') and len(proofs)<3 and uid not in {v['id'] for v in proofs}:proofs.append(p)
            results[query]={'literalMatches':counts[0],'technicallyAddable':counts[1] or 0,'directlyExposed':(counts[1] or 0) if reader.manifest['registryVerified'] else 0,'samples':samples}
        for code in ('3017620422003','5449000000996','00000000'):
            values=[];rows=[]
            for _ in range(30):
                tick=time.perf_counter();rows=reader.barcode(code);values.append((time.perf_counter()-tick)*1000)
            values.sort();barcodes[code]={'variants':len(rows),'firstNames':[r['name'] for r in rows[:3]],'meanMs':sum(values)/len(values),'p95Ms':values[28]}
        deadline=time.monotonic()+10;reader.c.set_progress_handler(lambda:int(time.monotonic()>deadline),10000)
        try:languages=dict(reader.c.execute('SELECT language,count(*) FROM products INDEXED BY search_rank_idx WHERE addable=1 GROUP BY language'))
        finally:reader.c.set_progress_handler(None,0)
        report={'complete':True,'realRows':True,'sourceSha256':reader.manifest['sourceSha256'],'registryVerified':reader.manifest['registryVerified'],'publicationBlocked':True,'coverage':results,'barcode':barcodes,'technicalLanguages':languages,'proofFoods':proofs,'peakRssKiB':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,'networkCalls':0}
        with (root/'coverage.json').open('x') as f:json.dump(report,f,ensure_ascii=False,indent=2)
        return report
    finally:reader.close()

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('workspace');a=p.parse_args();print(json.dumps(run(a.workspace),ensure_ascii=False,indent=2))
