/** Real imported rows through the app's existing durable commands, on disposable
 * test files only. Provisional registry evidence is reported, never upgraded.
 */
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {journalProof} from './wger-evaluate.mjs'
import {WgerCatalogWorker} from './wger-worker-client.mjs'
import {createWgerLocalCatalog} from './wger-api-adapter.mjs'
const name=process.argv[2]
if(typeof name!=='string'||!/^[A-Za-z0-9_-]{1,40}$/.test(name))throw Error('invalid-workspace')
const base=fileURLToPath(new URL('./artifacts/',import.meta.url)),root=path.join(base,name)
if(fs.lstatSync(root).isSymbolicLink()||fs.statSync(path.join(root,'report.json')).size>1024**2)throw Error('unsafe-report')
const report=JSON.parse(fs.readFileSync(path.join(root,'report.json'))),proofs=[]
if(report.complete!==true)throw Error('incomplete-import')
for(const row of Object.values(report.samples)){
 if(!row.food)continue
 proofs.push({sourceKind:row.sourceKind,registryVerified:report.registry.verified,publicationApproved:false,...await journalProof(row.food)})
}
// Exercise the supervised read-only protocol/DTO against this real generation.
const worker=new WgerCatalogWorker(name,{timeoutMs:30000}),service=createWgerLocalCatalog(worker),workerTests=[]
try{
 const start=performance.now();const results=await service.search({q:'Nutella'});const startupMs=performance.now()-start
 workerTests.push({query:'Nutella',count:results.count,firstNames:results.products.slice(0,3).map(v=>v.name),startupAndSearchMs:startupMs})
 if(results.products[0]){
  const p=results.products[0],selected=await service.product(p.id)
  if(selected.id!==p.id)throw Error('selection-mismatch')
  workerTests.push({selectedId:selected.id,validationStatus:selected.validationStatus,foodAvailable:selected.food!==null,
   selectedFoodJournalProof:selected.food?await journalProof(selected.food):null})
  if(p.code)workerTests.push({barcode:p.code,variants:(await service.barcode(p.code)).length})
 }
 const typo=await service.search({q:'nutela'});workerTests.push({query:'nutela',count:typo.count,note:'literal matches only; zero is not assumed if a literal product actually exists'})
}finally{await service.close()}
const result={complete:true,sourceSha256:report.sourceSha256,registryVerified:report.registry.verified,publicationBlocked:report.publicationBlocked,realRows:true,proofs,workerTests,networkCalls:0,physicalAndroidTested:false}
fs.writeFileSync(path.join(root,'journal-proof.json'),JSON.stringify(result,null,2),{flag:'wx'});console.log(JSON.stringify(result,null,2))
