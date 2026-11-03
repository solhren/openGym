"""Opt-in fixed OFF TSV downloader, resumable only against a pinned object.

No import or activation. Requires the operator's --fetch and --ack-targeted-budget.
HTTPS, exact redirect allowlist, verified size, immutable version/ETag, no retry.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time
import urllib.request
from catalog import BASE, CatalogError, require, resources, fsync_directory, writer_lock
from export_http import IDENTITY, EXPORTS, export_opener, validate_export_url
from preflight import probe
from sample import network_error
MAX_SOURCE=2*1024**3
# source + projection + three 512 MiB generations + 2 GiB sort allowance
# + 640 MiB bounded public v3 cache, + 1 GiB on-disk selection registry, rounded to 8 GiB.
ADDITIONAL_BUDGET=8*1024**3

def download(destination, fetch=False, acknowledge=False):
    destination=Path(destination);base=BASE.resolve()
    require(destination.resolve().parent.is_relative_to(base) and re.fullmatch(r'[a-zA-Z0-9_-]{1,40}',destination.name),'unsafe-download-workspace')
    destination.mkdir(exist_ok=True,mode=0o700);require(not destination.is_symlink(),'unsafe-download-workspace')
    resources(destination)
    with writer_lock(destination):
        return download_locked(destination,fetch,acknowledge)

def download_locked(destination,fetch,acknowledge):
    head=probe('tsv')
    if head.get('error'):raise CatalogError(head['error'])
    require(head.get('status')==200 and type(head.get('compressedBytes')) is int and 0<head['compressedBytes']<=MAX_SOURCE and head.get('etag'),'missing-or-oversized-source')
    report={'source':head,'additionalBudgetBytes':ADDITIONAL_BUDGET,'requiresFreeBytes':20*1024**3+ADDITIONAL_BUDGET,'completeDumpImportSupported':False,'targetedProjectionMaxRows':100000,'fetch':fetch}
    if not fetch:return report
    require(acknowledge,'targeted-budget-not-acknowledged')
    import shutil
    final=destination/'source.tsv.gz';partial=destination/'source.tsv.gz.partial';receipt=destination/'download-state.json'
    require(not final.exists() and not final.is_symlink(),'download-already-complete')
    current={'format':'opengym-off-tsv-download','version':1,'source':EXPORTS['tsv'],'finalUrl':head['finalUrl'],'etag':head['etag'],'s3VersionId':head.get('s3VersionId'),'bytes':head['compressedBytes']}
    if partial.exists() or receipt.exists():
        require(not partial.is_symlink() and receipt.is_file() and not receipt.is_symlink() and receipt.stat().st_size<=65536,'unsafe-resume-state')
        saved=json.loads(receipt.read_text());require(saved==current,'source-changed-start-new-workspace')
    else:
        require(not receipt.exists(),'incomplete-download-workspace')
        with receipt.open('x') as state:json.dump(current,state);state.flush();os.fsync(state.fileno())
        fsync_directory(destination)
    offset=partial.stat().st_size if partial.exists() else 0
    require(offset<=current['bytes'],'invalid-partial-size')
    # Bytes already held in THIS validated partial are included in the original
    # envelope. Do not demand the complete initial reserve a second time.
    remaining=max(0,ADDITIONAL_BUDGET-offset)
    report['remainingAdditionalBudgetBytes']=remaining
    require(shutil.disk_usage(destination).free>=20*1024**3+remaining,'insufficient-targeted-download-budget')
    sha=hashlib.sha256()
    if offset:
        with partial.open('rb') as old:
            while chunk:=old.read(65536):sha.update(chunk)
    url=head['finalUrl']
    if current['s3VersionId'] and 'amazonaws.com' in url:
        from urllib.parse import urlencode
        url=url.split('?')[0]+'?'+urlencode({'versionId':current['s3VersionId']})
    validate_export_url(url,'tsv')
    if offset<current['bytes']:
        opener,_=export_opener('tsv',deadline=time.monotonic()+30)
        headers={'User-Agent':IDENTITY,'Accept-Encoding':'identity','If-Match':current['etag']}
        if offset:headers['Range']=f'bytes={offset}-'
        request=urllib.request.Request(url,headers=headers);start=time.monotonic()
        with opener.open(request,timeout=30) as response:
            validate_export_url(response.geturl(),'tsv')
            require(response.status==(206 if offset else 200) and response.headers.get('ETag')==current['etag'],'download-object-changed')
            expected=current['bytes']-offset
            require(response.headers.get('Content-Length')==str(expected),'download-length-mismatch')
            if offset:require(response.headers.get('Content-Range')==f"bytes {offset}-{current['bytes']-1}/{current['bytes']}",'unsafe-range-response')
            flags=os.O_WRONLY|os.O_NOFOLLOW|(os.O_APPEND if partial.exists() else os.O_CREAT|os.O_EXCL)
            fd=os.open(partial,flags,0o600)
            with os.fdopen(fd,'ab' if offset else 'wb') as target:
                while chunk:=response.read(65536):
                    require(offset+len(chunk)<=current['bytes'],'oversized-download-response')
                    require(time.monotonic()-start<=4*3600,'download-deadline')
                    resources(destination);sha.update(chunk);target.write(chunk);offset+=len(chunk)
                target.flush();os.fsync(target.fileno())
        require(offset==current['bytes'],'truncated-download')
    require(partial.stat().st_size==offset,'partial-size-changed')
    os.link(partial,final);partial.unlink();fsync_directory(destination)
    result={**report,'complete':True,'downloadSha256':sha.hexdigest(),'downloadBytes':offset,'gzipCrcVerified':False}
    with (destination/'download-manifest.json').open('x') as state:json.dump(result,state);state.flush();os.fsync(state.fileno())
    fsync_directory(destination);return result

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--destination',required=True);parser.add_argument('--fetch',action='store_true');parser.add_argument('--ack-targeted-budget',action='store_true');args=parser.parse_args()
    try:print(json.dumps(download(args.destination,args.fetch,args.ack_targeted_budget),indent=2))
    except (CatalogError,OSError,ValueError,TimeoutError) as error:
        import errno
        code=str(error) if isinstance(error,CatalogError) else 'download-disk-full' if getattr(error,'errno',None)==errno.ENOSPC else 'download-permission-denied' if getattr(error,'errno',None) in (errno.EACCES,errno.EPERM) else network_error(error).replace('sample-','download-')
        print(json.dumps({'error':code}),file=sys.stderr);return 1
    return 0
if __name__=='__main__':sys.exit(main())
