import assert from 'node:assert/strict';
// Run through `docker compose exec backend ...`; no public port or auth secret.
import {betaOrigin} from '../../../api/nutrition/catalog-beta.js';
const origin=betaOrigin(process.env.OPENGYM_ORIGIN||process.env.ORIGIN).origin,get=async path=>fetch('http://frontend:8080'+path,{headers:{Origin:origin},signal:AbortSignal.timeout(5000)});
const r=await get('/api/config'),c=await r.json();assert.equal(r.status,200);assert.equal(c.personal_beta,true);assert.equal(c.allow_guest,false);assert.equal(c.invite_only,true);
for(const path of ['/api/data','/api/nutrition/head','/api/nutrition/catalog/search?q=Nutella'])assert.equal((await get(path)).status,401);
const {WgerCatalogWorker}=await import('../../nutrition-local-catalog/wger-worker-client.mjs');
const {createWgerLocalCatalog}=await import('../../nutrition-local-catalog/wger-api-adapter.mjs');
const worker=new WgerCatalogWorker('wger-full-registered-20261025',{localV1:true,complement:'wger-fr-quality-20261026',reference:'off-reference-full2-20261026',referenceIndex:'wger-off-search-20261026'}),catalogue=createWgerLocalCatalog(worker);
try{
 for(const q of ['Nutella','Coca-Cola','lait','riz','pâtes','yaourt'])assert.ok((await catalogue.search({q,lc:'fr'})).products.length>0,q);
 const refs=[];for(const code of ['3017620422003','5449000000996']){
  const values=await catalogue.barcode(code);const product=values.find(p=>p.food);assert.ok(product,'usable barcode '+code);assert.ok(['g','ml'].includes(product.reference.unit));refs.push({code,reference:product.reference});
 }
 console.log(JSON.stringify({httpThroughNginx:true,anonymousDataRefused:true,localSearches:6,barcodes:refs,externalFoodRequests:0}));
}finally{await catalogue.close();}
