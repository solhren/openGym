"""Bounded, opt-in public wger assessment; never downloads the full dump on purpose.
Fixed HTTPS endpoints, no credentials, no redirects, no retries, no app integration.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib
from catalog import BASE, CatalogError, resources, require, fsync_directory, parse_json
from sample import network_error

ORIGIN='https://wger.de'
EXPORT=ORIGIN+'/media/ingredients/ingredients.jsonl.gz'
IDENTITY='openGym-catalog-evaluation/1 (https://github.com/solhren/openGym)'
MAX_COMPRESSED=4*1024**2
MAX_EXPANDED=32*1024**2
MAX_OUTPUT=16*1024**2
MAX_LINE=65536
QUERIES=('Nutella','Coca-Cola','lait','riz','pâtes','yaourt','œuf','banane','poulet')
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):raise CatalogError('wger-redirect-refused-review-location')

def allowed(url):
    u=urllib.parse.urlsplit(url)
    require(u.scheme=='https' and u.netloc=='wger.de' and not u.fragment and u.path in ('/media/ingredients/ingredients.jsonl.gz','/api/v2/language/','/api/v2/license/','/api/v2/ingredient/'),'wger-unsafe-url')
    params=urllib.parse.parse_qs(u.query,keep_blank_values=True,max_num_fields=4)
    require(all(len(v)==1 for v in params.values()),'wger-unsafe-query')
    if u.path.startswith('/media/'):
        require(not params,'wger-unsafe-query')
    elif u.path in ('/api/v2/license/','/api/v2/language/'):
        require(params=={'limit':['100']},'wger-unsafe-query')
    else:
        require(params=={'limit':['1']} or (set(params)=={'name__search','language','limit'} and params['name__search'][0] in QUERIES and params['language'][0].isdigit() and params['limit']==['10']),'wger-unsafe-query')
    return url

def fetch_json(opener,url):
    allowed(url)
    request=urllib.request.Request(url,headers={'User-Agent':IDENTITY,'Accept':'application/json','Accept-Encoding':'identity'})
    with opener.open(request,timeout=20) as response:
        require(response.status==200,'wger-http-status')
        data=response.read(1024**2+1);require(len(data)<=1024**2,'wger-response-too-large')
        return parse_json(data.decode('utf8'))

def capture_prefix(opener,head,root,max_rows=1000):
    require(type(max_rows) is int and 1<=max_rows<=2000,'invalid-sample-rows')
    headers={'User-Agent':IDENTITY,'Accept-Encoding':'identity','Range':f'bytes=0-{MAX_COMPRESSED-1}'}
    if head.get('etag') and not head['etag'].startswith('W/'):headers['If-Match']=head['etag']
    decoder=zlib.decompressobj(16+zlib.MAX_WBITS);compressed=expanded=output=rows=0;pending=b''
    digest=hashlib.sha256();wire=hashlib.sha256();partial=root/'rows.jsonl.partial';complete_file=root/'rows.jsonl';started=time.monotonic()
    with opener.open(urllib.request.Request(EXPORT,headers=headers),timeout=20) as response,partial.open('xb') as target:
        require(response.status in (200,206),'wger-http-status');range_honored=response.status==206
        if range_honored:
            require(re.fullmatch(r'bytes 0-\d+/\d+',response.headers.get('Content-Range','')) is not None,'wger-invalid-range')
        if head.get('etag') and response.headers.get('ETag'):require(head['etag']==response.headers.get('ETag'),'wger-export-changed')
        stop=False
        while compressed<MAX_COMPRESSED and not stop:
            require(time.monotonic()-started<90,'wger-sample-deadline');resources(root)
            chunk=response.read(min(65536,MAX_COMPRESSED-compressed))
            if not chunk:break
            compressed+=len(chunk);wire.update(chunk)
            while chunk and not stop:
                block=decoder.decompress(chunk,65536);chunk=decoder.unconsumed_tail;expanded+=len(block)
                require(expanded<=MAX_EXPANDED,'wger-expanded-limit');pending+=block
                while b'\n' in pending:
                    line,pending=pending.split(b'\n',1);require(0<len(line)<=MAX_LINE,'wger-line-limit')
                    row=parse_json(line.decode('utf8'));require(type(row) is dict and 'uuid' in row,'wger-invalid-export-row')
                    data=line+b'\n';output+=len(data);require(output<=MAX_OUTPUT,'wger-output-limit')
                    target.write(data);digest.update(data);rows+=1
                    if rows==max_rows:stop=True;break
                require(len(pending)<=MAX_LINE,'wger-line-limit')
        require(rows>0,'wger-empty-sample');target.flush();os.fsync(target.fileno())
    os.link(partial,complete_file);partial.unlink();fsync_directory(root)
    return {'rows':rows,'compressedBytesRead':compressed,'expandedBytesRead':expanded,'outputBytes':output,'sha256':digest.hexdigest(),'compressedPrefixSha256':wire.hexdigest(),'rangeHonored':range_honored,'gzipCrcVerified':decoder.eof,'prefixOnly':True,'representative':False,'seconds':time.monotonic()-started}

def save_json(root,name,value,manifest):
    data=json.dumps(value,ensure_ascii=False,separators=(',',':')).encode()
    with (root/name).open('xb') as f:f.write(data);f.flush();os.fsync(f.fileno())
    manifest[name]={'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data)}

def run(root,fetch=False,coverage=False,max_rows=1000,opener=None):
    root=Path(root);require(root.resolve().parent.is_relative_to(BASE.resolve()) and re.fullmatch(r'[A-Za-z0-9_-]{1,40}',root.name),'wger-unsafe-workspace')
    require(not root.exists(),'wger-existing-workspace');resources(root.parent);root.mkdir(mode=0o700)
    opener=opener or urllib.request.build_opener(NoRedirect())
    with opener.open(urllib.request.Request(EXPORT,method='HEAD',headers={'User-Agent':IDENTITY,'Accept-Encoding':'identity'}),timeout=15) as response:
        require(response.status==200,'wger-head-status')
        length=response.headers.get('Content-Length')
        head={'url':EXPORT,'status':response.status,'compressedBytes':int(length) if length and length.isdigit() else None,'etag':response.headers.get('ETag'),'lastModified':response.headers.get('Last-Modified'),'acceptRanges':response.headers.get('Accept-Ranges')}
    receipt={'format':'opengym-wger-evaluation-capture','version':1,'capturedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'head':head,'complete':False,'files':{},'sampleRequested':fetch,'runtimeCalls':False}
    save_json(root,'head.json',head,receipt['files'])
    if not fetch:
        receipt['complete']=True;save_json(root,'capture.json',receipt,{});return receipt
    # Live ID registries are required: never blindly treat a foreign key as SPDX
    # or language code. Ingredient count is a live API indication, not dump lines.
    for endpoint in ('language','license'):
        time.sleep(1)
        data=fetch_json(opener,f'{ORIGIN}/api/v2/{endpoint}/?limit=100')
        require(type(data) is dict and type(data.get('results')) is list and data.get('next') is None,'wger-truncated-metadata')
        save_json(root,endpoint+'.json',data,receipt['files'])
    time.sleep(1)
    count=fetch_json(opener,ORIGIN+'/api/v2/ingredient/?limit=1')
    require(type(count) is dict and type(count.get('results')) is list and len(count['results'])<=1,'wger-invalid-count-response')
    save_json(root,'count.json',count,receipt['files']);receipt['liveCountNotDumpCount']=count.get('count')
    receipt['prefix']=capture_prefix(opener,head,root,max_rows)
    receipt['files']['rows.jsonl']={'sha256':receipt['prefix']['sha256'],'bytes':receipt['prefix']['outputBytes']}
    if coverage:
        languages=json.loads((root/'language.json').read_text())['results'];french=[x['id'] for x in languages if x.get('short_name')=='fr'];require(len(french)==1,'wger-french-language-missing')
        receipt['coverageQueries']=[]
        # name__search is documented and provider may use trigrams. These are
        # MAINTENANCE candidates only. Local evaluation filters them literally;
        # provider count must NEVER be called exact French catalogue coverage.
        for i,query in enumerate(QUERIES):
            time.sleep(1)
            params=urllib.parse.urlencode({'name__search':query,'language':french[0],'limit':10})
            data=fetch_json(opener,ORIGIN+'/api/v2/ingredient/?'+params)
            require(type(data) is dict and type(data.get('results')) is list and len(data['results'])<=10,'wger-invalid-coverage-response')
            require(all(type(row) is dict and row.get('language')==french[0] for row in data['results']),'wger-language-filter-not-applied')
            name=f'coverage-{i}.json';save_json(root,name,data,receipt['files']);receipt['coverageQueries'].append({'query':query,'file':name,'providerMayBeFuzzy':True})
    receipt['complete']=True;save_json(root,'capture.json',receipt,{});fsync_directory(root);return receipt

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--workspace',required=True);parser.add_argument('--fetch',action='store_true');parser.add_argument('--coverage',action='store_true');parser.add_argument('--rows',type=int,default=1000);args=parser.parse_args()
    try:print(json.dumps(run(BASE/args.workspace,args.fetch,args.coverage,args.rows),ensure_ascii=False,indent=2))
    except (CatalogError,urllib.error.URLError,OSError,ValueError,zlib.error,UnicodeError) as error:
        code=str(error) if isinstance(error,CatalogError) else 'wger-http-'+str(error.code) if isinstance(error,urllib.error.HTTPError) else network_error(error).replace('sample-','wger-')
        hint=error.headers.get('Retry-After') if isinstance(error,urllib.error.HTTPError) else None
        print(json.dumps({'error':code,'retry':False,'retryAfter':hint[:100] if hint else None,'noFullDownload':True}),file=sys.stderr);return 1
    return 0
if __name__=='__main__':sys.exit(main())
