"""Streaming inventory of the supplied archive; reaching EOF verifies gzip CRC.

No user directories, network requests or uncompressed source files are involved.
The limits below are specific to this full-import lane, not relaxed OFF limits.
"""
import collections
import gzip
import hashlib
import json
import os
from pathlib import Path
import resource
import time
from catalog import BASE, CatalogError, parse_json, resources, require, fsync_directory

MAX_SOURCE = 1024**3
MAX_EXPANDED = 12*1024**3
MAX_ROWS = 5_000_000
MAX_LINE = 256*1024

def inventory(source, output):
    require(source.parent.resolve()==(BASE/'wger-full-source').resolve() and not source.is_symlink(), 'unsafe-source')
    require(output.parent.resolve()==BASE.resolve() and not output.exists(), 'unsafe-audit-output')
    require(source.stat().st_size<=MAX_SOURCE,'compressed-source-limit')
    initial=resources(BASE);start=time.monotonic();cpu=time.process_time()
    rows=expanded=invalid=0;fields=collections.Counter();langs=collections.Counter();sources=collections.Counter();licenses=collections.Counter();groups=collections.Counter();types=collections.Counter();examples={};max_line=0
    present=collections.Counter();nutrient_nulls=collections.Counter();portions=collections.Counter();longest=collections.Counter()
    before=source.stat();digest=hashlib.sha256();invalid_examples=[]
    with source.open('rb') as f:
        for chunk in iter(lambda:f.read(1024**2),b''):digest.update(chunk)
    with gzip.open(source,'rb') as f:
        while True:
            raw=f.readline(MAX_LINE+1)
            if not raw:break
            rows+=1;expanded+=len(raw);max_line=max(max_line,len(raw))
            require(rows<=MAX_ROWS and expanded<=MAX_EXPANDED and len(raw)<=MAX_LINE,'archive-expansion-limit')
            if rows%5000==0:resources(BASE)
            try:
                row=parse_json(raw.decode('utf8'));require(type(row) is dict,'invalid-row')
            except (ValueError,UnicodeError,CatalogError) as error:
                invalid+=1
                if len(invalid_examples)<20:invalid_examples.append({'line':rows,'reason':str(error)[:100]})
                require(invalid<=100 and invalid/max(rows,1000)<=.01,'massive-invalid-input');continue
            fields.update(row.keys());langs[str(row.get('language'))]+=1;sources[str(row.get('source_name'))]+=1;licenses[str(row.get('license'))]+=1
            group=str(row.get('source_name'))+'|language='+str(row.get('language'))+'|license='+str(row.get('license'));groups[group]+=1
            complete=all(row.get(k) is not None and row.get(k)!='' for k in ('energy','protein','carbohydrates','fat'))
            present['fourMacrosPresent']+=complete;present['barcodePresent']+=bool(row.get('code'));present['brandPresent']+=bool(row.get('brand'));present['namePresent']+=bool(row.get('name'))
            for key in ('energy','protein','carbohydrates','fat','sodium','fiber'):
                nutrient_nulls[key]+=row.get(key) is None;types[key+':'+type(row.get(key)).__name__]+=1
            units=row.get('weight_units');portions['rowsWithPortions']+=bool(units);portions['totalPortions']+=len(units) if isinstance(units,list) else 0
            for key in ('name','brand','license_author','source_url'):
                if isinstance(row.get(key),str):longest[key]=max(longest[key],len(row[key]))
            source_kind=str(row.get('source_name'))
            if source_kind not in examples:examples[source_kind]=row
            require(all(len(v)<=5000 for v in (langs,sources,licenses,groups,fields)) and len(examples)<=50,'metadata-cardinality-limit')
    after=source.stat();require((before.st_ino,before.st_size,before.st_mtime_ns)==(after.st_ino,after.st_size,after.st_mtime_ns),'source-changed')
    report={'format':'opengym-wger-full-audit','version':1,'complete':True,'gzipCrcVerified':True,'sourceBytes':before.st_size,'sourceSha256':digest.hexdigest(),'rows':rows,'expandedBytes':expanded,'invalidRows':invalid,'invalidExamples':invalid_examples,'maxLineBytes':max_line,'fields':fields,'languageIds':langs,'sourceNames':sources,'licenseIds':licenses,'groups':groups,'presence':present,'nutrientNulls':nutrient_nulls,'nutrientTypes':types,'portions':portions,'maxTextLengths':longest,'examples':examples,'seconds':time.monotonic()-start,'cpuSeconds':time.process_time()-cpu,'peakRssKiB':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,'initialResources':initial,'finalResources':resources(BASE)}
    with output.open('x') as f:json.dump(report,f,ensure_ascii=False,indent=2);f.flush();os.fsync(f.fileno())
    fsync_directory(BASE);return report

if __name__=='__main__':
    import argparse
    p=argparse.ArgumentParser();p.add_argument('--output',required=True);a=p.parse_args()
    report=inventory(BASE/'wger-full-source'/'ingredients.jsonl.gz',BASE/a.output)
    print(json.dumps({k:v for k,v in report.items() if k not in ('examples','fields','groups','nutrientTypes')},ensure_ascii=False,indent=2))
