import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalCatalogRelay, experimentalCatalogRelay, localProduct } from '../nutrition/catalog-local.js';
import { normalizeProduct } from '../../frontend/src/lib/nutrition/catalog/normalize.js';
const version='a'.repeat(64);
const record = () => ({code:'00012345',name:'Lait',nameFr:'Lait',brand:'Exemple',countries:['en:france'],reference:{amount:100,unit:'ml'},nutrients:{kcal:35.5,protein:0,carbs:8.890000343322754,fat:null},portions:[],warnings:['export-qualifiers-unavailable'],modifiedAt:null});
const search = records => ({products:records,count:records.length,page:1,pageSize:20,catalogueVersion:version,fixture:false});
const query='/api/nutrition/catalog/search?q=lait&lc=fr';
function fixture(value=search([record()])) {
  const calls=[],remotes=[];
  const worker={async request(...args){calls.push(args);if(value instanceof Error)throw value;return value;},async close(){}};
  const remote={async read(...args){remotes.push(args);return {status:200,body:{remote:true}};}};
  return {calls,remotes,worker,remote,relay:createLocalCatalogRelay({worker,remote})};
}
test('local search retains existing response shape and consumes no provider budget',async()=>{
  const f=fixture(), result=await f.relay.read('search',query);
  assert.equal(result.body.count,1);assert.equal(result.body.products[0].code,'00012345');assert.equal(f.remotes.length,0);
  assert.deepEqual(f.calls[0],['search',{query:'lait',page:1,pageSize:20,language:'fr'},{signal:undefined}]);
  assert.equal(result.headers['X-openGym-Catalog-Source'],'local-sqlite');
});
test('descriptor -> actual frontend normalizer preserves decimals, ml, zero, null and provenance',async()=>{
  const raw=localProduct(record(),version), result=await normalizeProduct(raw);
  assert.equal(result.food.reference.unit,'ml');assert.equal(result.food.nutrients.carbs,8.890000343322754);assert.equal(result.food.nutrients.protein,0);assert.equal(result.food.nutrients.fat,null);
  assert.ok(result.warnings.includes('export-qualifiers-unavailable'));assert.deepEqual(result.food.source.catalogueWarnings,['export-qualifiers-unavailable']);
  assert.equal((await normalizeProduct(localProduct(record(),'b'.repeat(64)))).food.id,result.food.id);
});
test('metadata-only rejected nutrition cannot become addable or fabricate zero',async()=>{
  const r=record();r.reference=null;r.nutrients={kcal:null,protein:null,carbs:null,fat:null};r.warnings=['nutrition-rejected'];
  assert.equal((await normalizeProduct(localProduct(r,version))).food,null);
  r.reference={amount:100,unit:'g'};assert.throws(()=>localProduct(r,version));
});
test('barcode hit uses atomic record/version; miss and reader failure use bounded remote relay',async()=>{
  const f=fixture({product:record(),catalogueVersion:version,fixture:false});
  assert.equal((await f.relay.read('product','/api/nutrition/catalog/product?code=00012345')).body.product.code,'00012345');assert.equal(f.remotes.length,0);
  for(const value of [null,Object.assign(new Error(),{code:'worker-timeout'})]) {
    const missed=fixture(value);await missed.relay.read('product','/api/nutrition/catalog/product?code=00012345');assert.equal(missed.remotes.length,1);
  }
});
test('local unavailability is explicit and never becomes a 60-second provider cooldown',async()=>{
  const f=fixture(Object.assign(new Error(),{code:'corrupt-generation'}));
  await assert.rejects(f.relay.read('search',query),error=>error.status===503&&error.code==='catalog-local-unavailable'&&error.retryAfter===undefined);
  assert.equal(f.remotes.length,0);
});
test('invalid query, paths, private parameters, staging and wrong barcode remain isolated',async()=>{
  const f=fixture();for(const q of [query+'&url=http://evil',query+'&userId=secret','/api/nutrition/catalog/product?code=../private'])await assert.rejects(f.relay.read(q.includes('/product')?'product':'search',q));
  assert.equal(f.calls.length,0);
  await f.relay.read('search',query+'&staging=1');assert.equal(f.remotes.length,1);
  const wrong=fixture({product:{...record(),code:'00012346'},catalogueVersion:version,fixture:false});await assert.rejects(wrong.relay.read('product','/api/nutrition/catalog/product?code=00012345'));
});
test('synthetic catalogues and malformed descriptors cannot be presented as OFF',async()=>{
  await assert.rejects(fixture({...search([record()]),fixture:true}).relay.read('search',query));
  for(const r of [{...record(),privateData:'secret'},{...record(),nutrients:{kcal:NaN,protein:0,carbs:0,fat:0}},{...record(),warnings:['unknown']}])assert.throws(()=>localProduct(r,version));
});
test('late result after cancellation and close cannot publish success or trigger provider fallback',async()=>{
  let resolve;const pending=new Promise(r=>resolve=r),remote={read(){throw Error('must not call provider');}};
  const relay=createLocalCatalogRelay({worker:{request(){return pending;},async close(){}},remote});
  const controller=new AbortController(), request=relay.read('search',query,{signal:controller.signal});controller.abort();resolve(search([record()]));
  await assert.rejects(request,{code:'catalog-request-cancelled'});
  await relay.close();await assert.rejects(relay.read('search',query));
});
test('default/production/unsafe DATA_DIR never import or start worker; explicit isolated development does',async()=>{
  let starts=0;const loadWorker=async()=>({CatalogWorker:class {constructor(){starts++;}request(){return search([record()]);}async close(){}}});
  for(const environment of [{},{NUTRITION_LOCAL_CATALOG:'1',NODE_ENV:'production'},{NUTRITION_LOCAL_CATALOG:'1',NODE_ENV:'development',DATA_DIR:'/data',NUTRITION_LOCAL_CATALOG_WORKSPACE:'trial'}]) assert.equal(await experimentalCatalogRelay({environment,dataDir:environment.DATA_DIR,loadWorker}),null);
  assert.equal(starts,0);
  const enabled=await experimentalCatalogRelay({environment:{NUTRITION_LOCAL_CATALOG:'1',NODE_ENV:'development',DATA_DIR:'/tmp/catalog-lab',NUTRITION_LOCAL_CATALOG_WORKSPACE:'trial'},dataDir:'/tmp/catalog-lab',loadWorker});
  assert.equal(starts,1);await enabled.close();
});
test('missing runtime cannot crash training API startup; local text fails explicitly',async()=>{
  const enabled=await experimentalCatalogRelay({environment:{NUTRITION_LOCAL_CATALOG:'1',NODE_ENV:'development',DATA_DIR:'/tmp/catalog-lab',NUTRITION_LOCAL_CATALOG_WORKSPACE:'trial'},dataDir:'/tmp/catalog-lab',loadWorker:async()=>{throw Error('missing module')}});
  await assert.rejects(enabled.read('search',query),{code:'catalog-local-unavailable'});await enabled.close();
});
test('dangerous descriptors never invoke getters or serialize private data',()=>{
  let invoked=false;const r=record();Object.defineProperty(r,'name',{enumerable:true,get(){invoked=true;return 'private'}});
  assert.throws(()=>localProduct(r,version));assert.equal(invoked,false);
});
test('provider fallback response arriving after shutdown cannot become a success',async()=>{
  let resolve;const pending=new Promise(r=>resolve=r);
  const relay=createLocalCatalogRelay({worker:{async request(){return null},async close(){}},remote:{read(){return pending}}});
  const request=relay.read('product','/api/nutrition/catalog/product?code=00012345');await Promise.resolve();await relay.close();resolve({status:200,body:{status:'failure'}});
  await assert.rejects(request,{code:'catalog-request-cancelled'});
});

