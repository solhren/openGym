// Real sealed catalogue -> real API DTO -> real frontend validator -> durable
// isolated Nutrition FS bridge. Neither provider HTTP nor real accounts are used.
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import assert from 'node:assert/strict'
import {WgerCatalogWorker} from './wger-worker-client.mjs'
import {createWgerLocalCatalog} from './wger-api-adapter.mjs'
import {createWgerRelay} from '../../api/nutrition/catalog-wger.js'
import {normalizeLocalProduct} from '../../frontend/src/lib/nutrition/catalog/local-product.js'
import {journalProof} from './wger-evaluate.mjs'

export async function proof(base,complement,output) {
  assert.ok([base,complement,output].every(v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,40}$/.test(v)))
  const root=fileURLToPath(new URL('./artifacts/',import.meta.url)),destination=path.join(root,output)
  assert.ok(!fs.lstatSync(root).isSymbolicLink());fs.mkdirSync(destination,{mode:0o700})
  const worker=new WgerCatalogWorker(base,{localV1:true,complement}),catalog=createWgerLocalCatalog(worker),relay=createWgerRelay({catalog,worker})
  const start=performance.now(),cpu=process.cpuUsage(),config=JSON.parse(fs.readFileSync(new URL('./wger-fr-curation.json',import.meta.url)))
  try {
    const state=await relay.warm(),warmMs=performance.now()-start;assert.equal(state.base.sha256,config.baseSha256)
    const proofs=[]
    for(const alias of config.aliases) {
      const response=await relay.read('product','/api/nutrition/catalog/product?id='+encodeURIComponent(alias.uid))
      const p=normalizeLocalProduct(response.body.product);assert.equal(p.name,alias.label);assert.equal(p.food.name,alias.expectedName)
      proofs.push({label:alias.label,...await journalProof(p.food)})
    }
    const zero=await relay.read('product','/api/nutrition/catalog/product?id=wger:0b9b5bea-9264-4847-bb7b-635e75255ed6')
    assert.equal(normalizeLocalProduct(zero.body.product).food,null)
    const concurrent=await Promise.all(Array.from({length:6},()=>relay.read('search','/api/nutrition/catalog/search?q=riz&lc=fr')))
    assert.ok(concurrent.every(r=>r.body.products.some(p=>p.id===config.aliases[3].uid)))
    const barcodeStart=performance.now(),variants=await catalog.barcode('3017620422003'),barcodeMs=performance.now()-barcodeStart
    assert.ok(variants.length>0&&variants.every(p=>p.food===null),'original OFF reference must remain quarantined')
    const child=worker.child,restartStart=performance.now()
    await new Promise(resolve=>{child.once('close',resolve);child.kill('SIGKILL')})
    const recovered=await relay.read('search','/api/nutrition/catalog/search?q=riz&lc=fr')
    assert.equal(recovered.body.products[0].id,config.aliases[3].uid)
    const restartMs=performance.now()-restartStart
    let workerPeakRssKiB=null
    try {workerPeakRssKiB=Number(fs.readFileSync(`/proc/${worker.child.pid}/status`,'utf8').match(/^VmHWM:\s+(\d+)/m)?.[1])||null}catch{}
    const result={complete:true,baseSha256:state.base.sha256,complementSha256:state.complement.sha256,foodProofs:proofs,concurrentReads:concurrent.length,knownZeroOnlyBlocked:true,
      originalFrenchNutellaBarcode:{code:'3017620422003',variants:variants.length,addable:0,ms:barcodeMs},warmIntegrityMs:warmMs,workerRestartMs:restartMs,seconds:(performance.now()-start)/1000,nodeCpuMs:Object.values(process.cpuUsage(cpu)).reduce((a,b)=>a+b)/1000,nodePeakRssKiB:process.resourceUsage().maxRSS,workerPeakRssKiB,
      providerNetworkCalls:0,trueHttpTest:false,trueBrowserTest:false,androidPhysicalTest:false,iosPhysicalTest:false}
    fs.writeFileSync(path.join(destination,'report.json'),JSON.stringify(result,null,2),{flag:'wx'});return result
  } finally {await relay.close()}
}
if(process.argv[1]===fileURLToPath(import.meta.url))proof(...process.argv.slice(2)).then(r=>console.log(JSON.stringify({...r,foodProofs:r.foodProofs.map(p=>({label:p.label,passed:p.passed}))},null,2))).catch(e=>{console.error(e.message);process.exitCode=1})
