// Small read-only smoke measurement, not a national coverage/relevance study.
// Usage: node public-catalog-search-proof.mjs GENERATION [CLIENT_MODULE_PATH]
import assert from 'node:assert/strict'
import {performance} from 'node:perf_hooks'
import {pathToFileURL} from 'node:url'
import path from 'node:path'

assert.ok(process.argv[2],'A generation directory is required')
const client=process.argv[3]?pathToFileURL(path.resolve(process.argv[3])):new URL('./public-catalog-client.mjs',import.meta.url)
const {createPublicCatalog}=await import(client.href)
const started=performance.now(),catalogue=await createPublicCatalog({directory:path.resolve(process.argv[2])})
try {
 const manifest=await catalogue.inspect()
 const initializationMs=performance.now()-started,queries=[]
 for(const [q,lc] of [['lait','fr'],['milk','en'],['riz','fr'],['rice','en'],['pâtes','fr'],['pasta','en'],['œuf','fr'],['egg','en'],['poulet','fr'],['chicken','en'],['banane','fr'],['banana','en'],['Nutella','fr'],['Coca-Cola','en']]) {
  const elapsed=[];let value
  for(let index=0;index<10;index++) {
   const tick=performance.now();value=await catalogue.search({q,page:1,lc});elapsed.push(performance.now()-tick)
  }
  const sorted=[...elapsed].sort((a,b)=>a-b)
  queries.push({query:q,language:lc,repetitions:elapsed.length,count:value.count,returned:value.products.length,
   meanMs:elapsed.reduce((a,b)=>a+b,0)/elapsed.length,p95Ms:sorted[Math.ceil(.95*sorted.length)-1],
   completeOnPage:value.products.filter(p=>p.validationStatus==='validated').length,
   partialOnPage:value.products.filter(p=>p.validationStatus==='partial').length,
   unusableOnPage:value.products.filter(p=>p.food===null).length,
   top:value.products.slice(0,3).map(p=>({id:p.id,name:p.name,language:p.language,status:p.validationStatus,reference:p.reference,nutrients:p.food?.nutrients??null}))})
 }
 console.log(JSON.stringify({method:'One reader process, 10 sequential observations/query, existing OS caches; nearest-rank p95. Curated smoke cases, not semantic relevance or population coverage.',initializationMs,catalogueSha256:manifest.sha256,externalFoodRequests:0,queries},null,2))
} finally {await catalogue.close()}
