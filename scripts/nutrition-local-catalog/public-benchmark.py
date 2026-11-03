"""Freeze independent public product cases, then evaluate without cherry-picking.
Product titles are NOT user search logs or human relevance judgements. Exact
barcode retrieval and addability are measured; semantic precision needs labels.
No source/fixture is installed in the application by this maintenance tool.
"""
import argparse
import collections
import csv
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import re
import resource
import sqlite3
import time
from catalog import BASE,CatalogError,canonical,digest_file,parse_json,require,resources,search_text

def load_module(name,file):
    s=importlib.util.spec_from_file_location(name,Path(__file__).with_name(file));m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
ids=load_module('identity','off-overlay-audit.py')
samples=load_module('public_capture','public-benchmark-sample.py')

def root(name,exists=True):
    require(type(name) is str and re.fullmatch(r'[A-Za-z0-9_-]{1,40}',name) and not BASE.is_symlink(),'unsafe-workspace')
    result=BASE/name;require(not result.is_symlink() and (result.is_dir() if exists else not result.exists()),'unsafe-workspace');return result

def checked_file(folder,name,amount,sha):
    file=folder/name
    require(not file.is_symlink() and type(amount) is int and 0<amount<=64*1024**2 and file.stat().st_size==amount and type(sha) is str and re.fullmatch('[a-f0-9]{64}',sha) and digest_file(file)==sha,'corrupt-source-capture')
    return file

