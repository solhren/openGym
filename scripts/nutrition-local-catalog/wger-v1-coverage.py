"""Bounded real-generation comparison. Curated relevance is not market coverage.
Each case records identities, unit evidence and usable top results separately.
"""
import argparse
import importlib.util
import json
import math
from pathlib import Path
import resource
import time
from catalog import canonical,require
s=importlib.util.spec_from_file_location('wc',Path(__file__).with_name('wger-complement.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
GENERIC={'œufs':1,'riz':3,'pâtes':4,'lait':2,'yaourt':5,'fromage':8,'beurre':9,'poulet':6,'banane':0,'pomme':7,'légumes':10,'yaourt nature':5,'pâtes complètes':13,'huile d’olive':17,'carotte':11,'tomate':12,'épinards':19,'petits pois':20}
OTHERS=('Nutella','Coca-Cola','Nestlé','Bonne Maman','Carrefour','Auchan','Leclerc','Lidl','Intermarché','Aldi','lait demi-écrémé','riz basmati','pain de mie','lait d’amande')

def run(base_name,complement_name,output_name,repeats=10):
    root=m.wger.root_for(output_name,exists=False);require(not root.exists(),'output-exists');root.mkdir(mode=0o700);initial=m.wger.guard(root)
    require(type(repeats) is int and 3<=repeats<=20,'invalid-repeats')
    start=time.monotonic();cpu=time.process_time();tick=time.monotonic()
    base=m.wger.Reader(m.wger.root_for(base_name));hash_seconds=time.monotonic()-tick
    reader=m.Reader(base,m.wger.root_for(complement_name))
    config=json.loads(Path(__file__).with_name('wger-fr-curation.json').read_text());require(config['baseSha256']==base.manifest['sha256'],'curation-base-mismatch');uids=[a['uid'] for a in config['aliases']]
    cases=[]
    try:
        for q in (*GENERIC,*OTHERS):
            m.wger.guard(root);before_times=[];before=None
            for _ in range(repeats):
                tick=time.perf_counter();before=base.search(q);before_times.append((time.perf_counter()-tick)*1000)
            times=[];result=None
            for _ in range(repeats):
                tick=time.perf_counter();result=reader.search(q);times.append((time.perf_counter()-tick)*1000)
            expected=uids[GENERIC[q]] if q in GENERIC else None
            def summary(products):
                return [{'id':p['id'],'label':p['name'],'originalName':p.get('originalName',p['name']),'brand':p['brand'],'fourMacros':p['complete'],'reference':p['food']['reference'] if p['food'] else None,'addable':p['food'] is not None,'sourceKind':p['sourceKind'],'license':p['provenance']['license']['id'] if p['provenance']['license'] else None} for p in products[:5]]
            ordered=sorted(times)
            row={'query':q,'beforeCount':before['count'],'beforeAddableOnPage':sum(bool(p['food']) for p in before['products']),'beforeTop':summary(before['products']),'afterCount':result['count'],'afterAddableOnPage':sum(bool(p['food']) for p in result['products']),'afterTop':summary(result['products']),
                 'curatedExpectedUid':expected,'expectedInFirstFive':any(p['id']==expected for p in result['products'][:5]) if expected else None,'regionalSkuVerified':False if q in OTHERS else None,
                 'relevanceStatus':'generic-semantic-selector-qualified-not-market-survey' if expected else 'requires-human-product-and-market-review',
                 'beforeMeanMs':sum(before_times)/len(before_times),'beforeP95Ms':sorted(before_times)[math.ceil(.95*len(before_times))-1],
                 'meanMs':sum(times)/len(times),'p95Ms':ordered[math.ceil(.95*len(times))-1]}
            cases.append(row);print(canonical({'query':q,'usable':row['afterCount'],'expectedInFirstFive':row['expectedInFirstFive'],'p95Ms':row['p95Ms']}),flush=True)
        aliases=[reader.product(uid) for uid in uids]
        report={'complete':True,'baseSha256':base.manifest['sha256'],'complementSha256':reader.manifest['sha256'],'source':'complete real wger registered generation, not synthetic OFF data',
          'baseTechnicallyAddable':base.c.execute('SELECT count(*) FROM products WHERE addable=1 AND conflict=0').fetchone()[0],'zeroOnlyNeedsReview':reader.manifest['excludedRows'],
          'directlyAddable':base.c.execute('SELECT count(*) FROM products WHERE addable=1 AND conflict=0 AND uid NOT IN (SELECT uid FROM quality.exclusions)').fetchone()[0],'newNutritionalFoods':0,'curatedAliases':len(uids),'queryCount':len(cases),'curatedCases':len(GENERIC),'curatedMatchesInFirstFive':sum(c['expectedInFirstFive'] is True for c in cases),'national90PercentClaim':False,
          'startupBaseIntegritySeconds':hash_seconds,'elapsedSeconds':time.monotonic()-start,'cpuSeconds':time.process_time()-cpu,'pythonPeakRssKiB':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,'repeatsPerCase':repeats,'sqliteVersion':m.sqlite3.sqlite_version,'initialResources':initial,'finalResources':m.wger.guard(root),'networkCalls':0,'cases':cases,
          'selectedFoods':[{'id':p['id'],'label':p['name'],'food':p['food']} for p in aliases]}
        with (root/'coverage.json').open('x') as f:json.dump(report,f,ensure_ascii=False,indent=2)
        return report
    finally:reader.close()

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--base',required=True);p.add_argument('--complement',required=True);p.add_argument('--workspace',required=True);p.add_argument('--repeats',type=int,default=10);a=p.parse_args()
    resource.setrlimit(resource.RLIMIT_AS,(512*1024**2,512*1024**2))
    run(a.base,a.complement,a.workspace,a.repeats)
