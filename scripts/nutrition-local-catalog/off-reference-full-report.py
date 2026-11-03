"""Read-only full-complement audit and bounded deterministic journal sample.
No network, ranking, production pointer or user storage access.
"""
import argparse,collections,hashlib,importlib.util,json,math,os,resource,time
from pathlib import Path
from catalog import canonical,digest_file,parse_json,require,resources
s=importlib.util.spec_from_file_location('overlay',Path(__file__).with_name('off-reference-overlay.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
# Curated maintenance controls are separate from the frozen public benchmark.
# Their actual dump values/status are reported, never filled from former API probes.
CONTROLS=(('Nutella','3017620422003'),('Coca-Cola','5449000000996'),('milk','3250392190484'),('coconut oil','3760295170051'),('pastry','3531150222020'),('yoghurt','3770011205004'))
def audit(overlay_name,benchmark_name,output):
 start=time.monotonic();cpu=time.process_time()
 memory=[]
 def observe(phase):
  peak=next(int(line.split()[1])for line in Path('/proc/self/status').read_text().splitlines()if line.startswith('VmHWM:'))
  require(peak<=512*1024,'audit-process-memory-budget')
  memory.append({'phase':phase,'pythonPeakRssKiB':peak,'rusageMaxRssKiB':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss})
  print(canonical({'event':'reference-audit-memory',**memory[-1]}),flush=True)
 observe('startup')
 root=m.root(overlay_name);manifest=parse_json((root/'current.json').read_text());require(manifest.get('complete')is True and manifest.get('fullDumpVerified')is True and manifest.get('productionAllowed')is False,'not-a-verified-full-complement')
 require(__import__('re').fullmatch(r'reference-[a-f0-9]{32}\.sqlite',manifest.get('file','')),'unsafe-generation')
 file=root/manifest['file'];require(file.stat().st_size==manifest['bytes']and digest_file(file)==manifest['sha256'],'corrupt-generation')
 observe('generation-hash-verified')
 dest=m.root(output,True);budget=resources(m.BASE);minima={'minFreeDiskBytes':budget['freeDiskBytes'],'minAvailableMemoryBytes':budget['availableMemoryBytes']};db=m.ro(file);counts=collections.Counter();cohorts=collections.Counter();units=collections.Counter();source_sets=collections.Counter();reasons=collections.Counter();strata={};records=0
 try:
  require(db.execute('PRAGMA integrity_check').fetchone()[0]=='ok','sqlite-integrity-failed')
  observe('sqlite-integrity-verified')
  for key,status,flags,payload in db.execute('SELECT key,status,flags,payload FROM records ORDER BY key'):
   records+=1;counts[status]+=1
   if records%100000==0:observe('records-'+str(records))
   if records%1000==0:
    budget=resources(m.BASE);minima['minFreeDiskBytes']=min(minima['minFreeDiskBytes'],budget['freeDiskBytes']);minima['minAvailableMemoryBytes']=min(minima['minAvailableMemoryBytes'],budget['availableMemoryBytes'])
   p=parse_json(payload)
   if status!='accepted':
    for rejected in p.get('rejectedInputSets',[]):reasons[rejected['reason']]+=1
    continue
   food=p['food'];ref=food['reference'];lineage=food['source']['offReference'];unit=ref['unit']
   require(p.get('ok')is True and ref==p['reference']and ref['amount']==100 and unit in ('g','ml')and food.get('schemaVersion')==1 and food.get('kind')=='food','invalid-accepted-food')
   require(food['source']['kind']=='open-food-facts'and food['source']['license']['id']=='ODbL-1.0'and food['source']['contentLicense']=='DbCL-1.0'and lineage==p['lineage']and lineage['preparation']=='as_sold'and lineage['per']==('100g'if unit=='g'else'100ml'),'invalid-source-lineage')
   require(p.get('sourceKind')=='raw-jsonl'and lineage.get('kind')=='raw-jsonl','unexpected-api-data-in-full-complement')
   require(all(type(food['nutrients'].get(k))in(int,float)and math.isfinite(food['nutrients'][k])and food['nutrients'][k]>=0 for k in ('kcal','protein','carbs','fat')),'invalid-accepted-values')
   require(lineage['source']in('manufacturer','packaging','usda'),'invalid-declared-source')
   units[unit]+=1;source_sets[lineage['source']]+=1;cohorts['acceptedObservedInFrance']+=bool(flags&2);cohorts['acceptedWgerFrenchLanguage']+=bool(flags&1)
   rank=hashlib.sha256(('off-full-journal-v1\0'+key).encode()).hexdigest();group=(unit,lineage['source']);bucket=strata.setdefault(group,[])
   item={'rank':rank,'key':key,'code':p['code'],'food':food,'scopes':['reference-source-stratum']}
   if len(bucket)<10 or rank<bucket[-1]['rank']:bucket.append(item);bucket.sort(key=lambda r:r['rank']);del bucket[10:]
  require(records==manifest['rows']and counts['accepted']==manifest['accepted']and cohorts['acceptedObservedInFrance']==manifest['acceptedObservedInFrance'],'manifest-count-mismatch')
  observe('all-records-verified')
  benchmark=m.root(benchmark_name);bm=parse_json((benchmark/'benchmark.json').read_text());require(bm.get('complete')is True and digest_file(benchmark/'cases.jsonl')==bm['casesSha256'],'corrupt-benchmark')
  matched=[];barcodes=0;case_count=0;benchmark_status=collections.Counter();samples={item['key']:item for values in strata.values()for item in values}
  for line in (benchmark/'cases.jsonl').read_text().splitlines():
   c=parse_json(line);case_count+=1;code=c.get('expectedCode')
   if not code:continue
   barcodes+=1;key=m.ids.canonical(code);row=db.execute("SELECT payload,status FROM records WHERE key=?",(key,)).fetchone()
   if row is None:benchmark_status['not-captured']+=1;continue
   benchmark_status[row[1]]+=1
   p=parse_json(row[0])
   if row[1]!='accepted':continue
   require(m.ids.canonical(p['code'])==key,'benchmark-barcode-mismatch')
   matched.append({'caseId':c['caseId'],'code':code,'reference':p['reference'],'name':p['food']['name'],'brand':p['food'].get('brand',''),'sourceQuery':c.get('query'),'relevance':'exact-expected-barcode'})
   if key in samples:samples[key]['scopes'].append('independent-benchmark')
   else:samples[key]={'key':key,'code':code,'food':p['food'],'scopes':['independent-benchmark']}
  require(case_count==bm['cases'],'benchmark-count-mismatch')
  controls=[]
  for label,code in CONTROLS:
   key=m.ids.canonical(code);row=db.execute('SELECT payload,status FROM records WHERE key=?',(key,)).fetchone()
   control={'label':label,'code':code,'status':row[1]if row else'not-captured','selection':'curated-maintenance-control-not-benchmark'}
   if row and row[1]=='accepted':
    p=parse_json(row[0]);require(m.ids.canonical(p['code'])==key,'control-barcode-mismatch')
    control.update(name=p['food']['name'],brand=p['food'].get('brand',''),reference=p['reference'],nutrients=p['food']['nutrients'],declaredSource=p['lineage']['source'])
    if key in samples:samples[key]['scopes'].append('curated-maintenance-control')
    else:samples[key]={'key':key,'code':code,'food':p['food'],'scopes':['curated-maintenance-control']}
   controls.append(control)
  sample={'format':'opengym-off-journal-sample','version':1,'complete':True,'overlay':overlay_name,'overlaySha256':manifest['sha256'],'benchmarkSha256':digest_file(benchmark/'benchmark.json'),'selection':'all validated expected benchmark codes plus up to ten hash-selected foods per unit/source stratum and separately reported curated maintenance controls','foods':list(samples.values())}
  wire=(canonical(sample)+'\n').encode();require(len(wire)<=16*1024**2 and len(samples)<=1000,'journal-sample-budget')
  with(dest/'journal-sample.json').open('xb')as f:os.fchmod(f.fileno(),0o600);f.write(wire);f.flush();os.fsync(f.fileno())
  report={'complete':True,'overlay':overlay_name,'overlaySha256':manifest['sha256'],'fullDumpVerified':True,'sqliteIntegrity':'ok','rows':records,'statusCounts':dict(counts),'acceptedByReferenceUnit':dict(units),'acceptedByDeclaredSource':dict(source_sets),'inputSetRejectionReasons':dict(reasons),'acceptedObservedInFrance':cohorts['acceptedObservedInFrance'],'acceptedWgerFrenchLanguage':cohorts['acceptedWgerFrenchLanguage'],'benchmarkCases':case_count,'benchmarkSupportedBarcodes':barcodes,'benchmarkCapturedCodes':barcodes-benchmark_status['not-captured'],'benchmarkReferenceStatusCounts':dict(benchmark_status),'validatedBenchmarkCodes':len(matched),'benchmarkMatches':matched,'relevanceDefinition':'Exact expected barcode identity, not human semantic judgements or text ranking. The frozen benchmark and missing query labels are unchanged.','precisionAt5':None,'curatedControls':controls,'journalSampleFoods':len(samples),'journalSampleSha256':hashlib.sha256(wire).hexdigest(),'strata':{unit+'/'+source:len(values)for(unit,source),values in strata.items()},'networkCalls':0,'applicationActivated':False,'nationalCoverageClaim':False,'seconds':time.monotonic()-start}
  observe('journal-sample-written')
  report.update(cpuSeconds=time.process_time()-cpu,pythonPeakRssKiB=memory[-1]['pythonPeakRssKiB'],pythonRusageMaxRssKiB=memory[-1]['rusageMaxRssKiB'],memoryMetric='linux-process-VmHWM',memoryCheckpoints=memory,resources=minima)
  m.write(dest,'report.json',report);return report
 finally:db.close()
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--overlay',required=True);p.add_argument('--benchmark',required=True);p.add_argument('--workspace',required=True);a=p.parse_args()
 try:
  result=audit(a.overlay,a.benchmark,a.workspace);print(canonical({**result,'benchmarkMatchesCount':len(result['benchmarkMatches']),'benchmarkMatches':'see report.json'}))
 except Exception as e:print(canonical({'error':str(e)if isinstance(e,m.CatalogError)else type(e).__name__}),file=__import__('sys').stderr);raise SystemExit(1)
