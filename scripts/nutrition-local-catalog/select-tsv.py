"""Bounded France/world projection of a locally supplied official TSV gzip.

Does not download, publish or alter a catalogue. Reads the gzip to EOF (CRC),
retains only public TSV columns, and seals an exclusive output plus receipt.
Limits concern scanned rows, retained rows and decompressed bytes separately.
"""
import argparse
import gzip
import hashlib
import heapq
import math
import sqlite3
import json
import os
from pathlib import Path
import re
import resource
import sys
import time
from catalog import BASE, resources, fsync_directory, CatalogError, require
from tsv import rows, FIELDS

MAX_COMPRESSED=2*1024**3
MAX_EXPANDED=24*1024**3
MAX_SCANNED=8_000_000
MAX_RETAINED=100_000
MAX_OUTPUT=256*1024**2
MAX_SECONDS=4*3600
MAX_STAGING=1024**3
SELECTION_SEED=b'opengym-off-v1-fr-world-selection-v2\0'

class CheckedReader:
    def __init__(self, stream):
        self.stream=stream; self.bytes=0; self.hash=hashlib.sha256()
    def read(self, amount=-1):
        require(0<=amount<=1024*1024,'unbounded-source-read')
        chunk=self.stream.read(amount);self.bytes+=len(chunk)
        require(self.bytes<=MAX_COMPRESSED,'compressed-source-limit')
        self.hash.update(chunk);return chunk

class ExpandedReader:
    def __init__(self, stream):
        self.stream=stream;self.bytes=0;self.hash=hashlib.sha256()
    def readline(self, amount):
        chunk=self.stream.readline(amount);self.bytes+=len(chunk)
        require(self.bytes<=MAX_EXPANDED,'expanded-source-limit')
        self.hash.update(chunk);return chunk