def source_rows(name):
    folder=root(name);file=folder/'sample-manifest.json';require(not file.is_symlink() and file.stat().st_size<=65536,'unsafe-source-manifest');manifest=parse_json(file.read_text());require(manifest.get('complete') is True,'incomplete-source')
    if manifest.get('format')=='opengym-public-price-projection':
        require(manifest.get('version')==1 and manifest.get('dataset')=='openfoodfacts/open-prices' and manifest.get('source')=='prices-fr-parquet' and manifest.get('selectedUsingCatalogueResults') is False,'invalid-parquet-projection')
        require(manifest.get('projectionFile')=='projection.jsonl' and type(manifest.get('rows')) is int and 1<=manifest['rows']<=2000 and type(manifest.get('eligibleUniqueProducts')) is int and manifest['eligibleUniqueProducts']>=manifest['rows'],'invalid-parquet-projection')
        require(type(manifest.get('requestedCases')) is int and manifest['rows']<=manifest['requestedCases']<=2000 and type(manifest.get('seed')) is str and re.fullmatch(r'[A-Za-z0-9_-]{1,80}',manifest['seed']) and type(manifest.get('inputSha256')) is str and re.fullmatch('[a-f0-9]{64}',manifest['inputSha256']),'invalid-parquet-projection')
        require(type(manifest.get('counts')) is dict and type(manifest['counts'].get('sourceRows')) is int and manifest['eligibleUniqueProducts']<=manifest['counts']['sourceRows']<=2000000 and type(manifest.get('unresolvedUniqueTitles')) is int and 0<=manifest['unresolvedUniqueTitles']<=manifest['eligibleUniqueProducts'],'invalid-parquet-projection')
        data=checked_file(folder,'projection.jsonl',manifest['projectionBytes'],manifest['projectionSha256'])
        def rows():
            count=0;seen=set()
            with data.open(encoding='utf8') as stream:
                for line in stream:
                    require(len(line)<=8192,'invalid-price-projection-row');r=parse_json(line);count+=1
                    require(type(r) is dict and r.get('france') is True and type(r.get('sourceId')) is str and re.fullmatch(r'\d{1,19}',r['sourceId']) and (r.get('code') is None or type(r['code']) is str and re.fullmatch(r'(?:\d{8}|\d{12,14})',r['code'],re.ASCII)),'invalid-price-projection-row')
                    key=ids.canonical(r['code']) if r['code'] else 'raw:'+r['sourceId']
                    require(key==r.get('identityKey') and key not in seen and count<=manifest['rows'],'invalid-price-projection-identity');seen.add(key)
                    require(r.get('name') is None or type(r['name']) is str and len(r['name'])<=300,'invalid-price-projection-name')
                    yield r
            require(count==manifest['rows'],'incomplete-price-projection')
        return rows(),{'source':'openfoodfacts/open-prices','capture':name,'sourceManifestSha256':digest_file(file),'inputSha256':manifest['inputSha256'],'inputRows':manifest['counts']['sourceRows'],'seed':manifest['seed'],'projectionRequestedCases':manifest['requestedCases'],'eligibleUniqueProducts':manifest['eligibleUniqueProducts'],'frenchCensus':manifest['counts'],'unresolvedUniqueTitles':manifest['unresolvedUniqueTitles'],'samplingLimit':manifest['samplingLimit'],'sourceIsQueryLog':False,'license':manifest['license'],'fixture':manifest.get('fixture') is True}
    if manifest.get('format')=='opengym-off-tsv-sample':
        data=checked_file(folder,'sample.tsv',manifest['sampleBytes'],manifest['sampleSha256'])
        require(manifest.get('source')=='https://static.openfoodfacts.org/data/en.openfoodfacts.org.products.csv.gz' and type(manifest.get('rows')) is int and manifest['rows']<=50000,'invalid-tsv-capture')
        def rows():
            csv.field_size_limit(1024*1024);count=0
            with data.open(newline='',encoding='utf8') as f:
                reader=csv.DictReader(f,delimiter='\t');require({'code','product_name','brands','countries_tags'}<=set(reader.fieldnames),'incompatible-tsv')
                for i,row in enumerate(reader):
                    count+=1;require(count<=50000 and None not in row,'invalid-tsv-row')
                    yield {'sourceId':str(i),'code':row.get('code'),'name':row.get('product_name'),'brand':row.get('brands'),'france':'en:france' in (row.get('countries_tags') or '').split(','),'category':None}
            require(count==manifest['rows'],'incomplete-tsv-capture')
        return rows(),{'source':'Open Food Facts official TSV prefix','capture':name,'sourceManifestSha256':digest_file(file),'inputSha256':manifest['sampleSha256'],'inputRows':manifest['rows'],'samplingLimit':f"first {manifest['rows']} source rows; NOT a representative French market sample",'sourceIsQueryLog':False,'license':'ODbL-1.0 / DbCL-1.0','fixture':manifest.get('fixture') is True}
    require(manifest.get('format')=='opengym-public-benchmark-capture' and manifest.get('source') in samples.SOURCES,'unsupported-source-capture')
    require(type(manifest.get('pages')) is list and 0<len(manifest['pages'])<=20,'invalid-public-capture')
    pages=[];total=0
    for page in manifest['pages']:
        require(type(page) is dict and re.fullmatch(r'page-\d{3}\.json',page.get('file','')),'unsafe-page')
        data=checked_file(folder,page['file'],page['bytes'],page['sha256']);total+=data.stat().st_size;require(total<=samples.MAX_TOTAL,'source-budget')
        pages.append(data)
    def rows():
        seen=set()
        for file in pages:
            value=samples.envelope(file.read_bytes(),manifest['source'],allow_empty=manifest['source']=='off-labels')
            for item in value['rows']:
                row=item['row'];identity=row.get('code') if manifest['source']=='off-labels' else item['row_idx']
                require(identity is not None and identity not in seen,'duplicate-source-row');seen.add(identity)
                if manifest['source']=='prices-fr':
                    yield {'sourceId':str(row.get('id')),'code':row.get('product_code'),'name':row.get('product_name'),'brand':None,'france':row.get('location_osm_address_country_code')=='FR','category':row.get('category_tag')}
                else:
                    names=row.get('product_name');localized={}
                    require(names is None or type(names) is list,'invalid-off-name')
                    for v in names or []:
                        require(type(v) is dict and type(v.get('lang')) is str and type(v.get('text')) is str and v['lang'] not in localized,'invalid-off-name');localized[v['lang']]=v['text']
                    name=localized.get('fr') or (localized.get('main') if row.get('lang')=='fr' else None)
                    yield {'sourceId':row.get('code'),'code':row.get('code'),'name':name,'brand':row.get('brands'),'france':type(row.get('countries_tags')) is list and 'en:france' in row['countries_tags'],'category':None}
        require(len(seen)==manifest.get('rows'),'incomplete-public-capture')
    limitation='exact-code projection of frozen public price cases; missing labels retained, no catalogue-hit selection' if manifest['source']=='off-labels' else 'seeded slices of public contributors, not a purchase panel; row population can change between HTTP pages'
    return rows(),{'source':manifest['dataset'],'capture':name,'sourceManifestSha256':digest_file(file),'inputRows':manifest['rows'],'seed':manifest['seed'],'samplingLimit':limitation,'sourceIsQueryLog':False,'license':manifest['license'],'fixture':manifest.get('fixture') is True}

