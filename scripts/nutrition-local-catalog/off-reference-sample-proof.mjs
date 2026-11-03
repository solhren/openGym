import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
import assert from 'node:assert/strict'
import {journalProof} from './wger-evaluate.mjs'
import {nutrientsForQuantity} from '../../frontend/src/lib/nutrition/calculate.js'
import {validateFood} from '../../frontend/src/lib/nutrition/validate.js'
import {inspectExternal} from '../../frontend/src/lib/nutrition/catalog/normalize.js'
const base=fileURLToPath(new URL('./artifacts/',import.meta.url))
export async function proof(inputName,outputName,{allowPartialSource=false}={}){
 assert.ok([inputName,outputName].every(n=>typeof n==='string'&&/^[A-Za-z0-9_-]{1,40}$/.test(n)))
 const input=path.join(base,inputName),root=path.join(base,outputName);assert.ok(!fs.lstatSync(input).isSymbolicLink()&&!fs.lstatSync(base).isSymbolicLink());fs.mkdirSync(root,{mode:0o700})
 const file=path.join(input,'journal-sample.json');assert.ok(!fs.lstatSync(file).isSymbolicLink()&&fs.statSync(file).size<=16*1024**2)
 const wire=fs.readFileSync(file),report=JSON.parse(fs.readFileSync(path.join(input,'report.json')))
 const partial=report.complete===false&&report.analysisComplete===true&&report.extractionComplete===false&&report.fullDumpVerified===false&&report.productionAllowed===false&&report.format==='opengym-off-partial-reference-audit'
 assert.ok(report.complete===true||(allowPartialSource&&partial),'incomplete source requires explicit laboratory-only flag');assert.equal(createHash('sha256').update(wire).digest('hex'),report.journalSampleSha256)
 const sample=JSON.parse(wire);assert.equal(sample.format,'opengym-off-journal-sample');assert.equal(sample.complete,true);assert.equal(sample.overlaySha256,report.overlaySha256);assert.ok(sample.foods.length===report.journalSampleFoods&&sample.foods.length<=1000)
 const start=performance.now(),proofs=[]
 for(const row of sample.foods){
  if(partial)assert.equal(row.food.source.offReference.sourceIntegrity,'partial-checkpoint-no-full-gzip-crc')
  inspectExternal(row.food);assert.deepEqual(validateFood(row.food),[]);assert.equal(row.food.reference.amount,100)
  assert.throws(()=>nutrientsForQuantity(row.food,{amount:50,unit:row.food.reference.unit==='g'?'ml':'g'}))
  const result=await journalProof(row.food);proofs.push({code:row.code,scopes:row.scopes,...result})
  if(proofs.length%50===0)console.log(JSON.stringify({event:'journal-proof-progress',passed:proofs.length,total:sample.foods.length}))
 }
 const peak=Number(fs.readFileSync('/proc/self/status','utf8').match(/^VmHWM:\s+(\d+)/m)?.[1]);assert.ok(Number.isFinite(peak)&&peak<=512*1024)
 const result={complete:true,scope:'journal-tests-only',partialSourceCoverage:partial,fullDumpVerified:!partial,passed:proofs.length,proofs,overlaySha256:sample.overlaySha256,journalSampleSha256:report.journalSampleSha256,seconds:(performance.now()-start)/1000,nodePeakRssKiB:peak,memoryMetric:'linux-process-VmHWM',networkCalls:0,applicationActivated:false,realNativeDevice:false}
 fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(result,null,2),{flag:'wx',mode:0o600});console.log(JSON.stringify({...result,proofs:'see report.json'}));return result
}
if(process.argv[1]===fileURLToPath(import.meta.url)){const args=process.argv.slice(2).filter(v=>v!=='--allow-partial-source');proof(args[0],args[1],{allowPartialSource:process.argv.includes('--allow-partial-source')}).catch(e=>{console.error(e);process.exitCode=1})}
