"""Bounded public benchmark capture; never samples based on catalogue hits.
Plan is the default. --fetch performs one population probe then one seeded
offset within each equal-sized row stratum. No retries, images or full exports.
"""
import argparse
import datetime
import hashlib
import importlib.util
import json
from pathlib import Path
import random
import re
import resource
import signal
import sys
import time
import urllib.parse
import urllib.request
from catalog import BASE,CatalogError,canonical,require,resources
from sample import acquire,save,NoRedirect

SOURCES={
 'prices-fr':{'dataset':'openfoodfacts/open-prices','split':'prices','where':'"location_osm_address_country_code"=\'FR\'','license':'ODbL-1.0'},
 'off-fr':{'dataset':'openfoodfacts/product-database','split':'food','where':'"lang"=\'fr\'','license':'ODbL-1.0; DbCL-1.0 for contents'},
 'off-labels':{'dataset':'openfoodfacts/product-database','split':'food','where':'bounded exact code batches from frozen public price cases','license':'ODbL-1.0; DbCL-1.0 for contents'},
}
MAX_TOTAL=32*1024**2

def url(source,offset,length):
    require(source in ('prices-fr','off-fr') and type(offset) is int and 0<=offset<10000000 and type(length) is int and 1<=length<=100,'invalid-sample-parameters')
    item=SOURCES[source]
    return 'https://datasets-server.huggingface.co/filter?'+urllib.parse.urlencode({'dataset':item['dataset'],'config':'default','split':item['split'],'where':item['where'],'orderby':'"id"' if source=='prices-fr' else '"code"','offset':offset,'length':length})