def prepare(source,output,maximum=1000,seed='opengym-public-v1',labels=None):
    require(type(maximum) is int and 100<=maximum<=2000 and type(seed) is str and re.fullmatch(r'[A-Za-z0-9_-]{1,80}',seed),'invalid-benchmark-budget')
    destination=root(output,False);resources(BASE)
    rows,info=source_rows(source);label_map={};label_info=None
    if 'projectionRequestedCases' in info:
        require(seed==info['seed'] and maximum<=info['projectionRequestedCases'],'parquet-projection-seed-or-size-mismatch')
    if labels:
        values,label_info=source_rows(labels)
        for r in values:
            if type(r.get('code')) is str and type(r.get('name')) is str and r['name'].strip():
                key=ids.canonical(r['code']);label_map.setdefault(key,set()).add(r['name'].strip())
    records={};counts=collections.Counter()
    for r in rows:
        counts['sourceRows']+=1;require(counts['sourceRows']<=50000,'source-row-budget')
        if not r['france']:counts['outsideFrenchEvidence']+=1;continue
        code=r['code'] if type(r['code']) is str and re.fullmatch(r'(?:\d{8}|\d{12,14})',r['code'],re.ASCII) else None
        key=ids.canonical(code) if code else 'raw:'+str(r['sourceId'])
        if key in records:counts['duplicateProductObservations']+=1;continue
        name=r.get('name');name=name.strip() if type(name) is str and len(name)<=300 and not re.search(r'[\x00-\x1f\x7f]',name) else None
        query_origin='source-product-title'
        if not name and code:
            values=label_map.get(key,set())
            if len(values)==1:name=next(iter(values));query_origin='independent-off-label-join'
            elif len(values)>1:counts['conflictingLabels']+=1
        brand=r['brand'] if type(r.get('brand')) is str and len(r['brand'])<=300 else ''
        if not name:counts['missingQueryLabel']+=1
        # No user IDs, receipt paths/images, coordinates or prices are retained.
        case={'key':key,'expectedCode':code,'query':name,'brand':brand,'queryOrigin':query_origin,'category':r.get('category') if type(r.get('category')) is str and len(r['category'])<=300 else None}
        case['caseId']=hashlib.sha256((seed+'\0'+key).encode()).hexdigest();records[key]=case
    # Freeze selection before evaluating either catalogue or any relevance result.
    selected=sorted(records.values(),key=lambda r:r['caseId'])[:maximum]
    require(selected,'no-public-cases');destination.mkdir(mode=0o700)
    for case in selected:
        # Titles with the same normalized query share the same split. These are
        # product-title tests, never relabelled as real French search queries.
        grouping=search_text(case['query']) if case['query'] else case['key']
        bucket=int(hashlib.sha256((seed+'\0'+grouping).encode()).hexdigest()[:8],16)%10
        case['split']='test' if bucket<2 else 'validation' if bucket<4 else 'development'
    file=destination/'cases.jsonl'
    with file.open('x') as f:
        for r in selected:f.write(canonical(r)+'\n')
    manifest={'format':'opengym-public-search-benchmark','version':1,'complete':True,'source':info,'labelSource':label_info,'seed':seed,'requestedCases':maximum,'cases':len(selected),'eligibleUniqueProducts':info.get('eligibleUniqueProducts',len(records)),'sourceCounts':dict(counts),'casesSha256':digest_file(file),'sourceIsQueryLog':False,'humanRelevanceJudgements':False,'selectedUsingCatalogueResults':False,'national90PercentClaim':False,'splits':dict(collections.Counter(r['split'] for r in selected))}
    with (destination/'benchmark.json').open('x') as f:f.write(canonical(manifest))
    return manifest

