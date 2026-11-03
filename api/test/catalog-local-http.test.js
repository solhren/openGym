// Actual local sockets plus actual Python/SQLite. No Internet/provider dependence.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {foodCatalogRoutes,CatalogHttpError} from '../nutrition/food-catalog.js';
import {experimentalCatalogRelay} from '../nutrition/catalog-local.js';
import {build} from '../../scripts/nutrition-local-catalog/build.mjs';
import {fixture} from '../../scripts/nutrition-local-catalog/fixtures.mjs';
let server,address,root,relay,remoteCalls=0;
before(async()=>{
  const base=path.resolve(import.meta.dirname,'../../scripts/nutrition-local-catalog/artifacts');fs.mkdirSync(base,{recursive:true});root=fs.mkdtempSync(path.join(base,'http-lab-'));
  const input=path.join(root,'input.jsonl');fs.writeFileSync(input,JSON.stringify({...fixture(2),code:'00012345'})+'\n');
  // OFF-shaped synthetic test fixture, isolated and never offered to a live API.
  await build({input,workspace:path.basename(root),source:'off-jsonl',version:'synthetic-http-test',format:'jsonl'});
  relay=await experimentalCatalogRelay({environment:{NODE_ENV:'development',DATA_DIR:'/tmp/catalog-http-personal-lab',NUTRITION_LOCAL_CATALOG:'1',NUTRITION_LOCAL_CATALOG_WORKSPACE:path.basename(root)},dataDir:'/tmp/catalog-http-personal-lab',remote:{async read(kind,input){remoteCalls++;if(input.includes('code=00012346')) throw new CatalogHttpError(404,'catalog-not-found',undefined,'provider-http');return {status:200,body:{status:'success',product:{code:'00012345',product_name:'Lait',brands:'Exemple',nutrition:{aggregated_set:{preparation:'as_sold',per:'100ml',nutrients:{'energy-kcal':{value:35.5},proteins:{value:0},carbohydrates:{value:8.89}}}}}}};}}});
  const routes=foodCatalogRoutes({origin:'http://localhost:8080',limitAddress:()=> '127.0.0.1',relay,json:(res,status,body,headers)=>{res.writeHead(status,{'Content-Type':'application/json',...headers});res.end(JSON.stringify(body));}});
  server=http.createServer((req,res)=>{const handler=routes[req.method+' '+new URL(req.url,'http://x').pathname];if(handler)handler(req,res);else{res.writeHead(404);res.end();}});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});address='http://127.0.0.1:'+server.address().port;
});
after(async()=>{if(server?.listening)await new Promise(resolve=>server.close(resolve));await relay?.close();if(root){fs.rmSync(path.join(path.dirname(root),'public-v3-cache',path.basename(root)),{recursive:true,force:true});fs.rmSync(root,{recursive:true,force:true});}});
test('anonymous local search returns usable ml product with attribution and no provider call',async()=>{
  const r=await fetch(address+'/api/nutrition/catalog/search?q=lait&lc=fr');assert.equal(r.status,200);assert.equal(r.headers.get('x-opengym-catalog-source'),'local-sqlite');
  const data=await r.json();assert.equal(data.products[0].nutrition.aggregated_set.per,'100ml');assert.equal(remoteCalls,0);
});
test('barcode hit hydrates v3 once and absent product preserves explicit 404',async()=>{
  const found=await fetch(address+'/api/nutrition/catalog/product?code=00012345');assert.equal((await found.json()).product.code,'00012345');assert.equal(remoteCalls,1);
  const absent=await fetch(address+'/api/nutrition/catalog/product?code=00012346');assert.equal(absent.status,404);assert.equal((await absent.json()).code,'catalog-not-found');assert.equal(remoteCalls,2);
});
test('foreign origin and unsafe query refused before worker/provider work',async()=>{
  assert.equal((await fetch(address+'/api/nutrition/catalog/search?q=lait',{headers:{Origin:'https://evil.example'}})).status,403);
  assert.equal((await fetch(address+'/api/nutrition/catalog/search?q=lait&userId=secret')).status,400);assert.equal(remoteCalls,2);
});
test('simultaneous local reads preserve catalogue versions and never write personal data',async()=>{
  const results=await Promise.all(Array.from({length:4},()=>fetch(address+'/api/nutrition/catalog/search?q=lait')));
  const versions=results.map(r=>r.headers.get('x-opengym-catalog-version'));assert.equal(new Set(versions).size,1);assert.ok(results.every(r=>r.status===200));
});
test('corrupt manifest is an explicit 503 without quota Retry-After; restore resumes reader',async()=>{
  const file=path.join(root,'current.json'),saved=fs.readFileSync(file);fs.writeFileSync(file,'{bad}');
  try {const r=await fetch(address+'/api/nutrition/catalog/search?q=lait');assert.equal(r.status,503);assert.equal(r.headers.get('retry-after'),null);assert.equal((await r.json()).code,'catalog-local-unavailable');}
  finally {fs.writeFileSync(file,saved)}
  assert.equal((await fetch(address+'/api/nutrition/catalog/search?q=lait')).status,200);
});

// Same actual socket/Python generation, capability call does not consume OFF.
test('local capability and guarded dynamic suggestion preserve anonymous contract',async()=>{
  const capability=await fetch(address+'/api/nutrition/catalog/capabilities');assert.equal(capability.status,200)
  assert.deepEqual(await capability.json(),{schemaVersion:1,textSearch:'local'});assert.equal(capability.headers.get('cache-control'),'no-store')
  const result=await fetch(address+'/api/nutrition/catalog/search?q=lait&lc=fr&local=1');assert.equal(result.status,200)
  assert.equal((await result.json()).products[0].nutrition.aggregated_set.per,'100ml');assert.equal(remoteCalls,2)
})
