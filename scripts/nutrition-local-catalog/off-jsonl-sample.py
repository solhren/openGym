"""Opt-in, bounded official RAW JSONL prefix. No full dump, retries or API calls.
The prefix is non-representative; its partial gzip cannot certify the full dump.
"""
import argparse
import hashlib
import json
import os
import re
import resource
import signal
import sys
import time
import urllib.error
import urllib.request
import zlib
from catalog import BASE,CatalogError,require,resources,canonical,fsync_directory
from export_http import EXPORTS,IDENTITY,export_opener,validate_export_url
from sample import network_error

MAX_COMPRESSED=4*1024**2
MAX_EXPANDED=32*1024**2
MAX_LINE=8*1024**2

def capture(root,rows=200,opener=None):
    require(type(rows) is int and 1<=rows<=1000,'invalid-sample-rows');resources(root)
    start=time.monotonic();deadline=start+90
    if opener is None:opener,redirect=export_opener('jsonl',deadline)
    else:redirect=None
    receipt={'format':'opengym-off-raw-prefix','version':1,'complete':False,'representative':False,'source':EXPORTS['jsonl'],'capturedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'requestedRows':rows,'sourceGzipCrcVerified':False,'license':'ODbL-1.0','contentLicense':'DbCL-1.0','attribution':'Open Food Facts contributors','limits':{'compressedBytes':MAX_COMPRESSED,'expandedBytes':MAX_EXPANDED,'lineBytes':MAX_LINE,'seconds':90}}
    count=received=expanded=written=0;pending=b'';source_hash=hashlib.sha256();out_hash=hashlib.sha256()
    request=urllib.request.Request(EXPORTS['jsonl'],headers={'User-Agent':IDENTITY,'Accept-Encoding':'identity','Range':f'bytes=0-{MAX_COMPRESSED-1}'})
    try:
        with opener.open(request,timeout=15) as response:
            final=response.geturl() if hasattr(response,'geturl') else EXPORTS['jsonl'];validate_export_url(final,'jsonl')
            require(response.status==206,'export-range-required')
            match=re.fullmatch(r'bytes 0-(\d+)/(\d+)',response.headers.get('Content-Range',''))
            require(match and int(match[1])<MAX_COMPRESSED and int(match[2])>int(match[1]),'export-invalid-content-range')
            receipt.update(finalUrl=final,sourceCompressedBytes=int(match[2]),etag=response.headers.get('ETag'),lastModified=response.headers.get('Last-Modified'),s3VersionId=response.headers.get('x-amz-version-id'),redirects=redirect.chain if redirect else [])
            inflater=zlib.decompressobj(16+zlib.MAX_WBITS)
            with (root/'rows.jsonl.partial').open('xb') as output:
                while count<rows:
                    require(time.monotonic()<deadline,'jsonl-sample-deadline');resources(root)
                    chunk=response.read(min(65536,MAX_COMPRESSED-received));require(chunk,'jsonl-prefix-too-small')
                    received+=len(chunk);source_hash.update(chunk);data=chunk
                    while data and count<rows:
                        block=inflater.decompress(data,65536);data=inflater.unconsumed_tail;expanded+=len(block)
                        require(expanded<=MAX_EXPANDED,'jsonl-expanded-limit');pending+=block
                        while b'\n' in pending and count<rows:
                            line,pending=pending.split(b'\n',1);require(0<len(line)<=MAX_LINE,'jsonl-line-limit')
                            value=json.loads(line.decode('utf8'),parse_constant=lambda _:(_ for _ in ()).throw(CatalogError('nonfinite-json')))
                            require(type(value) is dict and type(value.get('code')) is str and len(value['code'])<=64,'jsonl-invalid-product')
                            row=line+b'\n';written+=len(row);require(written<=MAX_EXPANDED,'jsonl-output-limit');require(output.write(row)==len(row),'jsonl-short-write');out_hash.update(row);count+=1
                        require(len(pending)<=MAX_LINE,'jsonl-line-limit')
                output.flush();os.fsync(output.fileno())
            receipt['sourceGzipCrcVerified']=inflater.eof
        os.link(root/'rows.jsonl.partial',root/'rows.jsonl');(root/'rows.jsonl.partial').unlink();fsync_directory(root)
        receipt.update(complete=True,rows=count,bytes=written,sha256=out_hash.hexdigest(),compressedPrefixSha256=source_hash.hexdigest())
    except (CatalogError,urllib.error.URLError,OSError,ValueError,UnicodeError,zlib.error,RecursionError) as error:
        code=str(error) if isinstance(error,CatalogError) else 'jsonl-http-'+str(error.code) if isinstance(error,urllib.error.HTTPError) else 'jsonl-invalid-data' if isinstance(error,(ValueError,UnicodeError,zlib.error,RecursionError)) else network_error(error).replace('sample-','jsonl-')
        if isinstance(error,urllib.error.HTTPError):error.close()
        receipt['error']=code;raise CatalogError(code) from None
    finally:
        receipt.update(compressedBytesRead=received,expandedBytesRead=expanded,seconds=time.monotonic()-start)
        with (root/'capture.json').open('x') as f:f.write(canonical(receipt));f.flush();os.fsync(f.fileno())
        fsync_directory(root)
    return receipt

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--workspace',required=True);p.add_argument('--rows',type=int,default=200);p.add_argument('--fetch',action='store_true');a=p.parse_args()
    try:
        require(re.fullmatch(r'[A-Za-z0-9_-]{1,40}',a.workspace) and 1<=a.rows<=1000,'invalid-sample-options')
        if not a.fetch:print(canonical({'source':EXPORTS['jsonl'],'networkRequests':0,'maxCompressedBytes':MAX_COMPRESSED,'maxExpandedBytes':MAX_EXPANDED,'representative':False}));sys.exit(0)
        root=BASE/a.workspace;require(not BASE.is_symlink(),'unsafe-workspace');resources(BASE);root.mkdir(mode=0o700)
        resource.setrlimit(resource.RLIMIT_AS,(512*1024**2,512*1024**2))
        def timeout(*_):raise CatalogError('jsonl-sample-deadline')
        signal.signal(signal.SIGALRM,timeout);signal.alarm(90)
        try:print(canonical(capture(root,a.rows)))
        finally:signal.alarm(0)
    except (CatalogError,OSError,MemoryError) as error:print(canonical({'error':str(error) if isinstance(error,CatalogError) else 'jsonl-sample-storage-error','retry':False}),file=sys.stderr);sys.exit(1)