def select(source, destination, france=80000, international=20000):
    require(type(france) is int and type(international) is int and france>=0 and international>=0 and 0<france+international<=MAX_RETAINED,'invalid-selection-budgets')
    source=Path(source);destination=Path(destination)
    base=BASE.resolve()
    require(source.is_file() and not source.is_symlink() and source.resolve().is_relative_to(base),'unsafe-source-path')
    require(destination.resolve().parent.is_relative_to(base) and re.fullmatch(r'[A-Za-z0-9_-]{1,40}',destination.name),'unsafe-destination-path')
    require(source.stat().st_size<=MAX_COMPRESSED,'source-too-large')
    # Exclusive workspace: an interrupted attempt is inspected, never overwritten.
    require(not destination.exists(),'selection-workspace-exists')
    resources(destination.parent)
    destination.mkdir(mode=0o700)
    started=time.monotonic();before=resource.getrusage(resource.RUSAGE_SELF)
    counts={'scanned':0,'retained':0,'france':0,'international':0,'invalidIdentity':0,'outsideBudget':0,'duplicates':0}
    columns=sorted(FIELDS);output=destination/'selected.tsv';partial=destination/'selected.tsv.partial'
    header=('\t'.join(columns)+'\n').encode();size=len(header);out_hash=hashlib.sha256()
    # Only ranking keys live in RAM. Descriptor payloads and the full duplicate
    # registry live on disk, with a separate 1 GiB SQLite page limit.
    heaps={'france':[], 'international':[]};eligible={'france':0,'international':0}
    replaced={'france':0,'international':0};hints={'france':0,'international':0}
    staging=sqlite3.connect(destination/'selection.sqlite')
    def canonical_code(code):
        digits=code.lstrip('0');return digits.zfill(8 if len(digits)<=8 else 13 if len(digits)<=13 else 14)
    def nutrition_hint(row):
        # Selection preference only, NEVER a validated nutritional reference.
        if row.get('no_nutrition_data') in ('1','on'):return 0
        if any(re.match(r'en:(nutrition-|energy-)',tag.strip()) for tag in row.get('data_quality_errors_tags','').split(',')):return 0
        keys=('energy-kcal_100g','proteins_100g','carbohydrates_100g','fat_100g')
        for key in keys:
            value=row.get(key,'')
            if not re.fullmatch(r'\d+(?:\.\d+)?',value):return 0
            number=float(value)
            if not math.isfinite(number) or number>(2000 if key.startswith('energy') else 100):return 0
        return 1
    try:
        staging.executescript(f"""
            PRAGMA page_size=4096;
            PRAGMA cache_size=-8192;
            PRAGMA temp_store=MEMORY;
            PRAGMA journal_mode=DELETE;
            PRAGMA synchronous=FULL;
            PRAGMA max_page_count={MAX_STAGING // 4096};
            CREATE TABLE seen(code TEXT PRIMARY KEY, digest BLOB NOT NULL) WITHOUT ROWID;
            CREATE TABLE candidates(code TEXT PRIMARY KEY, cohort TEXT NOT NULL, hint INTEGER NOT NULL, line BLOB NOT NULL) WITHOUT ROWID;
        """)
        with source.open('rb') as fd:
            compressed=CheckedReader(fd)
            with gzip.GzipFile(fileobj=compressed,mode='rb') as gzip_stream:
                expanded=ExpandedReader(gzip_stream)
                for row in rows(expanded):
                    counts['scanned']+=1;require(counts['scanned']<=MAX_SCANNED,'scanned-row-limit')
                    if counts['scanned']%500==0:
                        staging.commit();resources(destination);require(time.monotonic()-started<=MAX_SECONDS,'selection-deadline')
                    code=row.get('code','');name=row.get('product_name_fr') or row.get('product_name') or row.get('product_name_en') or row.get('generic_name') or ''
                    if not re.fullmatch(r'(?:\d{8}|\d{12,14})',code,re.ASCII) or not name.strip() or len(name)>300:
                        counts['invalidIdentity']+=1;continue
                    cohort='france' if 'en:france' in [tag.strip() for tag in row.get('countries_tags','').split(',')] else 'international'
                    budget=france if cohort=='france' else international
                    line=('\t'.join(row.get(k,'') for k in columns)+'\n').encode()
                    code_key=canonical_code(code);identity=hashlib.sha256(line).digest()
                    previous=staging.execute('SELECT digest FROM seen WHERE code=?',(code_key,)).fetchone()
                    if previous:
                        require(previous[0]==identity,'conflicting-selected-barcode');counts['duplicates']+=1;continue
                    staging.execute('INSERT INTO seen VALUES (?,?)',(code_key,identity))
                    eligible[cohort]+=1;hint=nutrition_hint(row);hints[cohort]+=hint
                    # Lowest rank wins; the heap root is the worst retained rank.
                    # Source order, offsets and barcode prefixes cannot affect the
                    # final sample. A complete-data hint wins over a missing one.
                    score=int.from_bytes(hashlib.sha256(SELECTION_SEED+code_key.encode('ascii')).digest(),'big')
                    rank=(1-hint,score,int(code_key));heap=heaps[cohort]
                    worst=(-heap[0][0],-heap[0][1],-heap[0][2]) if heap else None
                    if not budget or (len(heap)>=budget and rank>=worst):
                        counts['outsideBudget']+=1;continue
                    if len(heap)>=budget:
                        old=heapq.heappop(heap);old_code=old[3]
                        length=staging.execute('SELECT length(line) FROM candidates WHERE code=?',(old_code,)).fetchone()[0]
                        staging.execute('DELETE FROM candidates WHERE code=?',(old_code,));size-=length;replaced[cohort]+=1
                    size+=len(line);require(size<=MAX_OUTPUT,'selection-output-limit')
                    staging.execute('INSERT INTO candidates VALUES (?,?,?,?)',(code_key,cohort,hint,line))
                    heapq.heappush(heap,(-rank[0],-rank[1],-rank[2],code_key))
        staging.commit();require(compressed.bytes==source.stat().st_size,'source-size-changed')
        require(staging.execute('PRAGMA integrity_check').fetchone()[0]=='ok','selection-staging-corrupt')
        require((destination/'selection.sqlite').stat().st_size<=MAX_STAGING,'selection-staging-limit')
        resources(destination);require(time.monotonic()-started<=MAX_SECONDS,'selection-deadline')
        with partial.open('xb') as target:
            target.write(header);out_hash.update(header)
            for (line,) in staging.execute('SELECT line FROM candidates ORDER BY code'):
                target.write(line);out_hash.update(line)
            target.flush();os.fsync(target.fileno())
        counts['france']=len(heaps['france']);counts['international']=len(heaps['international']);counts['retained']=counts['france']+counts['international'];counts['outsideBudget']=sum(eligible.values())-counts['retained']
        retained_hints={cohort:staging.execute('SELECT count(*) FROM candidates WHERE cohort=? AND hint=1',(cohort,)).fetchone()[0] for cohort in heaps}
        receipt={'format':'opengym-off-tsv-selection','version':2,'complete':True,'source':'https://static.openfoodfacts.org/data/en.openfoodfacts.org.products.csv.gz','sourceCompressedSha256':compressed.hash.hexdigest(),'sourceExpandedSha256':expanded.hash.hexdigest(),'compressedBytes':compressed.bytes,'expandedBytes':expanded.bytes,'gzipCrcVerified':True,'sampledNotRepresentative':True,'orderIndependent':True,'selection':'full-source deterministic bottom-k by canonical barcode hash, per-country cohort; complete raw fields hint first; no popularity claim','selectionSeed':SELECTION_SEED[:-1].decode(),'budgets':{'france':france,'international':international},'counts':counts,'eligible':eligible,'rawCompleteHintEligible':hints,'rawCompleteHintRetained':retained_hints,'replacements':replaced,'selectedBytes':size,'selectedSha256':out_hash.hexdigest(),'stagingBytes':(destination/'selection.sqlite').stat().st_size,'seconds':time.monotonic()-started,'peakRssKiB':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,'cpuSeconds':resource.getrusage(resource.RUSAGE_SELF).ru_utime+resource.getrusage(resource.RUSAGE_SELF).ru_stime-before.ru_utime-before.ru_stime,'license':'ODbL-1.0','contentLicense':'DbCL-1.0','attribution':'Open Food Facts contributors'}
        os.link(partial,output);partial.unlink();fsync_directory(destination)
        with (destination/'selection-manifest.json').open('x') as manifest:json.dump(receipt,manifest,ensure_ascii=False);manifest.flush();os.fsync(manifest.fileno())
        fsync_directory(destination);return receipt
    finally:
        # Never remove a previous generation or interrupted workspace. Only the
        # complete receipt permits handing the projection to the importer.
        staging.close()


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--source',required=True);parser.add_argument('--destination',required=True);parser.add_argument('--france',type=int,default=80000);parser.add_argument('--international',type=int,default=20000);args=parser.parse_args()
    soft,hard=resource.getrlimit(resource.RLIMIT_AS);resource.setrlimit(resource.RLIMIT_AS,(256*1024**2 if soft==-1 else min(soft,256*1024**2),hard))
    try:print(json.dumps(select(args.source,args.destination,args.france,args.international),ensure_ascii=False,indent=2))
    except (CatalogError,sqlite3.Error,OSError,ValueError,EOFError,MemoryError) as error:print(json.dumps({'error':str(error) if isinstance(error,CatalogError) else 'selection-storage-or-source-error'}),file=sys.stderr);return 1
    return 0
if __name__=='__main__':sys.exit(main())
