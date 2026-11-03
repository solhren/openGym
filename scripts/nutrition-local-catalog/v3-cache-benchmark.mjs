// Measures real disk/cache operations with a simulated provider, NOT OFF latency.
import fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {createValidatedProductCache} from '../../api/nutrition/catalog-product-cache.js'
import {normalizeProduct} from '../../frontend/src/lib/nutrition/catalog/normalize.js'
const base=fileURLToPath(new URL('./artifacts/',import.meta.url));await fs.mkdir(base,{recursive:true})
const root=await fs.mkdtemp(path.join(base,'v3-benchmark-'))
const fixture={code:'3017620422003',product_name:'Fixture spread',brands:'Fixture',nutrition:{aggregated_set:{per:'100g',preparation:'as_sold',nutrients:{'energy-kcal':{value:539},proteins:{value:6.3},carbohydrates:{value:57.5},fat:{value:30.9}}}}}
let providerCalls=0
const remote={async read(){providerCalls++;return{status:200,body:{status:'success',product:fixture}}}}
const cache=()=>createValidatedProductCache({root,normalizeProduct,remote})
const request='/api/nutrition/catalog/product?code=3017620422003&lc=fr'
const cpu=process.cpuUsage(),start=performance.now();await cache().read('product',request);const initial=performance.now()-start
const hits=[];for(let i=0;i<100;i++){const begin=performance.now();await cache().read('product',request);hits.push(performance.now()-begin)}
hits.sort((a,b)=>a-b)
const result={provider:'simulated fixture, no Internet',source:'v3.5-shaped normalized aggregate',iterations:100,initialValidationDurableWriteMs:initial,restartHitMeanMs:hits.reduce((a,b)=>a+b,0)/hits.length,restartHitP95Ms:hits[94],providerCalls,files:await fs.readdir(root),entryBytes:(await fs.stat(path.join(root,'3017620422003-fr.json'))).size,node:process.version,platform:process.platform,peakRssKiB:process.resourceUsage().maxRSS,cpuMs:(process.cpuUsage(cpu).user+process.cpuUsage(cpu).system)/1000}
await fs.writeFile(path.join(root,'benchmark.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({directory:root,...result},null,2))
