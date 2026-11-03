import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createValidatedProductCache } from '../nutrition/catalog-product-cache.js';
import { CatalogHttpError } from '../nutrition/food-catalog.js';
import { normalizeProduct } from '../../frontend/src/lib/nutrition/catalog/normalize.js';
import { offProduct, v3Product } from '../../frontend/src/lib/nutrition/catalog/fixtures.test-util.js';
const input='/api/nutrition/catalog/product?code=3017620422003&lc=fr';
async function fixture(t) {
 const base=path.resolve(import.meta.dirname,'../../scripts/nutrition-local-catalog/artifacts');await fs.mkdir(base,{recursive:true});const root=await fs.mkdtemp(path.join(base,'cache-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 let raw=v3Product(), time=1791806400000, calls=0, error;
 const remote={async read(){calls++;if(error)throw error;return{status:200,body:{status:'success',product:raw}};}};
 const create=()=>createValidatedProductCache({root,normalizeProduct,remote,now:()=>time});
 return {root,create,cache:create(),get calls(){return calls},set raw(v){raw=v},set error(v){error=v},advance(){time+=8*86400000}};
}
test('durable validated ml fiche survives a fresh service and includes provenance/version/date',async t=>{
 const f=await fixture(t),a=await f.cache.read('product',input);assert.equal(a.headers['X-openGym-Catalog-Validation'],'validated');
 assert.equal((await normalizeProduct(a.body.product,{requireExplicitReference:true})).food.reference.unit,'ml');
 const b=await f.create().read('product',input);assert.deepEqual(b,a);assert.equal(f.calls,1);
 const data=JSON.parse(await fs.readFile(path.join(f.root,'3017620422003-fr.json'),'utf8')).data;
 assert.equal(data.apiVersion,'v3.5');assert.equal(data.provenance.license,'ODbL-1.0');assert.equal(data.reference.unit,'ml');assert.ok(data.capturedAt);
});
test('ambiguous TSV-like suffixes remain identity-only, not invented grams or zero values',async t=>{
 const f=await fixture(t);f.raw=offProduct({nutrition_data_per:undefined,serving_size:undefined,serving_quantity:undefined,serving_quantity_unit:undefined});
 // Provider JSON cannot contain undefined; the fixture omits absent keys.
 f.raw=JSON.parse(JSON.stringify(offProduct({nutrition_data_per:undefined,serving_size:undefined,serving_quantity:undefined,serving_quantity_unit:undefined})));
 const r=await f.cache.read('product',input);assert.equal(r.headers['X-openGym-Catalog-Validation'],'unusable');assert.equal((await normalizeProduct(r.body.product)).food,null);
});
test('zero and decimals are preserved; missing macro stays null',async t=>{
 const f=await fixture(t);f.raw=v3Product({nutrition:{aggregated_set:{preparation:'as_sold',per:'100g',nutrients:{'energy-kcal':{value:12.345},proteins:{value:0},carbohydrates:{value:2.123}}}}});
 const r=await f.cache.read('product',input),p=await normalizeProduct(r.body.product,{requireExplicitReference:true});assert.equal(p.food.nutrients.kcal,12.345);assert.equal(p.food.nutrients.protein,0);assert.equal(p.food.nutrients.fat,null);
});
test('invalid nutrition, wrong barcode and source error tags cannot poison durable cache',async t=>{
 const f=await fixture(t);
 for(const raw of [offProduct({code:'3017620422004'}),v3Product({nutrition:{aggregated_set:{preparation:'as_sold',per:'100g',nutrients:{proteins:{value:-1}}}}}),offProduct({data_quality_errors_tags:['en:nutrition-value-negative']})]) {
 f.raw=raw;await assert.rejects(f.cache.read('product',input),{code:'catalog-invalid-response'});assert.deepEqual(await fs.readdir(f.root),[]);
 }
});
test('corrupt JSON, mismatched checksum and symlink entry are misses, never cached success',async t=>{
 const f=await fixture(t),file=path.join(f.root,'3017620422003-fr.json');await fs.writeFile(file,'{"broken":');await f.cache.read('product',input);assert.equal(f.calls,1);
 let e=JSON.parse(await fs.readFile(file,'utf8'));e.data.raw.product_name='malicious';await fs.writeFile(file,JSON.stringify(e));await f.cache.read('product',input);assert.equal(f.calls,2);
 await fs.unlink(file);await fs.symlink(path.join(f.root,'outside'),file);await f.cache.read('product',input);assert.equal(f.calls,3);assert.equal((await fs.lstat(file)).isSymbolicLink(),false);
});
test('stale valid fiche survives transient 429/503/network; a newer invalid response does not revive it',async t=>{
 const f=await fixture(t);await f.cache.read('product',input);f.advance();
 for(const status of [429,503,502,504]) { f.error=new CatalogHttpError(status,'provider-down',undefined,'network');const r=await f.cache.read('product',input);assert.ok(r.headers.Warning); }
 f.error=null;f.raw=offProduct({code:'3017620422004'});await assert.rejects(f.cache.read('product',input),{code:'catalog-invalid-response'});
});
test('deduplication precedes provider budget and waiter cancellation does not cancel shared work',async t=>{
 const f=await fixture(t);let finish,calls=0;const pending=new Promise(r=>finish=r);
 const cache=createValidatedProductCache({root:f.root,normalizeProduct,remote:{read(){calls++;return pending}}});
 const c=new AbortController(),a=cache.read('product',input,{signal:c.signal}),b=cache.read('product',input);
 while(calls===0)await new Promise(r=>setImmediate(r));c.abort();await assert.rejects(a,{code:'catalog-request-cancelled'});
 finish({status:200,body:{status:'success',product:v3Product()}});assert.equal((await b).status,200);assert.equal(calls,1);
});
test('partial write leftovers are ignored and quota/permissions errors never report cached success',async t=>{
 const f=await fixture(t);await fs.writeFile(path.join(f.root,'.interrupted.partial'),'not a product');await f.cache.read('product',input);assert.equal(f.calls,1);
 const file=path.join(f.root,'3017620422003-fr.json');await fs.unlink(file);await fs.mkdir(file);
 await assert.rejects(f.cache.read('product',input),{code:'catalog-cache-unavailable'});assert.equal(await fs.readFile(path.join(f.root,'.interrupted.partial'),'utf8'),'not a product');
 assert.deepEqual((await fs.readdir(f.root)).sort(),['.interrupted.partial','3017620422003-fr.json']);
});
test('cache never exports private provider fields and rejects dangerous queries',async t=>{
 const f=await fixture(t);f.raw=offProduct({creator:'private-email',access_token:'secret'});await f.cache.read('product',input);
 const text=await fs.readFile(path.join(f.root,'3017620422003-fr.json'),'utf8');assert.ok(!text.includes('private-email'));assert.ok(!text.includes('secret'));
 await assert.rejects(f.cache.read('product',input+'&path=../users'));assert.equal(f.calls,1);
});

test('legacy nutrition_data_per=100g is not proof of g/ml in V1 cache',async t=>{
 const f=await fixture(t);f.raw=offProduct();const r=await f.cache.read('product',input);assert.equal(r.headers['X-openGym-Catalog-Validation'],'unusable');assert.equal((await normalizeProduct(r.body.product)).food,null);
});
test('contradictory unit in a normalized aggregate is refused instead of rescaled',async t=>{
 const f=await fixture(t);const raw=v3Product();raw.nutrition.aggregated_set.nutrients.proteins={value:3.2,unit:'mg'};f.raw=raw;await assert.rejects(f.cache.read('product',input),{code:'catalog-invalid-response'});
});

test('requested localized name survives public projection and cache revalidation',async t=>{
 const f=await fixture(t);f.raw=v3Product({product_name_es:'Leche'});const es=input.replace('lc=fr','lc=es');
 const a=await f.cache.read('product',es),b=await f.create().read('product',es);
 assert.equal(a.body.product.product_name_es,'Leche');assert.equal((await normalizeProduct(b.body.product,{language:'es'})).name,'Leche');assert.equal(f.calls,1);
});