test('V1 selection always hydrates through validated v3 cache, never treats TSV values as a fiche',async()=>{
 const f=fixture({product:record(),catalogueVersion:version,fixture:false});let hydration=0;
 const relay=createLocalCatalogRelay({worker:f.worker,remote:f.remote,productCache:{async read(kind,input){hydration++;return {status:200,body:{status:'success',product:{code:'00012345'}}}}}});
 assert.equal((await relay.read('product','/api/nutrition/catalog/product?code=00012345')).body.product.code,'00012345');
 assert.equal(f.calls.length,0);assert.equal(f.remotes.length,0);assert.equal(hydration,1);
 await relay.read('search',query).catch(()=>{});assert.equal(hydration,1);
});

test('OFF reference configuration is an all-or-none safe pair and never constructs an external fallback',async()=>{
 const environment={NODE_ENV:'development',DATA_DIR:'/tmp/catalog-reference-config',NUTRITION_LOCAL_CATALOG:'1',NUTRITION_LOCAL_CATALOG_KIND:'wger-v1',NUTRITION_LOCAL_CATALOG_WORKSPACE:'base',NUTRITION_LOCAL_CATALOG_COMPLEMENT:'quality'};
 for(const extra of [{NUTRITION_LOCAL_CATALOG_REFERENCE:'refs'},{NUTRITION_LOCAL_CATALOG_REFERENCE_INDEX:'index'},{NUTRITION_LOCAL_CATALOG_REFERENCE:'../private',NUTRITION_LOCAL_CATALOG_REFERENCE_INDEX:'index'}]){
  let starts=0;const relay=await experimentalCatalogRelay({environment:{...environment,...extra},dataDir:environment.DATA_DIR,loadWger:async()=>{starts++;throw Error('must not construct reader');},remote:{read(){throw Error('external forbidden');}}});
  await assert.rejects(relay.read('search',query),{code:'catalog-local-unavailable'});assert.equal(starts,0);await relay.close();
 }
});
