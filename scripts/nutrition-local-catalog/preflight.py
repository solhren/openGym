"""Read-only sizing report, never a downloader/import/activation command.

The HTTP probe is explicit, HEAD only, fixed official hosts, bounded validated redirects, no retry.
A positive arithmetic budget is not permission or evidence of representativeness.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import urllib.error
import urllib.request
from catalog import BASE
from sample import network_error
from catalog import CatalogError
from export_http import EXPORTS, IDENTITY, export_opener, validate_export_url

RESERVE = 20 * 1024**3


def estimate(free, compressed, rows, bytes_per_row, temporary):
    values = [free, compressed, rows, bytes_per_row, temporary]
    if any(type(v) is not int or v < 0 for v in values) or not rows or not bytes_per_row:
        raise ValueError('invalid-sizing-input')
    # Two sealed generations plus the new generation during construction. Temporary
    # journal/index sort files are supplied separately; no uncompressed dump stored.
    generation = rows * bytes_per_row
    required = compressed + 3 * generation + temporary
    return {'estimatedGenerationBytes': generation, 'requiredAdditionalBytesConservative': required,
            'reserveBytes': RESERVE, 'remainingBytes': free - required,
            'arithmeticFits': free - required >= RESERVE,
            'fullImportAuthorized': False, 'requiresRepresentativeMeasurement': True}


def probe(kind, opener=None):
    request = urllib.request.Request(EXPORTS[kind], method='HEAD', headers={'User-Agent':IDENTITY, 'Accept-Encoding':'identity'})
    redirect = None
    if opener is None: opener, redirect = export_opener(kind)
    try:
        with opener.open(request, timeout=15) as response:
            final_url = response.geturl() if hasattr(response, 'geturl') else EXPORTS[kind]
            validate_export_url(final_url, kind)
            if response.status != 200: raise CatalogError('export-http-' + str(response.status))
            length = response.headers.get('Content-Length')
            content_type = (response.headers.get('Content-Type') or '').split(';')[0].strip().lower()
            if content_type in ('text/html','application/xhtml+xml'):
                return {'url':EXPORTS[kind], 'status':response.status, 'error':'export-head-not-archive', 'compressedBytes':None}
            archive_type = content_type in ('application/gzip','application/x-gzip','application/octet-stream','application/x-download','binary/octet-stream')
            return {'url': EXPORTS[kind], 'finalUrl': final_url, 'redirects': redirect.chain if redirect else [], 'status':response.status,
                    'contentType':content_type, 'archiveTypeRecognized':archive_type,
                    'compressedBytes':int(length) if length and length.isdigit() else None,
                    'lastModified':response.headers.get('Last-Modified'), 'etag':response.headers.get('ETag'),
                    'acceptRanges':response.headers.get('Accept-Ranges'), 'digest':response.headers.get('Digest'),
                    's3VersionId':response.headers.get('x-amz-version-id'), 's3ChecksumSha256':response.headers.get('x-amz-checksum-sha256'), 's3ChecksumType':response.headers.get('x-amz-checksum-type')}
    except (CatalogError, urllib.error.URLError, TimeoutError, OSError, ValueError) as error:
        return {'url':EXPORTS[kind], 'error':str(error) if isinstance(error,CatalogError) else 'export-http-'+str(error.code) if isinstance(error,urllib.error.HTTPError) else network_error(error).replace('sample-','export-'),
                **({'httpStatus':error.code} if isinstance(error,urllib.error.HTTPError) else {})}


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--head', choices=EXPORTS)
    parser.add_argument('--compressed-bytes',type=int)
    parser.add_argument('--products',type=int)
    parser.add_argument('--db-bytes-per-product',type=int)
    parser.add_argument('--temporary-bytes',type=int)
    args=parser.parse_args()
    disk=shutil.disk_usage(BASE.parent)
    memory={line.split(':')[0]:int(line.split()[1])*1024 for line in Path('/proc/meminfo').read_text().splitlines() if line.startswith(('MemTotal:','MemAvailable:','SwapTotal:'))}
    report={'freeDiskBytes':disk.free, 'memory':memory, 'cpuCount':os.cpu_count(), 'loadAverage':list(os.getloadavg()),
            'reserveBytes':RESERVE, 'minAvailableMemoryBytes':2*1024**3, 'prototypeMaxProducts':100000, 'prototypeMaxDatabaseBytes':512*1024**2,
            'processVisibility':'Namespace may hide other services; inspect those on SSH, without modifying them.',
            'fullImportAuthorized':False}
    if args.head: report['officialExport']=probe(args.head)
    sizes=[args.compressed_bytes,args.products,args.db_bytes_per_product,args.temporary_bytes]
    if any(v is not None for v in sizes):
        if any(v is None for v in sizes):parser.error('all four sizing fields are required')
        try:report['sizing']=estimate(disk.free,*sizes)
        except ValueError:parser.error('invalid-sizing-input')
    print(json.dumps(report,indent=2))

if __name__=='__main__':main()
