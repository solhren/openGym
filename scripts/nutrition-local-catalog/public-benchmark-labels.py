"""Join observed French price products to OFF names using bounded Dataset Viewer
filters, not food-product API calls. Plan by default; at most 20 requests/32 MiB.
The source benchmark is frozen before any catalogue under test is inspected.
"""
import argparse
import datetime
import hashlib
import importlib.util
from pathlib import Path
import re
import resource
import signal
import sys
import time
import urllib.parse
import urllib.request
from catalog import BASE,CatalogError,canonical,digest_file,parse_json,require,resources
from sample import acquire,save,NoRedirect
s=importlib.util.spec_from_file_location('public_bench',Path(__file__).with_name('public-benchmark.py'));bench=importlib.util.module_from_spec(s);s.loader.exec_module(bench)

def batches(cases):
    require(type(cases) is list and len(cases)<=2000,'invalid-label-cases')
    require(all(type(c) is dict and 'expectedCode' in c and (c['expectedCode'] is None or type(c['expectedCode']) is str and re.fullmatch(r'(?:\d{8}|\d{12,14})',c['expectedCode'],re.ASCII)) for c in cases),'invalid-label-cases')
    codes=sorted({c['expectedCode'] for c in cases if c.get('expectedCode') is not None})
    require(0<len(codes)<=1000 and all(type(code) is str and re.fullmatch(r'(?:\d{8}|\d{12,14})',code,re.ASCII) for code in codes),'invalid-label-codes')
    result=[]
    for i in range(0,len(codes),50):
        group=codes[i:i+50]
        where=' OR '.join('"code"=\''+code+'\'' for code in group)
        url='https://datasets-server.huggingface.co/filter?'+urllib.parse.urlencode({'dataset':'openfoodfacts/product-database','config':'default','split':'food','where':where,'orderby':'"code"','offset':0,'length':100})
        require(len(url)<=8192,'label-url-budget');result.append({'url':url,'codes':group})
    return result

def load(benchmark):
    root=bench.root(benchmark);file=root/'benchmark.json';require(not file.is_symlink() and file.stat().st_size<=65536,'unsafe-benchmark-manifest');manifest=parse_json(file.read_text())
    require(manifest.get('format')=='opengym-public-search-benchmark' and manifest.get('complete') is True and manifest.get('source',{}).get('source')=='openfoodfacts/open-prices','labels-require-frozen-price-benchmark')
    p=bench.checked_file(root,'cases.jsonl',(root/'cases.jsonl').stat().st_size,manifest['casesSha256']);cases=[parse_json(line) for line in p.read_text().splitlines()]
    require(len(cases)==manifest['cases']<=1000,'invalid-label-case-count');return batches(cases),digest_file(file)

def capture(benchmark,name,fetch=False,opener=None):
    requests,source_sha=load(benchmark)
    if not fetch:return {'benchmarkSha256':source_sha,'batches':len(requests),'codes':sum(len(r['codes']) for r in requests),'maxBytes':bench.samples.MAX_TOTAL,'maxSeconds':600,'networkRequests':0}
    root=bench.root(name,False);resources(BASE);root.mkdir(mode=0o700)
    opener=opener or urllib.request.build_opener(NoRedirect());start=time.monotonic();used=0;seen=set();schema=None
    manifest={'format':'opengym-public-benchmark-capture','version':1,'source':'off-labels',**bench.samples.SOURCES['off-labels'],'seed':'exact public price case codes','benchmarkSha256':source_sha,'barcodePolicy':'original code strings, no guessed aliases','complete':False,'pages':[],'capturedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceIsQueryLog':False,'representativeOfFrenchPurchases':False}
    try:
        for i,request in enumerate(requests):
            resources(root);remaining=600-(time.monotonic()-start);require(remaining>0,'labels-deadline')
            raw,headers=acquire(request['url'],opener,bench.samples.MAX_TOTAL-used,min(30,remaining));used+=len(raw)
            value=bench.samples.envelope(raw,'off-labels',allow_empty=True)
            fingerprint=hashlib.sha256(canonical(value['features']).encode()).hexdigest()
            require(schema is None or schema==fingerprint,'labels-schema-changed');schema=fingerprint
            require(value['num_rows_total']==len(value['rows'])<=len(request['codes']),'ambiguous-or-partial-label-batch')
            codes=set()
            for item in value['rows']:
                # Product codes are stable across independent filter batches;
                # row_idx is response metadata, not a barcode identity.
                code=item['row'].get('code');require(code in request['codes'] and code not in codes and code not in seen,'unexpected-or-duplicate-label');codes.add(code);seen.add(code)
            file=f'page-{i:03d}.json';save(root,file,raw)
            manifest['pages'].append({'file':file,'url':request['url'],'codes':request['codes'],'rows':len(codes),'missingCodes':sorted(set(request['codes'])-codes),'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),**headers})
        manifest.update(complete=True,rows=len(seen),requestedCodes=sum(len(r['codes']) for r in requests),bytes=used,schemaSha256=schema)
    except CatalogError as error:manifest['error']=str(error);raise
    finally:
        manifest['seconds']=time.monotonic()-start;save(root,'sample-manifest.json',(canonical(manifest)+'\n').encode())
    return manifest

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--benchmark',required=True);p.add_argument('--workspace',required=True);p.add_argument('--fetch',action='store_true');a=p.parse_args()
    resource.setrlimit(resource.RLIMIT_AS,(256*1024**2,256*1024**2));signal.signal(signal.SIGALRM,lambda *_:(_ for _ in ()).throw(CatalogError('labels-deadline')))
    if a.fetch:signal.alarm(600)
    try:print(canonical(capture(a.benchmark,a.workspace,a.fetch)))
    except (CatalogError,OSError,MemoryError) as error:print(canonical({'error':str(error) if isinstance(error,CatalogError) else 'labels-storage-error'}),file=sys.stderr);sys.exit(1)
    finally:signal.alarm(0)
