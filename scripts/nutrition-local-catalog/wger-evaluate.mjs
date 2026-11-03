// Offline evaluation of an explicitly captured small wger sample. No fetch/import
// of app sessions, native profiles, actual workout or Nutrition user directories.
import fs from 'node:fs'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {spawn} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {jsonLines} from './build.mjs'
import {normalizeWger} from './wger-normalize.mjs'
import {inspectExternal} from '../../frontend/src/lib/nutrition/catalog/normalize.js'
import {canonicalJson} from '../../frontend/src/lib/nutrition/persistence-contract.js'
import {createNutritionLocalStore} from '../../frontend/src/lib/nutrition/local-store.js'
import {nutritionFsBackend} from '../../frontend/src/lib/nutrition/local-store-fs.js'
import {createNutritionUISession} from '../../frontend/src/lib/nutrition/ui-session.js'
import {diskBridge} from '../../frontend/src/lib/nutrition/local-storage.test-util.js'
import {sumFoodEntries} from '../../frontend/src/lib/nutrition/calculate.js'
import assert from 'node:assert/strict'
const base=fileURLToPath(new URL('./artifacts/',import.meta.url)),safe=name=>typeof name==='string'&&/^[A-Za-z0-9_-]{1,40}$/.test(name)
const hash=data=>createHash('sha256').update(data).digest('hex')
function bounded(file,max){const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const buf=Buffer.alloc(max+1),length=fs.readSync(fd,buf,0,buf.length,0);assert.ok(length<=max,'oversized file');return buf.subarray(0,length)}finally{fs.closeSync(fd)}}
export async function journalProof(food){
 const disk=await diskBridge();let store,service
 const namespace={serverOrigin:null,profileId:'wger-evaluation-only'},session={userId:namespace.profileId,serverOrigin:null,epoch:1}
 const options={namespace,generation:'eval-generation',deviceId:'eval-device',backend:nutritionFsBackend({loadPlugin:async()=>disk.plugin})}
 try{
  store=await createNutritionLocalStore(options);service=createNutritionUISession({store,session,getSession:()=>session,online:()=>false})
  const row={schemaVersion:1,id:'wger-eval-entry',d:'2026-10-25',meal:'lunch',snapshot:food,quantity:{amount:50,unit:food.reference.unit}}
  await service.batch([{collection:'savedFoods',id:food.id,value:food,base:null},{collection:'foodEntries',id:row.id,value:row,base:null}]);service.close();service=null
  store=await createNutritionLocalStore({...options,backend:nutritionFsBackend({loadPlugin:async()=>disk.plugin})})
  const day=await store.readDay(row.d);assert.equal(day.entries.length,1);assert.deepEqual(day.entries[0].snapshot,food)
  const totals=sumFoodEntries(day.entries).totals
  for(const key of ['kcal','protein','carbs','fat'])assert.equal(totals[key],food.nutrients[key]===null?null:food.nutrients[key]/2)
  assert.ok((await store.inspect()).manifest.pendingOperations.length>0)
  return{passed:true,foodId:food.id,name:food.name,reference:food.reference,...(food.reference.unit==='g'?{per100g:food.nutrients}:{}),perReference:food.nutrients,quantity:row.quantity,totals,reopened:true,pendingPreserved:true,networkCalls:0,nativeDeviceValidated:false}
 }finally{service?.close();store?.close();await disk.cleanup()}
}
export async function evaluate(captureName,workspace){
 assert.ok(safe(captureName)&&safe(workspace)&&captureName!==workspace)
 const input=path.join(base,captureName),root=path.join(base,workspace);assert.ok(!fs.lstatSync(input).isSymbolicLink());fs.mkdirSync(root,{mode:0o700})
 const receipt=JSON.parse(bounded(path.join(input,'capture.json'),65536));inspectExternal(receipt)
 assert.equal(receipt.format,'opengym-wger-evaluation-capture');assert.equal(receipt.version,1);assert.equal(receipt.complete,true);assert.ok(receipt.prefix)
 for(const required of ['head.json','language.json','license.json','count.json','rows.jsonl'])assert.ok(Object.hasOwn(receipt.files,required),'missing verified file '+required)
 let total=0
 for(const [name,info] of Object.entries(receipt.files)){
  assert.match(name,/^(?:head|language|license|count|coverage-[0-8])\.json$|^rows\.jsonl$/)
  const bytes=bounded(path.join(input,name),name==='rows.jsonl'?16*1024**2:1024**2);total+=bytes.length;assert.ok(total<=32*1024**2)
  assert.equal(bytes.length,info.bytes);assert.equal(hash(bytes),info.sha256)
 }
 const languages=JSON.parse(bounded(path.join(input,'language.json'),1024**2)).results,licenses=JSON.parse(bounded(path.join(input,'license.json'),1024**2)).results
 inspectExternal(languages);inspectExternal(licenses);assert.ok(Array.isArray(languages)&&Array.isArray(licenses))
 const rows=new Map(),invalid={},conflicts=new Set();let prefixRows=0,duplicates=0
 async function add(row){
  try{
   const record=await normalizeWger(row,{languages,licenses}),digest=hash(canonicalJson(row))
   if(rows.has(record.id)){if(rows.get(record.id).digest!==digest)conflicts.add(record.id);else duplicates++;return}
   rows.set(record.id,{digest,record})
  }catch(error){const key=error.message.length<=60?error.message:'invalid-row';invalid[key]=(invalid[key]??0)+1}
 }
 const start=performance.now(),cpu=process.cpuUsage()
 for await(const line of jsonLines(fs.createReadStream(path.join(input,'rows.jsonl'),{highWaterMark:65536}))){prefixRows++;assert.ok(prefixRows<=2000);await add(JSON.parse(line))}
 assert.equal(prefixRows,receipt.prefix.rows)
 for(const query of receipt.coverageQueries??[]){
  assert.match(query.file,/^coverage-[0-8]\.json$/)
  const data=JSON.parse(bounded(path.join(input,query.file),1024**2));inspectExternal(data);assert.ok(Array.isArray(data.results)&&data.results.length<=10)
  for(const row of data.results)await add(row)
 }
 assert.ok(rows.size<=2100)
 const file=fs.openSync(path.join(root,'normalized.jsonl'),'wx',0o600)
 try{for(const [id,{record}] of rows){if(conflicts.has(id)){record.food=null;record.issues.push('divergent-capture-versions')};fs.writeSync(file,JSON.stringify(record)+'\n')}fs.fsyncSync(file)}finally{fs.closeSync(file)}
 const normalizeMs=performance.now()-start,provenance={fixture:receipt.fixture===true,source:'wger bounded capture; not a representative full export',capture:captureName,head:receipt.head,liveCountNotDumpCount:receipt.liveCountNotDumpCount,invalid,duplicates,divergentUUIDs:conflicts.size,normalizeMs,nodePeakRssKiB:process.resourceUsage().maxRSS,nodeCpuMs:(process.cpuUsage(cpu).user+process.cpuUsage(cpu).system)/1000}
 fs.writeFileSync(path.join(root,'capture-summary.json'),JSON.stringify(provenance,null,2))
 const child=spawn('python3',[fileURLToPath(new URL('./wger-sqlite.py',import.meta.url)),workspace],{stdio:['ignore','pipe','pipe']})
 let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b)
 const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve)});assert.equal(code,0,stderr)
 const report=JSON.parse(stdout);report.capture=provenance
 const eligible=[...rows.values()].map(x=>x.record).filter(p=>p.food&&p.complete),proofs=[]
 for(const record of eligible.slice(0,3))proofs.push(await journalProof(record.food))
 report.journalProofs=proofs;report.externalCallsDuringEvaluation=0
 fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(report,null,2));return report
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])){
 try{assert.equal(process.argv.length,4,'usage: node wger-evaluate.mjs captureWorkspace NEW-evalWorkspace');console.log(JSON.stringify(await evaluate(process.argv[2],process.argv[3]),null,2))}
 catch(error){console.error(error.message);process.exitCode=1}
}
