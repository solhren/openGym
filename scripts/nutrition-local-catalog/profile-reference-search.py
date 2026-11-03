"""Read-only regression benchmark for the existing wger/OFF generations.

No cache flush, PRAGMA write, index rebuild, provider request or user data access.
--compare-legacy changes only the trusted reader's warmup SELECT in memory;
both search SQL and its two-second progress handler remain untouched.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import resource
import sqlite3
import sys
import time

CASES = ('Nutella', 'Coca-Cola', 'lait', 'riz', 'pâtes', 'yaourt')
OLD = 'SELECT count(*)FROM products INDEXED BY search_rank_idx'
NEW = 'SELECT count(id)FROM products INDEXED BY search_rank_idx'


def load(scripts, legacy=False):
    file = scripts / 'wger-off-reference.py'
    spec = importlib.util.spec_from_file_location('reference_profile', file)
    module = importlib.util.module_from_spec(spec)
    if legacy:
        source = file.read_text()
        if source.count(NEW) != 1:
            raise ValueError('Expected exactly one corrected warmup SELECT')
        exec(compile(source.replace(NEW, OLD), str(file), 'exec'), module.__dict__)
    else:
        spec.loader.exec_module(module)
    return module


def open_reader(module, args):
    base = module.quality.wger.Reader(module.quality.wger.root_for(args.base))
    try:
        quality = module.quality.Reader(base, module.quality.wger.root_for(args.quality))
        return module.Reader(quality, module.off.root(args.reference), module.off.root(args.index))
    except BaseException:
        base.close()
        raise


def fingerprint(module, result):
    return hashlib.sha256(module.canonical(result).encode()).hexdigest()


def measure(module, args):
    module.resources(module.off.BASE)
    start = time.monotonic()
    reader = open_reader(module, args)
    initialization_ms = (time.monotonic() - start) * 1000
    warm = [v for v in module.Reader.__init__.__code__.co_consts
            if isinstance(v, str) and 'FROM products INDEXED BY search_rank_idx' in v]
    if len(warm) != 1:
        reader.close()
        raise ValueError('Unexpected warmup implementation')
    report = {'initializationMs': initialization_ms, 'warmupQuery': warm[0],
              'warmupPlan': reader.base.c.execute('EXPLAIN QUERY PLAN ' + warm[0]).fetchall(),
              'existingIndexes': reader.base.c.execute("SELECT name,sql FROM sqlite_master WHERE type='index'AND tbl_name='products'").fetchall(),
              'queries': [], 'barcodes': [], 'catalogueVersion': reader.version}
    try:
        for query in CASES:
            module.resources(module.off.BASE)
            start = time.monotonic()
            try:
                result = reader.search(query)
                report['queries'].append({'query': query, 'milliseconds': (time.monotonic() - start) * 1000,
                                          'count': result['count'], 'returned': len(result['products']),
                                          'first': result['products'][0]['name'] if result['products'] else None,
                                          'fingerprint': fingerprint(module, result)})
            except (sqlite3.Error, module.quality.wger.CatalogError) as error:
                report['queries'].append({'query': query, 'milliseconds': (time.monotonic() - start) * 1000,
                                          'error': type(error).__name__, 'detail': str(error)})
        # Distinguish broad matching from the unique, paginated result count.
        match = module.quality.wger.literal_matches('lait')
        report['laitMatchCounts'] = {
            'wger': reader.base.c.execute('SELECT count(*) FROM products_fts WHERE products_fts MATCH ?', (match,)).fetchone()[0],
            'off': reader.base.c.execute('SELECT count(*) FROM certified.refs_fts WHERE refs_fts MATCH ?', (match,)).fetchone()[0]}
        traced = []
        reader.base.c.set_trace_callback(lambda sql: traced.append(sql) if sql.lstrip().startswith('WITH candidates AS') else None)
        try:
            page = reader.search('lait', 2)
            report['laitPage2'] = {'count': page['count'], 'returned': len(page['products']), 'fingerprint': fingerprint(module, page)}
        except sqlite3.Error as error:
            report['laitPage2'] = {'error': str(error)}
        finally:
            reader.base.c.set_trace_callback(None)
        if traced:
            report['searchPlan'] = reader.base.c.execute('EXPLAIN QUERY PLAN ' + traced[0]).fetchall()
        for code, unit in [('3017620422003', 'g'), ('5449000000996', 'ml')]:
            products = reader.barcode(code)
            usable = [v for v in products if v.get('food')]
            if not usable or usable[0]['food']['reference'] != {'amount': 100, 'unit': unit}:
                raise ValueError('Missing or unexpected barcode reference: ' + code)
            report['barcodes'].append({'code': code, 'unit': unit, 'fingerprint': fingerprint(module, products)})
        return report
    finally:
        reader.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--scripts', type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument('--compare-legacy', action='store_true')
    parser.add_argument('--base', default='wger-full-registered-20261025')
    parser.add_argument('--quality', default='wger-fr-quality-20261026')
    parser.add_argument('--reference', default='off-reference-full2-20261026')
    parser.add_argument('--index', default='wger-off-search-20261026')
    args = parser.parse_args()
    sys.path.insert(0, str(args.scripts))
    resource.setrlimit(resource.RLIMIT_AS, (512 * 1024**2, 512 * 1024**2))
    report = {'sqliteVersion': sqlite3.sqlite_version, 'sqlDeadlineSeconds': 2, 'externalFoodRequests': 0}
    cpu = time.process_time()
    if args.compare_legacy:
        report['legacy'] = measure(load(args.scripts, legacy=True), args)
    report['corrected'] = measure(load(args.scripts), args)
    plan = ' '.join(str(row[-1]) for row in report['corrected']['warmupPlan'])
    report['passed'] = 'search_rank_idx' in plan and all(
        'error' not in q and q['returned'] > 0 for q in report['corrected']['queries'])
    report['passed'] &= 'error' not in report['corrected']['laitPage2'] and report['corrected']['laitPage2']['returned'] > 0
    if 'legacy' in report:
        old = {v['query']: v for v in report['legacy']['queries']}
        comparisons = {v['query']: v['fingerprint'] == old[v['query']].get('fingerprint')
                       for v in report['corrected']['queries'] if 'error' not in v and 'error' not in old[v['query']]}
        report['sameResultsForCompletedQueries'] = comparisons
        report['sameBarcodeResults'] = report['legacy']['barcodes'] == report['corrected']['barcodes']
        if 'error' not in report['legacy']['laitPage2']:
            report['sameLaitPage2'] = report['legacy']['laitPage2'] == report['corrected']['laitPage2']
            report['passed'] &= report['sameLaitPage2']
        report['passed'] &= all(comparisons.values()) and report['sameBarcodeResults']
    report['cpuSeconds'] = time.process_time() - cpu
    report['peakRssKiB'] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    sys.exit(main())
