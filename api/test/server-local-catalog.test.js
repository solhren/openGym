// Registration and lifecycle in the actual server; disposable personal/catalog data.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {boundPort} from './helpers.mjs';
import {build} from '../../scripts/nutrition-local-catalog/build.mjs';
import {createValidatedProductCache} from '../nutrition/catalog-product-cache.js';
import {normalizeProduct} from '../../frontend/src/lib/nutrition/catalog/normalize.js';
import {fixture} from '../../scripts/nutrition-local-catalog/fixtures.mjs';
let child,dataDir,catalogue,address,initialDb;
before(async()=>{
  // DATA_DIR must be outside public artifacts, including when TMPDIR is moved
  // into that tree for bounded catalogue import tests.
  const runtime=path.resolve(import.meta.dirname,'../../scripts/nutrition-local-catalog/runtime');fs.mkdirSync(runtime,{recursive:true});
  dataDir=fs.mkdtempSync(path.join(runtime,'local-api-personal-'));
  const base=path.resolve(import.meta.dirname,'../../scripts/nutrition-local-catalog/artifacts');fs.mkdirSync(base,{recursive:true});catalogue=fs.mkdtempSync(path.join(base,'server-lab-'));
  const input=path.join(catalogue,'input.jsonl');fs.writeFileSync(input,JSON.stringify({...fixture(2),code:'00012345'})+'\n');
  await build({input,workspace:path.basename(catalogue),source:'off-jsonl',version:'synthetic-server-test',format:'jsonl'});
  const cache=createValidatedProductCache({root:path.join(base,'public-v3-cache',path.basename(catalogue)),normalizeProduct,remote:{async read(){return {status:200,body:{status:'success',product:{code:'00012345',product_name:'Lait',brands:'Exemple',nutrition:{aggregated_set:{preparation:'as_sold',per:'100ml',nutrients:{'energy-kcal':{value:35.5},proteins:{value:0},carbohydrates:{value:8.89}}}}}}}}}});
  await cache.read('product','/api/nutrition/catalog/product?code=00012345');
  child=spawn(process.execPath,['server.js'],{cwd:path.resolve(import.meta.dirname,'..'),env:{...process.env,NODE_ENV:'development',DATA_DIR:dataDir,PORT:'0',ORIGIN:'http://localhost:8080',NUTRITION_LOCAL_CATALOG:'1',NUTRITION_LOCAL_CATALOG_WORKSPACE:path.basename(catalogue)}});
  let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
  address='http://127.0.0.1:'+await boundPort(child,()=>output);
  // A pristine guest-only API need not create an account DB. Absence is itself
  // the state whose preservation this test checks.
  initialDb=fs.existsSync(path.join(dataDir,'db.json'))?fs.readFileSync(path.join(dataDir,'db.json')):null;
});
after(async()=>{
  if(child&&child.exitCode===null){const ended=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await ended;}
  if(dataDir)fs.rmSync(dataDir,{recursive:true,force:true});if(catalogue){fs.rmSync(path.join(path.dirname(catalogue),'public-v3-cache',path.basename(catalogue)),{recursive:true,force:true});fs.rmSync(catalogue,{recursive:true,force:true});}
});
test('real API guest search is local and preserves immutable user store',async()=>{
  const r=await fetch(address+'/api/nutrition/catalog/search?q=lait');assert.equal(r.status,200);assert.equal(r.headers.get('x-opengym-catalog-source'),'local-sqlite');assert.equal((await r.json()).count,1);
  assert.deepEqual(fs.existsSync(path.join(dataDir,'db.json'))?fs.readFileSync(path.join(dataDir,'db.json')):null,initialDb);
});
test('barcode local and personal Nutrition authentication stay separate',async()=>{
  const r=await fetch(address+'/api/nutrition/catalog/product?code=00012345');assert.equal(r.status,200);assert.equal((await r.json()).product.code,'00012345');
  assert.equal((await fetch(address+'/api/nutrition/head')).status,401);
});
test('existing origin protections and arbitrary URL refusal apply to experiment',async()=>{
  assert.equal((await fetch(address+'/api/nutrition/catalog/search?q=lait',{headers:{Origin:'https://evil.example'}})).status,403);
  assert.equal((await fetch(address+'/api/nutrition/catalog/search?q=lait&url=http://private')).status,400);
});
