"""Warm-cache CLI benchmark; pins one validated read-only generation. No network."""
import argparse
import contextlib
import json
import math
from concurrent.futures import ThreadPoolExecutor
import platform
import resource
import statistics
import time
from catalog import Catalog, workspace

parser = argparse.ArgumentParser()
parser.add_argument('--workspace', default='trial')
parser.add_argument('--iterations', type=int, default=100)
parser.add_argument('--readers', type=int, default=1)
args = parser.parse_args()
if not 1 <= args.iterations <= 1000:
    parser.error('iterations 1..1000')
if not 1 <= args.readers <= 4:
    parser.error('readers 1..4')

def summary(values):
    values.sort()
    return {'meanMs': statistics.fmean(values), 'medianMs': statistics.median(values), 'p95Ms': values[math.ceil(len(values)*.95)-1], 'maxMs': max(values)}

def measured(action):
    values = []
    for _ in range(args.iterations):
        start = time.perf_counter_ns()
        action()
        values.append((time.perf_counter_ns() - start) / 1e6)
    return summary(values)

start = time.perf_counter()
with contextlib.closing(Catalog(workspace(args.workspace, create=False))) as catalogue:
    verification = time.perf_counter() - start
    searches = {}
    for query in ('Nutella', 'Coca-Cola', 'lait', 'riz', 'pâtes', 'yaourt', 'pates', 'Panzani', 'lait demi ecreme'):
        sample = catalogue.search(query)
        searches[query] = {**measured(lambda: catalogue.search(query)), 'firstNames': [p['nameFr'] or p['name'] for p in sample['products'][:3]], 'completeOnPage': sum(all(v is not None for v in p['nutrients'].values()) for p in sample['products'])}
    first = catalogue.search('lait')['products'][0]['code']
    result = {'fixture': catalogue.manifest['source']['kind'] == 'fixture', 'products': catalogue.manifest['products'], 'databaseBytes': catalogue.manifest['bytes'], 'openFullHashVerificationMs': verification*1000, 'search': searches, 'barcode': measured(lambda: catalogue.barcode(first)), 'paginationPage20': measured(lambda: catalogue.search('lait', page=20)), 'iterations': args.iterations,
              'platform': platform.platform(), 'python': platform.python_version()}
if args.readers > 1:
    def worker(_):
        with contextlib.closing(Catalog(workspace(args.workspace, create=False))) as reader:
            values = []
            for i in range(args.iterations):
                start = time.perf_counter_ns()
                reader.search(('nutella', 'lait', 'pates')[i % 3])
                values.append((time.perf_counter_ns()-start)/1e6)
            return values
    start = time.perf_counter()
    with ThreadPoolExecutor(max_workers=args.readers) as pool:
        values = [v for batch in pool.map(worker, range(args.readers)) for v in batch]
    duration = time.perf_counter()-start
    result['concurrentReaders'] = {'readers': args.readers, 'queries': len(values), 'secondsIncludingOpens': duration, 'queriesPerSecondIncludingOpens': len(values)/duration, **summary(values)}
result.update(peakRssKiB=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss, cpuSeconds=resource.getrusage(resource.RUSAGE_SELF).ru_utime + resource.getrusage(resource.RUSAGE_SELF).ru_stime)
print(json.dumps(result, ensure_ascii=False, indent=2))
