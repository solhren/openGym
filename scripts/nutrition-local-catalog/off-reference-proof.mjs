import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'
import assert from 'node:assert/strict'
import {journalProof} from './wger-evaluate.mjs'
import {nutrientsForQuantity} from '../../frontend/src/lib/nutrition/calculate.js'
import {validateFood} from '../../frontend/src/lib/nutrition/validate.js'
export async function proof(overlay,output){
 assert.ok([overlay,output].every(v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,40}$/.test(v)))
 const base=fileURLToPath(new URL('./artifacts/',import.meta.url)),root=path.join(base,output);assert.ok(!fs.lstatSync(base).isSymbolicLink());fs.mkdirSync(root,{mode:0o700})
 const child=spawnSync('python3',[fileURLToPath(new URL('./off-reference-overlay.py',import.meta.url)),'foods','--overlay',overlay],{maxBuffer:4*1024**2,encoding:'utf8',timeout:30000})
 assert.equal(child.status,0,child.stderr);const records=JSON.parse(child.stdout);assert.ok(records.complete)
 const start=performance.now(),proofs=[]
 for(const p of records.foods){
  assert.deepEqual(validateFood(p.food),[])
  assert.throws(()=>nutrientsForQuantity(p.food,{amount:100,unit:p.reference.unit==='ml'?'g':'ml'}),'density-free mass/volume conversion must fail')
  proofs.push({code:p.code,sourceKind:p.sourceKind,...await journalProof(p.food)})
 }
 const nodePeakRssKiB=Number(fs.readFileSync('/proc/self/status','utf8').match(/^VmHWM:\s+(\d+)/m)?.[1]);assert.ok(Number.isFinite(nodePeakRssKiB)&&nodePeakRssKiB<=512*1024)
 const result={complete:true,overlaySha256:records.overlaySha256,proofs,passed:proofs.length,networkCalls:0,realNativeDevice:false,applicationActivated:false,seconds:(performance.now()-start)/1000,nodePeakRssKiB,memoryMetric:'linux-process-VmHWM'}
 fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(result,null,2),{flag:'wx',mode:0o600});return result
}
if(process.argv[1]===fileURLToPath(import.meta.url))proof(...process.argv.slice(2)).then(r=>console.log(JSON.stringify({...r,proofs:r.proofs.map(p=>({code:p.code,reference:p.reference,passed:p.passed}))}))).catch(e=>{console.error(e);process.exitCode=1})
