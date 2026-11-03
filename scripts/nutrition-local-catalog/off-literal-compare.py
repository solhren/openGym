"""Read-only existing OFF comparison. NO spelling fallback or provider request."""
import argparse
import contextlib
import json
import resource
import time
from catalog import Catalog,workspace,search_text
parser=argparse.ArgumentParser();parser.add_argument('--workspace',default='v1-tsv-5000');args=parser.parse_args()
with contextlib.closing(Catalog(workspace(args.workspace,False))) as cat:
    c=cat.connection;result={'workspace':args.workspace,'source':cat.manifest['source'],'products':cat.manifest['products'],'bytes':cat.manifest['bytes'],'search':{},'note':'real existing sample, not whole OFF; reference presence is not new independent source validation'}
    for query in ('Nutella','Coca-Cola','lait','riz','pâtes','yaourt','œuf','banane','poulet'):
        tokens=search_text(query).split();prefix=search_text(query) if len(tokens[-1])>=3 else search_text(query)+' ';match=' AND '.join('"'+t+'"'+('*' if i==len(tokens)-1 and len(t)>=3 else '') for i,t in enumerate(tokens));values=[]
        for _ in range(30):
            deadline=time.monotonic()+.15;c.set_progress_handler(lambda:int(time.monotonic()>deadline),1000);start=time.perf_counter()
            try:
                rows=c.execute('''SELECT p.* FROM products_fts JOIN products p ON p.id=products_fts.rowid WHERE products_fts MATCH ? ORDER BY
                  CASE WHEN ? IN(p.name_fold,p.name_fr_fold) THEN 3 WHEN substr(p.name_fold,1,?)=? OR substr(p.name_fr_fold,1,?)=? THEN 2 WHEN p.brand_fold=? THEN 1 ELSE 0 END DESC,((p.kcal IS NOT NULL)+(p.protein IS NOT NULL)+(p.carbs IS NOT NULL)+(p.fat IS NOT NULL)) DESC,bm25(products_fts,4.0,6.0,2.0),p.code LIMIT 20''',(match,search_text(query),len(prefix),prefix,len(prefix),prefix,search_text(query))).fetchall()
            finally:c.set_progress_handler(None,0)
            values.append((time.perf_counter()-start)*1000)
        decoded=[cat.record(r) for r in rows];values.sort();result['search'][query]={'countOnPage':len(rows),'referenceAndFourMacrosOnPage':sum(p['reference'] is not None and all(v is not None for v in p['nutrients'].values()) for p in decoded),'firstNames':[p['nameFr'] or p['name'] for p in decoded[:3]],'meanMs':sum(values)/len(values),'p95Ms':values[28],'matchMode':'literal-only'}
    result['peakRssKiB']=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
print(json.dumps(result,ensure_ascii=False,indent=2))
