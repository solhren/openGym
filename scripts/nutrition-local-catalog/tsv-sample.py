"""Small prefix of the official gzip export. Range only, no full dump download.

The stored TSV contains complete unchanged lines, not the truncated gzip. Source
CRC is necessarily unverified: a prefix is not the entire archive or a representative
sample. Captured hashes detect later corruption, not source authenticity.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import signal
import sys
import time
import urllib.error
import urllib.request
import zlib
from catalog import BASE, CatalogError, canonical, fsync_directory, require, resources
from export_http import EXPORTS, IDENTITY, export_opener, validate_export_url
from sample import network_error

MAX_COMPRESSED = 16 * 1024**2
MAX_DECOMPRESSED = 128 * 1024**2
MAX_OUTPUT = 64 * 1024**2
MAX_LINE = 1024**2


def capture(root, row_limit=5000, opener=None):
    require(type(row_limit) is int and 1 <= row_limit <= 20000, 'invalid-sample-row-budget')
    resources(root)
    deadline=time.monotonic()+120
    if opener is None:opener,redirect=export_opener('tsv',deadline)
    else:redirect=None
    request=urllib.request.Request(EXPORTS['tsv'],headers={'User-Agent':IDENTITY,'Accept-Encoding':'identity','Range':f'bytes=0-{MAX_COMPRESSED-1}'})
    received=expanded=output_bytes=count=0
    compressed_hash=hashlib.sha256();output_hash=hashlib.sha256()
    partial=root/'sample.tsv.partial'
    partial_created=False
    report={'format':'opengym-off-tsv-sample','version':1,'source':EXPORTS['tsv'],'capturedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'representative':False,'sourceGzipCrcVerified':False,'complete':False,'requestedRows':row_limit,
            'limits':{'compressedBytes':MAX_COMPRESSED,'expandedBytes':MAX_DECOMPRESSED,'outputBytes':MAX_OUTPUT,'seconds':120},
            'attribution':'Open Food Facts contributors','license':'ODbL-1.0','contentLicense':'DbCL-1.0'}
    try:
        with opener.open(request,timeout=15) as response, partial.open('xb') as output:
            partial_created=True
            final=response.geturl() if hasattr(response,'geturl') else EXPORTS['tsv']
            validate_export_url(final,'tsv')
            require(response.status==206,'export-range-required')
            match=re.fullmatch(r'bytes 0-(\d+)/(\d+)',response.headers.get('Content-Range',''))
            require(match and int(match[1])<MAX_COMPRESSED and int(match[2])>int(match[1]),'export-invalid-content-range')
            announced=response.headers.get('Content-Length')
            require(announced is None or announced.isdigit() and int(announced)==int(match[1])+1,'export-invalid-content-length')
            report.update(finalUrl=final,sourceCompressedBytes=int(match[2]),etag=response.headers.get('ETag'),lastModified=response.headers.get('Last-Modified'),s3VersionId=response.headers.get('x-amz-version-id'),redirects=redirect.chain if redirect else [])
            inflater=zlib.decompressobj(16+zlib.MAX_WBITS)
            pending=b'';header=None
            while count<row_limit:
                require(time.monotonic()<deadline,'export-sample-deadline')
                incoming=response.read(min(65536,MAX_COMPRESSED-received))
                require(incoming,'export-prefix-too-small')
                received+=len(incoming);require(received<=MAX_COMPRESSED,'export-sample-compressed-limit');compressed_hash.update(incoming)
                data=incoming
                while data and count<row_limit:
                    decoded=inflater.decompress(data,65536);data=inflater.unconsumed_tail
                    expanded+=len(decoded);require(expanded<=MAX_DECOMPRESSED,'export-sample-expanded-limit');pending+=decoded
                    while b'\n' in pending and count<row_limit:
                        line,pending=pending.split(b'\n',1);require(len(line)+1<=MAX_LINE,'export-sample-line-limit')
                        cells=line.decode('utf8',errors='strict').removesuffix('\r').split('\t')
                        if header is None:
                            header=cells
                            require(1<=len(header)<=512 and len(set(header))==len(header) and 'code' in header and 'product_name' in header and not any(k in ('__proto__','constructor','prototype') or not k or len(k)>120 for k in header),'export-sample-invalid-header')
                        else:
                            require(len(cells)==len(header) and all(len(cell)<=65536 for cell in cells),'export-sample-invalid-row');count+=1
                        value=line+b'\n';output_bytes+=len(value);require(output_bytes<=MAX_OUTPUT,'export-sample-output-limit')
                        require(output.write(value)==len(value),'export-sample-short-write');output_hash.update(value)
                    require(count==row_limit or len(pending)<=MAX_LINE,'export-sample-line-limit')
                    if inflater.eof and count<row_limit:raise CatalogError('export-prefix-too-small')
                if count%500==0:resources(root)
            resources(root);output.flush();os.fsync(output.fileno())
        require(header is not None and count==row_limit,'export-sample-incomplete')
        # No overwrite, even for this prototype's earlier captures.
        os.link(partial,root/'sample.tsv');partial.unlink();fsync_directory(root)
        report.update(complete=True,rows=count,columns=header,columnCount=len(header),compressedBytesRead=received,expandedBytesRead=expanded,
                      sampleBytes=output_bytes,sampleSha256=output_hash.hexdigest(),compressedPrefixSha256=compressed_hash.hexdigest(),seconds=time.monotonic()-(deadline-120))
    except (CatalogError,urllib.error.URLError,OSError,UnicodeError,zlib.error) as error:
        if isinstance(error,urllib.error.HTTPError):error.close()
        report['error']=str(error) if isinstance(error,CatalogError) else 'export-http-'+str(error.code) if isinstance(error,urllib.error.HTTPError) else 'export-sample-invalid-gzip-or-utf8' if isinstance(error,(UnicodeError,zlib.error)) else network_error(error).replace('sample-','export-')
        raise CatalogError(report['error']) from None
    finally:
        if partial_created:partial.unlink(missing_ok=True)
        with (root/'sample-manifest.json').open('x',encoding='utf8') as handle:
            handle.write(canonical(report)+'\n');handle.flush();os.fsync(handle.fileno())
        fsync_directory(root)
    return report


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--workspace',required=True);parser.add_argument('--rows',type=int,default=5000);parser.add_argument('--fetch',action='store_true');args=parser.parse_args()
    try:
        require(re.fullmatch('[a-zA-Z0-9_-]{1,40}',args.workspace) and 1<=args.rows<=20000,'invalid-sample-arguments')
        if not args.fetch:
            print(canonical({'plan':'official TSV gzip prefix, not representative','source':EXPORTS['tsv'],'rows':args.rows,'maxCompressedBytes':MAX_COMPRESSED,'maxExpandedBytes':MAX_DECOMPRESSED,'networkRequests':0}));return 0
        require(not BASE.is_symlink(),'unsafe-workspace');BASE.mkdir(exist_ok=True,mode=0o700)
        root=BASE/args.workspace;root.mkdir(mode=0o700)
        resource.setrlimit(resource.RLIMIT_AS,(256*1024**2,resource.getrlimit(resource.RLIMIT_AS)[1]))
        def timeout(*_):raise CatalogError('export-sample-deadline')
        signal.signal(signal.SIGALRM,timeout);signal.alarm(120)
        try:print(canonical(capture(root,args.rows)))
        finally:signal.alarm(0)
    except (CatalogError,OSError,MemoryError) as error:
        print(canonical({'error':str(error) if isinstance(error,CatalogError) else 'export-sample-storage-error'}),file=sys.stderr);return 1
    return 0

if __name__=='__main__':sys.exit(main())
