"""Compare immutable catalogues; never generate fake real-product measurements."""
import argparse
import contextlib
import json
import math
import platform
import resource
import statistics
import time
from catalog import Catalog, CatalogError, workspace

parser=argparse.ArgumentParser()
parser.add_argument('--workspace',required=True)
parser.add_argument('--iterations',type=int,default=30)
args=parser.parse_args()
if not 1<=args.iterations<=100:parser.error('iterations 1..100')
queries=['Nutella','Coca-Cola','lait','riz','pâtes','yaourt','nutela','cocacola','pate tartiner','lait amande','yaort','chocolat noir','noir chocolat','Bovetti','boveti','pate tartinre']
start=time.perf_counter()
with contextlib.closing(Catalog(workspace(args.workspace,False))) as cat:
    cold=(time.perf_counter()-start)*1000
    report={'source':cat.manifest['source'],'fixture':cat.manifest['source']['kind']=='fixture','schemaVersion':cat.manifest['version'],'products':cat.manifest['products'],'databaseBytes':cat.manifest['bytes'],'openFullHashMs':cold,'iterations':args.iterations,'queries':{}}
    report['indexBytes']={k:v for k,v in cat.connection.execute('SELECT name,sum(pgsize) FROM dbstat GROUP BY name') if k.startswith('products_fts') or k.startswith('search_')}
    for query in queries:
        times=[];failures={};found=None
        for _ in range(args.iterations):
            start=time.perf_counter()
            try:found=cat.search(query)
            except CatalogError as error:failures[str(error)]=failures.get(str(error),0)+1
            times.append((time.perf_counter()-start)*1000)
        times.sort()
        report['queries'][query]={'meanMs':statistics.fmean(times),'p95Ms':times[math.ceil(len(times)*.95)-1],'errors':failures,'count':found['count'] if found else None,'matchMode':found.get('matchMode') if found else None,'firstNames':[r['nameFr'] or r['name'] for r in found['products'][:3]] if found else []}
    first=cat.connection.execute('SELECT code FROM products ORDER BY code LIMIT 1').fetchone()[0]
    times=[]
    for _ in range(args.iterations):
        start=time.perf_counter();cat.barcode(first);times.append((time.perf_counter()-start)*1000)
    report['barcode']={'meanMs':statistics.fmean(times),'p95Ms':sorted(times)[math.ceil(len(times)*.95)-1]}
report.update(python=platform.python_version(),sqlite=__import__('sqlite3').sqlite_version,platform=platform.platform(),peakRssKiB=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,cpuSeconds=resource.getrusage(resource.RUSAGE_SELF).ru_utime+resource.getrusage(resource.RUSAGE_SELF).ru_stime)
print(json.dumps(report,ensure_ascii=False,indent=2))
