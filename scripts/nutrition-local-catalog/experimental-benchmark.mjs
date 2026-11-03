// Read-only measurements of the experimental API adapter, without HTTP listener.
import {performance} from 'node:perf_hooks'
import {experimentalCatalogRelay} from '../../api/nutrition/catalog-local.js'
import {normalizeProduct} from '../../frontend/src/lib/nutrition/catalog/normalize.js'
const [workspace='off-real-20-metadata']=process.argv.slice(2)
let providerFallbacks=0
const relay=await experimentalCatalogRelay({environment:{NODE_ENV:'development',DATA_DIR:'/tmp/opengym-catalog-measure-only',NUTRITION_LOCAL_CATALOG:'1',NUTRITION_LOCAL_CATALOG_WORKSPACE:workspace},dataDir:'/tmp/opengym-catalog-measure-only',remote:{async read(){providerFallbacks++;return {status:200,body:{status:'failure'}}}}})
const summary=times=>{times.sort((a,b)=>a-b);return {meanMs:times.reduce((a,b)=>a+b,0)/times.length,p95Ms:times[Math.ceil(times.length*.95)-1]}}
try {
  const searches={};let record
  const start=performance.now()
  for(const q of ['Bovetti','pâte','pâte à tartiner','dinde','herbal tea','Nutella','lait']){
    const times=[];let result
    for(let i=0;i<30;i++){const start=performance.now();result=await relay.read('search','/api/nutrition/catalog/search?q='+encodeURIComponent(q));times.push(performance.now()-start)}
    searches[q]={count:result.body.count,...summary(times)}
    if(q==='Bovetti')record=result.body.products[0]
  }
  const product=await normalizeProduct(record)
  if(product.food.nutrients.kcal!==617||product.food.reference.unit!=='g')throw Error('real-nutrient-mismatch')
  const barcode=await relay.read('product','/api/nutrition/catalog/product?code=0000101209159')
  if(barcode.body.product.code!=='0000101209159')throw Error('real-barcode-mismatch')
  const unknown=await relay.read('product','/api/nutrition/catalog/product?code=0000105000011')
  if((await normalizeProduct(unknown.body.product)).food!==null)throw Error('rejected-nutrition-addable')
  console.log(JSON.stringify({workspace,kind:'real-20-limited-not-representative',iterations:30,searches,elapsedMs:performance.now()-start,providerFallbacks,providerRequests:0,kcal:product.food.nutrients.kcal,source:product.food.source,head:barcode.headers['X-openGym-Catalog-Version'],node:process.version,nodePeakRssKiB:process.resourceUsage().maxRSS},null,2))
}finally{await relay.close()}
