/** Real immutable catalogue -> anonymous HTTP -> client DTO -> durable journal.
 * All writes belong to a NEW laboratory workspace. No application deployment.
 */
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import assert from 'node:assert/strict'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
import {WgerCatalogWorker} from './wger-worker-client.mjs'
import {createWgerLocalCatalog} from './wger-api-adapter.mjs'
import {createWgerRelay} from '../../api/nutrition/catalog-wger.js'
import {foodCatalogRoutes} from '../../api/nutrition/food-catalog.js'
import {createFoodCatalog} from '../../frontend/src/lib/nutrition/catalog/client.js'
import {createNutritionLocalStore} from '../../frontend/src/lib/nutrition/local-store.js'
import {nutritionFsBackend} from '../../frontend/src/lib/nutrition/local-store-fs.js'
import {createNutritionUISession} from '../../frontend/src/lib/nutrition/ui-session.js'
import {diskBridge} from '../../frontend/src/lib/nutrition/local-storage.test-util.js'
import {nutrientsForQuantity,sumFoodEntries} from '../../frontend/src/lib/nutrition/calculate.js'

const base=fileURLToPath(new URL('./artifacts/',import.meta.url))
const names={base:'wger-full-registered-20261025',quality:'wger-fr-quality-20261026',reference:'off-reference-full2-20261026',index:'wger-off-search-20261026'}
const peak=pid=>{try{return Number(fs.readFileSync(`/proc/${pid}/status`,'utf8').match(/^VmHWM:\s+(\d+)/m)?.[1]??0)}catch{return 0}}
const resources=()=>{
 const disk=fs.statfsSync(base),available=Number(fs.readFileSync('/proc/meminfo','utf8').match(/^MemAvailable:\s+(\d+)/m)[1])*1024
 assert.ok(disk.bavail*disk.bsize>=20*1024**3&&available>=2*1024**3,'VPS safety margin');return {freeDiskBytes:disk.bavail*disk.bsize,availableMemoryBytes:available}
}
export async function check(output){
 assert.match(output,/^[A-Za-z0-9_-]{1,40}$/);assert.ok(!fs.lstatSync(base).isSymbolicLink());const root=path.join(base,output);fs.mkdirSync(root,{mode:0o700});resources()
 const started=performance.now(),report={complete:false,scope:'isolated-real-catalogue-http-journal',names,applicationProductionActivated:false,realBrowser:false,realNativeDevice:false,externalFoodCalls:0,search:[],journal:[],errors:[]}
 let server,relay,catalog,disk,store,service;let pythonPeak=0
 const worker=new WgerCatalogWorker(names.base,{localV1:true,complement:names.quality,reference:names.reference,referenceIndex:names.index})
 const save=()=>fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(report,null,2),{mode:0o600})
 try{
  relay=createWgerRelay({worker,catalog:createWgerLocalCatalog(worker)});let tick=performance.now();const info=await worker.request('inspect');report.startupMs=performance.now()-tick;report.catalogueVersion=info.catalogueVersion
  let routes;server=http.createServer((req,res)=>{
   assert.equal(req.headers.authorization,undefined);assert.equal(req.headers.cookie,undefined)
   const fn=routes[req.method+' '+new URL(req.url,'http://x').pathname];if(fn)fn(req,res);else{res.writeHead(404);res.end()}
  })
  routes=foodCatalogRoutes({relay,origin:'http://localhost:5175',limitAddress:()=> '127.0.0.1',onEvent:()=>{},json:(res,status,body,headers)=>{res.writeHead(status,{'Content-Type':'application/json',...headers});res.end(JSON.stringify(body))}})
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});const origin='http://127.0.0.1:'+server.address().port
  catalog=createFoodCatalog({localOnlyV1:true,transport:async()=>{report.externalFoodCalls++;throw Error('external food provider forbidden')},localTransport:async p=>{const r=await fetch(origin+p);r.catalogRelay=true;return r},capabilitiesTransport:()=>fetch(origin+'/api/nutrition/catalog/capabilities')});assert.equal((await catalog.capabilities()).selection,'local-only')
  for(const q of ['Nutella','Coca-Cola','lait','riz','pâtes','yaourt','œufs','banane','poulet','Carrefour','Auchan','Leclerc','Nestlé','Bonne Maman']){
   tick=performance.now()
   try{
    const r=await catalog.search(q);assert.equal(new Set(r.products.map(p=>p.id)).size,r.products.length)
    report.search.push({q,ms:performance.now()-tick,returned:r.products.length,addable:r.products.filter(p=>p.food).length,hasMore:r.hasMore,top:r.products.slice(0,5).map(p=>({id:p.id,code:p.code,name:p.name,brand:p.brand,addable:!!p.food,reference:p.reference}))})
   }catch(e){report.errors.push({q,code:e.code??e.name});report.search.push({q,error:e.code??e.name,ms:performance.now()-tick})}
   pythonPeak=Math.max(pythonPeak,peak(worker.child?.pid));resources();console.log(JSON.stringify({event:'real-search',...report.search.at(-1),top:undefined}))
  }
  const storage=path.join(root,'journal-sandbox');fs.mkdirSync(storage,{mode:0o700});disk=await diskBridge({baseDirectory:storage})
  const namespace={serverOrigin:null,profileId:'real-catalogue-proof'},session={userId:namespace.profileId,serverOrigin:null,epoch:1}
  const open=async()=>{store=await createNutritionLocalStore({namespace,generation:'runtime-proof',deviceId:'runtime-proof-device',backend:nutritionFsBackend({loadPlugin:async()=>disk.plugin})});service=createNutritionUISession({store,session,getSession:()=>session,online:()=>false});await service.refresh()}
  await open()
  for(const code of ['3017620422003','5449000000996','3250392190484','3531150222020','3760295170051']){
   const p=(await catalog.product(code)).product;assert.ok(p.food);const f=p.food;const row={schemaVersion:1,id:'entry-'+code,d:'2026-10-26',meal:'lunch',snapshot:f,quantity:{amount:50,unit:f.reference.unit}}
   await service.batch([{collection:'savedFoods',id:f.id,value:f,base:null},{collection:'foodEntries',id:row.id,value:row,base:null}]);assert.throws(()=>nutrientsForQuantity(f,{amount:50,unit:f.reference.unit==='g'?'ml':'g'}))
   await service.save('foodEntries',{...row,quantity:{amount:75,unit:f.reference.unit}},row);service.close();await open()
   const day=await service.day(row.d),entry=day.entries.find(r=>r.id===row.id);assert.deepEqual(entry.snapshot,f);assert.equal(entry.quantity.amount,75)
   const totals=sumFoodEntries(day.entries).totals,expected=nutrientsForQuantity(f,entry.quantity)
   for(const k of ['kcal','protein','carbs','fat'])assert.ok(Math.abs(totals[k]-expected[k])<1e-9)
   await service.remove('foodEntries',entry);assert.equal((await service.day(row.d)).entries.length,0);assert.ok((await store.inspect()).manifest.pendingOperations.length>0)
   report.journal.push({code,name:f.name,reference:f.reference,nutrients:f.nutrients,passed:true,reopened:true,edited:true,deleted:true,pendingRetained:true})
  }
  // All supported expected codes, with the original frame and missing labels.
  // Direct reader calls avoid turning a bounded data audit into an HTTP flood.
  const frame=path.join(base,'prices-pq-cases-20261026'),manifest=JSON.parse(fs.readFileSync(path.join(frame,'benchmark.json'))),wire=fs.readFileSync(path.join(frame,'cases.jsonl'));assert.equal(createHash('sha256').update(wire).digest('hex'),manifest.casesSha256)
  const referenceAudit=JSON.parse(fs.readFileSync(path.join(base,'off-full-audit2-reviewed-20261026/report.json'))),expectedCases=new Set(referenceAudit.benchmarkMatches.map(r=>r.caseId)),foundCases=new Set(),timings=[]
  let cases=0,codes=0,found=0,addable=0,ambiguous=0
  const api=createWgerLocalCatalog(worker)
  for(const line of wire.toString('utf8').trimEnd().split('\n')){
   const c=JSON.parse(line);cases++;if(!c.expectedCode)continue;codes++;tick=performance.now();const variants=await api.barcode(c.expectedCode);timings.push(performance.now()-tick)
   const usable=variants.filter(v=>v.food);found+=variants.length>0;ambiguous+=usable.length>1||variants.length===20
   if(usable.length===1&&variants.length<20){addable++;foundCases.add(c.caseId)}
   if(codes%100===0){resources();console.log(JSON.stringify({event:'real-barcode-benchmark',codes,found,addable}))}
  }
  report.benchmark={cases,codes,found,addable,ambiguous,expectedValidatedReferences:expectedCases.size,lostValidatedCases:[...expectedCases].filter(id=>!foundCases.has(id)),frameSha256:manifest.casesSha256,meanBarcodeMs:timings.reduce((a,b)=>a+b,0)/timings.length,p95BarcodeMs:timings.sort((a,b)=>a-b)[Math.ceil(.95*timings.length)-1],relevance:'exact expected barcode; no human text-relevance claim'}
  assert.equal(cases,manifest.cases);assert.equal(report.benchmark.lostValidatedCases.length,0);assert.equal(report.externalFoodCalls,0)
  report.complete=report.errors.length===0;report.resources=resources();report.pythonPeakRssKiB=Math.max(pythonPeak,peak(worker.child?.pid));report.nodePeakRssKiB=peak(process.pid);report.seconds=(performance.now()-started)/1000;save()
  if(!report.complete)throw Error('real catalogue query failures: see report')
  console.log(JSON.stringify({...report,search:'see report.json',journal:'see report.json'}));return report
 }catch(e){report.error=e.code??e.message;report.seconds=(performance.now()-started)/1000;save();throw e}
 finally{catalog?.close();service?.close();store?.close();if(server?.listening){server.closeAllConnections();await new Promise(r=>server.close(r))}await relay?.close();await disk?.cleanup()}
}
if(process.argv[1]===fileURLToPath(import.meta.url))check(process.argv[2]).catch(e=>{console.error(e.code??e.message);process.exitCode=1})
