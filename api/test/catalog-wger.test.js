import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createWgerRelay,WGER_CAPABILITIES} from '../nutrition/catalog-wger.js';
import {createWgerLocalCatalog} from '../../scripts/nutrition-local-catalog/wger-api-adapter.mjs';
import {normalizeWger} from '../../scripts/nutrition-local-catalog/wger-normalize.mjs';
import {foodCatalogRoutes} from '../nutrition/food-catalog.js';
import {experimentalCatalogRelay} from '../nutrition/catalog-local.js';

const registry={languages:[{id:1,short_name:'fr'}],licenses:[{id:1,full_name:'CC0',url:'https://creativecommons.org/publicdomain/zero/1.0/'}]};
const input={id:1,uuid:'12345678-1234-1234-1234-123456789abc',name:'Riz',code:'00012345',source_name:'USDA',language:1,license:1,energy:350.6,protein:'7.123',carbohydrates:'75.5',fat:'1.25'};
async function setup(mode) {
 const record={...await normalizeWger(input,registry),validationStatus:'validated'},calls=[];
 const duplicate=mode==='duplicate'?{...await normalizeWger({...input,uuid:'12345678-1234-1234-1234-123456789abd'},registry),validationStatus:'validated'}:null;
 const worker={async request(op,args){calls.push({op,args});if(mode==='broken')throw Object.assign(Error(),{code:'worker-timeout'});return op==='search'?{products:[record],count:1,page:args.page,pageSize:20,literalOnly:true,registryVerified:true,catalogueVersion:'a'.repeat(64)}:op==='product'?(mode==='absent'?null:record):mode==='absent'?[]:mode==='duplicate'?[record,duplicate]:[record]},async close(){}};
 return {record,calls,relay:createWgerRelay({worker,catalog:createWgerLocalCatalog(worker)})};
}
test('wger V1 search and selection return validated Food without any provider dependency',async()=>{
 const {relay,record,calls}=await setup();assert.ok(record.food);assert.deepEqual(relay.capabilities,WGER_CAPABILITIES);
 const result=await relay.read('search','/api/nutrition/catalog/search?q=riz&page=1&lc=fr');assert.equal(result.body.format,'opengym-local-food-catalog');assert.equal(result.body.products[0].food.nutrients.protein,7.123);
 assert.equal((await relay.read('product','/api/nutrition/catalog/product?id='+record.id)).body.product.id,record.id);
 assert.equal((await relay.read('product','/api/nutrition/catalog/product?code=00012345')).body.product.code,'00012345');assert.equal(calls.length,3);await relay.close();
});
test('invalid inputs never enter SQLite: staging, private fields, duplicates, paths and oversize',async()=>{
 const {relay,calls}=await setup();
 for(const q of ['q=riz&staging=1','q=riz&q=lait','q=riz&token=secret','q=--','q='+('x'.repeat(121)),'q=riz&page=21'])await assert.rejects(relay.read('search','/?'+q),{status:400});
 for(const q of ['id=../../private','id=wger:'+'-'.repeat(36),'code=00012345&id=wger:12345678-1234-1234-1234-123456789abc','code=bad','id=wger:12345678-1234-1234-1234-123456789abc&url=https://bad'])await assert.rejects(relay.read('product','/?'+q),{status:400});
 assert.equal(calls.length,0);
});
test('absence, corruption and barcode ambiguity stay local and have distinct statuses',async()=>{
 const missing=await setup('absent');await assert.rejects(missing.relay.read('product','/?code=00012345'),{status:404});
 const broken=await setup('broken');await assert.rejects(broken.relay.read('search','/?q=riz'),{status:503,code:'catalog-local-unavailable'});
 const duplicate=await setup('duplicate');await assert.rejects(duplicate.relay.read('product','/?code=00012345'),{status:409,code:'catalog-ambiguous-barcode'});
 const capped=createWgerRelay({worker:{},catalog:{barcode:async()=>Array.from({length:20},(_,i)=>({food:i===0?{}:null})),async close(){}}});
 await assert.rejects(capped.read('product','/?code=00012345'),{status:409,code:'catalog-ambiguous-barcode'});
});
test('same existing route guards origin and exposes explicit local-only capabilities to guests',async()=>{
 const {relay}=await setup(),responses=[];const routes=foodCatalogRoutes({relay,origin:'http://localhost:5173',limitAddress:()=> '127.0.0.1',json:(res,status,body)=>responses.push({status,body}),onEvent:()=>{}});
 const req={url:'/api/nutrition/catalog/capabilities',headers:{origin:'http://localhost:5173'},resume(){}};
 await routes['GET /api/nutrition/catalog/capabilities'](req,{});assert.deepEqual(responses[0],{status:200,body:WGER_CAPABILITIES});
 await routes['GET /api/nutrition/catalog/search']({...req,url:'/api/nutrition/catalog/search?q=riz',headers:{origin:'https://foreign.test'}},{});assert.equal(responses[1].status,403);
});
test('missing V1 prototype runtime keeps training startup alive and never downgrades to provider',async()=>{
 let loaded=false;
 const relay=await experimentalCatalogRelay({environment:{NODE_ENV:'development',DATA_DIR:'/tmp/wger-runtime-test',NUTRITION_LOCAL_CATALOG:'1',NUTRITION_LOCAL_CATALOG_KIND:'wger-v1',NUTRITION_LOCAL_CATALOG_WORKSPACE:'missing',NUTRITION_LOCAL_CATALOG_COMPLEMENT:'quality'},dataDir:'/tmp/wger-runtime-test',loadWger:async()=>{loaded=true;throw Error('missing optional prototype')},remote:{read(){assert.fail('provider must not be constructed or called')}}});
 assert.equal(loaded,true);
 assert.deepEqual(relay.capabilities,WGER_CAPABILITIES);await assert.rejects(relay.read('search','/?q=riz'),{status:503,code:'catalog-local-unavailable'});await relay.close();
});
test('invalid explicit development V1 configuration fails closed without loading a worker',async()=>{
 for(const patch of [{NUTRITION_LOCAL_CATALOG_WORKSPACE:'../private'},{NUTRITION_LOCAL_CATALOG_COMPLEMENT:'../../private'},{NUTRITION_LOCAL_CATALOG_COMPLEMENT:undefined},{DATA_DIR:'/data'}]) {
  let called=false;const environment={NODE_ENV:'development',DATA_DIR:'/tmp/wger-config-test',NUTRITION_LOCAL_CATALOG:'1',NUTRITION_LOCAL_CATALOG_KIND:'wger-v1',NUTRITION_LOCAL_CATALOG_WORKSPACE:'base',NUTRITION_LOCAL_CATALOG_COMPLEMENT:'quality',...patch};
  const relay=await experimentalCatalogRelay({environment,dataDir:environment.DATA_DIR,loadWger:async()=>{called=true;throw Error()}});
  assert.equal(called,false);assert.deepEqual(relay.capabilities,WGER_CAPABILITIES);await assert.rejects(relay.read('product','/?code=00012345'),{status:503});await relay.close();
 }
});