def evaluate(benchmark,base,complement,output,seconds=300):
    require(type(seconds) is int and 30<=seconds<=600,'invalid-evaluation-budget')
    source=root(benchmark);manifest=parse_json((source/'benchmark.json').read_text());require(manifest.get('format')=='opengym-public-search-benchmark' and manifest.get('complete') is True,'invalid-benchmark')
    file=checked_file(source,'cases.jsonl',(source/'cases.jsonl').stat().st_size,manifest['casesSha256'])
    destination=root(output,False);resources(BASE);destination.mkdir(mode=0o700)
    module=load_module('complement','wger-complement.py');tick=time.monotonic();reader=module.Reader(module.wger.Reader(module.wger.root_for(base)),module.wger.root_for(complement));startup=time.monotonic()-tick
    start=time.monotonic();cpu=time.process_time();results=[];metrics=collections.Counter();timings=[];complete=False
    try:
        with file.open() as f, (destination/'judgements.jsonl').open('x') as judgments:
            for line in f:
                if time.monotonic()-start>=seconds:break
                case=parse_json(line);require(len(results)<2000,'case-budget');expected=case['expectedCode'];query=case['query'];row={'caseId':case['caseId'],'query':query,'split':case['split'],'expectedCode':expected}
                if len(results)%25==0:resources(destination)
                if expected:
                    variants=reader.barcode(expected);usable=[p for p in variants if p['food'] is not None]
                    selectable=len(usable)==1 and len(variants)<20
                    metrics['barcodePresent']+=bool(variants);metrics['barcodeAddable']+=selectable
                    metrics['barcodeAnyUsable']+=bool(usable);metrics['barcodeAmbiguous']+=len(usable)>1 or len(variants)==20
                    metrics['barcodeDeclaredFourMacros']+=any(p['complete'] for p in variants)
                    metrics['barcodeValuesPassBusinessRules']+=any(p['nutritionValuesValid'] for p in variants)
                    metrics['barcodeReferenceUsableForJournal']+=bool(usable)
                    row.update(barcodePresent=bool(variants),barcodeAddable=selectable,barcodeVariantCount=len(variants),barcodePagePossiblyTruncated=len(variants)==20,
                      barcodeVariants=[{'id':p['id'],'name':p['name'],'sourceKind':p['sourceKind'],'declaredFourMacros':p['complete'],'valuesPassBusinessRules':p['nutritionValuesValid'],'referenceEvidence':p['referenceEvidence'],'journalReference':p['food']['reference'] if p['food'] else None,'issues':p['issues']} for p in variants[:5]])
                else:metrics['noBarcode']+=1
                tokens=search_text(query).split() if query else []
                valid=query and 2<=len(query)<=120 and 1<=len(tokens)<=8 and all(len(t)<=40 for t in tokens)
                if not valid:row['queryStatus']='missing-label' if not query else 'outside-supported-query-contract';metrics['missingLabel' if not query else 'unsupportedTitleQuery']+=1
                else:
                    tick=time.perf_counter()
                    try:
                        found=reader.search(query);elapsed=(time.perf_counter()-tick)*1000;timings.append(elapsed);top=found['products'][:5]
                        hit=lambda p:expected is not None and p['barcode'] is not None and ids.canonical(p['barcode'])==ids.canonical(expected)
                        row.update(queryStatus='executed',ms=elapsed,anyUsableResult=bool(top),exactCodeInFirstFive=any(hit(p) for p in top),exactAddableCodeInFirstFive=any(hit(p) and p['food'] is not None for p in top))
                        metrics['executed']+=1;metrics['anyUsableResult']+=bool(top);metrics['exactCodeInFirstFive']+=row['exactCodeInFirstFive'];metrics['exactAddableCodeInFirstFive']+=row['exactAddableCodeInFirstFive']
                        row['results']=[{'id':p['id'],'code':p['barcode'],'name':p['name'],'brand':p['brand'],'reference':p['food']['reference'] if p['food'] else None,'addable':p['food'] is not None,'esciJudgement':None} for p in top]
                    except (CatalogError,sqlite3.Error):row['queryStatus']='failed-or-timeout';metrics['queryErrors']+=1
                judgments.write(canonical(row)+'\n');results.append(row)
                if len(results)%100==0:print(canonical({'evaluated':len(results),'metrics':dict(metrics)}),flush=True)
        complete=len(results)==manifest['cases'];ordered=sorted(timings)
        report={'complete':complete,'benchmarkSha256':digest_file(source/'benchmark.json'),'source':manifest['source'],'baseSha256':reader.base.manifest['sha256'],'complementSha256':reader.manifest['sha256'],'requestedCases':manifest['cases'],'evaluatedCases':len(results),'metrics':dict(metrics),'startupIntegritySeconds':startup,'seconds':time.monotonic()-start,'cpuSeconds':time.process_time()-cpu,'peakRssKiB':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,'searchMeanMs':sum(timings)/len(timings) if timings else None,'searchP95Ms':ordered[math.ceil(.95*len(ordered))-1] if ordered else None,'precisionAt5':None,'ndcgAt5':None,'reason':'Human ESCI relevance labels are absent. An arbitrary usable result is NOT a successful match.','sourceIsQueryLog':False,'national90PercentClaim':False,'networkCalls':0,'resources':resources(destination)}
        with (destination/'report.json').open('x') as f:f.write(canonical(report))
        return report
    finally:reader.close()

if __name__=='__main__':
    p=argparse.ArgumentParser();sub=p.add_subparsers(dest='command',required=True)
    prep=sub.add_parser('prepare');prep.add_argument('--source',required=True);prep.add_argument('--workspace',required=True);prep.add_argument('--cases',type=int,default=1000);prep.add_argument('--seed',default='opengym-public-v1');prep.add_argument('--labels')
    run=sub.add_parser('evaluate');run.add_argument('--benchmark',required=True);run.add_argument('--base',required=True);run.add_argument('--complement',required=True);run.add_argument('--workspace',required=True);run.add_argument('--seconds',type=int,default=300)
    a=p.parse_args();resource.setrlimit(resource.RLIMIT_AS,(512*1024**2,512*1024**2))
    result=prepare(a.source,a.workspace,a.cases,a.seed,a.labels) if a.command=='prepare' else evaluate(a.benchmark,a.base,a.complement,a.workspace,a.seconds)
    print(canonical(result))