def offsets(total,pages,length,seed):
    require(type(total) is int and 1<=total<=10000000 and type(pages) is int and 1<=pages<=20 and type(length) is int and 1<=length<=100 and total>=pages*length,'invalid-sampling-budget')
    require(type(seed) is str and re.fullmatch(r'[A-Za-z0-9_-]{1,80}',seed),'invalid-seed')
    rng=random.Random(seed)
    return [rng.randrange(i*total//pages,(i+1)*total//pages-length+1) for i in range(pages)]

def envelope(data,source=None,allow_empty=False):
    def pairs(items):
        out={}
        for k,v in items:require(k not in out and k not in ('__proto__','prototype','constructor'),'unsafe-json');out[k]=v
        return out
    try:value=json.loads(data.decode('utf8'),object_pairs_hook=pairs,parse_constant=lambda _:(_ for _ in ()).throw(ValueError()))
    except (ValueError,RecursionError,UnicodeError):raise CatalogError('invalid-public-sample') from None
    require(type(value) is dict and value.get('partial') is False and type(value.get('features')) is list and type(value.get('rows')) is list and (0 if allow_empty else 1)<=len(value['rows'])<=100,'invalid-public-sample')
    require(type(value.get('num_rows_total')) is int and (0 if allow_empty else 1)<=value['num_rows_total']<=10000000,'invalid-public-sample')
    critical={'id','product_code','product_name','category_tag','location_osm_address_country_code'} if source=='prices-fr' else {'code','product_name','brands','lang','countries_tags'}
    for v in value['rows']:
        require(type(v) is dict and type(v.get('row_idx')) is int and type(v.get('row')) is dict and type(v.get('truncated_cells')) is list and len(v['truncated_cells'])<=200 and all(type(k) is str and len(k)<=100 for k in v['truncated_cells']),'invalid-public-sample')
        # Benchmark identity/title fields must be complete. A truncated image or
        # environmental score is irrelevant to a title benchmark, not a reason
        # to cherry-pick a different slice. No nutrition is imported here.
        require(not critical.intersection(v['truncated_cells']),'truncated-public-sample')
    return value

def capture(source,name,pages=20,length=100,seed='opengym-public-v1',opener=None):
    require(source in ('prices-fr','off-fr') and type(name) is str and re.fullmatch(r'[A-Za-z0-9_-]{1,40}',name) and not BASE.is_symlink(),'unsafe-workspace')
    require(type(pages) is int and 1<=pages<=20 and type(length) is int and 1<=length<=100 and type(seed) is str and re.fullmatch(r'[A-Za-z0-9_-]{1,80}',seed),'invalid-sampling-budget')
    root=BASE/name;root.mkdir(mode=0o700);resources(root);start=time.monotonic();used=0
    manifest={'format':'opengym-public-benchmark-capture','version':1,'source':source,**SOURCES[source],'seed':seed,'complete':False,'pages':[],'maxBytes':MAX_TOTAL,'maxSeconds':600,'capturedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceIsQueryLog':False,'representativeOfFrenchPurchases':False}
    opener=opener or urllib.request.build_opener(NoRedirect())
    try:
        probe_url=url(source,0,1);raw,headers=acquire(probe_url,opener,MAX_TOTAL,30);used+=len(raw);probe=envelope(raw,source)
        total=probe['num_rows_total'];indices=offsets(total,pages,length,seed);schema=hashlib.sha256(canonical(probe['features']).encode()).hexdigest()
        save(root,'page-000.json',raw);manifest['probe']={'file':'page-000.json','sha256':hashlib.sha256(raw).hexdigest(),'bytes':len(raw),'url':probe_url,**headers}
        seen=set()
        for i,offset in enumerate(indices,1):
            resources(root);require(time.monotonic()-start<600,'public-sample-deadline')
            target=url(source,offset,length);raw,headers=acquire(target,opener,MAX_TOTAL-used,min(30,600-(time.monotonic()-start)));used+=len(raw)
            value=envelope(raw,source);require(value['num_rows_total']==total and hashlib.sha256(canonical(value['features']).encode()).hexdigest()==schema,'public-sample-population-changed')
            require(len(value['rows'])==length,'public-sample-incomplete-page')
            for row in value['rows']:
                require(row['row_idx'] not in seen,'public-sample-overlap');seen.add(row['row_idx'])
            file=f'page-{i:03d}.json';save(root,file,raw)
            manifest['pages'].append({'file':file,'url':target,'offset':offset,'length':length,'rows':length,'irrelevantTruncatedRows':sum(bool(v['truncated_cells']) for v in value['rows']),'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),**headers})
        manifest.update(complete=True,rows=len(seen),populationRows=total,schemaSha256=schema,bytes=used)
    except CatalogError as error:manifest['error']=str(error);raise
    finally:
        manifest['seconds']=time.monotonic()-start;save(root,'sample-manifest.json',(canonical(manifest)+'\n').encode())
    return manifest

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--source',choices=('prices-fr','off-fr'),required=True);p.add_argument('--workspace',required=True);p.add_argument('--pages',type=int,default=20);p.add_argument('--length',type=int,default=100);p.add_argument('--seed',default='opengym-public-v1');p.add_argument('--fetch',action='store_true');a=p.parse_args()
    resource.setrlimit(resource.RLIMIT_AS,(256*1024**2,256*1024**2))
    if not a.fetch:print(canonical({'source':SOURCES[a.source],'probe':url(a.source,0,1),'maxRows':a.pages*a.length,'maxBytes':MAX_TOTAL,'networkRequests':0,'note':'--fetch probes the actual filtered population; no availability-based selection'}));sys.exit(0)
    signal.signal(signal.SIGALRM,lambda *_:(_ for _ in ()).throw(CatalogError('public-sample-deadline')));signal.alarm(600)
    try:print(canonical(capture(a.source,a.workspace,a.pages,a.length,a.seed)))
    except (CatalogError,OSError,MemoryError) as error:print(canonical({'error':str(error) if isinstance(error,CatalogError) else 'public-sample-storage-error'}),file=sys.stderr);sys.exit(1)
    finally:signal.alarm(0)
