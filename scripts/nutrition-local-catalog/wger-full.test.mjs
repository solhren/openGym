import test from 'node:test'
import assert from 'node:assert/strict'
import {normalizeWger,createWgerNormalizer} from './wger-normalize.mjs'
import {repositoryRegistry} from './wger-registry.mjs'
import {loadRegistry,verifyRegistryCoverage} from './wger-full.mjs'
import {createWgerLocalCatalog,publicWgerProduct} from './wger-api-adapter.mjs'
import {WgerCatalogWorker} from './wger-worker-client.mjs'
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
const row={id:1,uuid:'12345678-1234-1234-1234-123456789abc',name:'Riz',code:null,source_name:'USDA',source_url:'https://fdc.nal.usda.gov/',language:2,license:3,energy:350,protein:'7.123',carbohydrates:'75.500',fat:'1.250'}
test('fallback fixture registry is explicitly provisional, never a deployed ID assertion',()=>{
 assert.equal(loadRegistry().verified,false);assert.equal(repositoryRegistry.languages.find(r=>r.id===12).short_name,'fr');assert.equal(repositoryRegistry.languages.find(r=>r.id===999),undefined)
 for(const value of ['../outside','absolute/dir','x'.repeat(50)])assert.throws(()=>loadRegistry(value))
})
test('native real schema retains raw declared reference, decimals and no fake barcode',async()=>{
 const p=await normalizeWger(row,repositoryRegistry);assert.equal(p.food.nutrients.protein,7.123);assert.equal(p.barcode,null);assert.equal(p.referenceEvidence,'wger-model-declared-100g');assert.equal(p.nutritionValuesValid,true)
})
test('ambiguous OFF also receives shared cross-nutrient validation',async()=>{
 const p=await normalizeWger({...row,code:'3017620422003',source_name:'Open Food Facts',license:5,carbohydrates_sugar:'76.000'},repositoryRegistry)
 assert.equal(p.food,null);assert.equal(p.nutritionValuesValid,false);assert.ok(p.issues.includes('engine-nutrient-validation-failed'));assert.ok(p.issues.includes('off-100g-or-100ml-reference-lost'))
})
test('real dump long author credits are preserved, not silently truncated',async()=>{
 const p=await normalizeWger({...row,source_name:'Open Food Facts',license:5,license_author:'a'.repeat(9701)},repositoryRegistry)
 assert.equal(p.provenance.licenseMetadata.author.length,9701);assert.equal(p.food,null)
})
test('prepared local service preserves UUID identity and validated Food with no provider fallback',async()=>{
 const p={...await normalizeWger(row,repositoryRegistry),validationStatus:'validated'};let calls=[]
 const service=createWgerLocalCatalog({request:async(op,args)=>{calls.push(op);return op==='search'?{products:[p],literalOnly:true,count:1,catalogueVersion:'a'.repeat(64)}:op==='product'?p:[p]},close:async()=>{}})
 const result=await service.search({q:'riz'});assert.equal(result.products[0].code,null);assert.equal(result.products[0].food.nutrients.carbs,75.5)
 assert.equal((await service.product(p.id)).id,p.id);assert.deepEqual(calls,['search','product'])
 assert.equal(publicWgerProduct({...p,food:null,validationStatus:'needs-verification'}).reference,null)
 assert.throws(()=>publicWgerProduct({...p,food:null}));await assert.rejects(service.search({q:'x'}));await assert.rejects(service.barcode('123abc'))
 await assert.rejects(service.search({q:'--'}));await assert.rejects(service.search({q:'a b c d e f g h i'}))
 await assert.rejects(service.product('wger:'+'-'.repeat(36)))
})
test('local miss and reader error do not attempt any network lookup',async()=>{
 let calls=0;const service=createWgerLocalCatalog({request:async()=>{calls++;return null},close:async()=>{}})
 assert.equal(await service.product('wger:12345678-1234-1234-1234-123456789abc'),null);assert.equal(calls,1)
 const broken=createWgerLocalCatalog({request:async()=>{throw Error('worker-unavailable')},close:async()=>{}})
 await assert.rejects(broken.search({q:'riz'}),/worker-unavailable/)
})
test('wger supervisor validates workspace names before spawning a process',()=>{
 assert.throws(()=>new WgerCatalogWorker('../outside'));assert.throws(()=>new WgerCatalogWorker('isolated-wger',{localV1:true}));const worker=new WgerCatalogWorker('isolated-wger');assert.equal(worker.child,null);assert.equal(worker.timeoutMs,30000);return worker.close()
})
test('bulk normalization matches individual validation including decimals, missing values and ambiguous OFF',async()=>{
 const normalize=createWgerNormalizer(repositoryRegistry)
 for(const patch of [{},{protein:null},{fat:'0.000'},{source_name:'Open Food Facts',license:5,code:'3017620422003'}]){
  const input={...row,...patch};assert.deepEqual(await normalize(input),await normalizeWger(input,repositoryRegistry))
 }
})
test('bulk registry snapshot cannot change during import and every row remains untrusted',async()=>{
 const registry=structuredClone(repositoryRegistry),normalize=createWgerNormalizer(registry),before=await normalize(row)
 registry.languages.find(v=>v.id===2).short_name='fr';registry.licenses.find(v=>v.id===3).url='https://evil.test/'
 assert.deepEqual(await normalize(row),before)
 let ran=false;const bad={...row};Object.defineProperty(bad,'protein',{enumerable:true,get(){ran=true;return 7}})
 await assert.rejects(normalize(bad));assert.equal(ran,false)
})
test('bulk registry rejects accessors without invoking them',()=>{
 let ran=false;const registry={licenses:[]};Object.defineProperty(registry,'languages',{enumerable:true,get(){ran=true;return []}})
 assert.throws(()=>createWgerNormalizer(registry));assert.equal(ran,false)
})
test('captured registry requires complete counts, unique IDs and valid language codes',t=>{
 const base=fileURLToPath(new URL('./artifacts/',import.meta.url)),root=fs.mkdtempSync(path.join(base,'wger-meta.'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}))
 const languages={count:1,next:null,results:[{id:12,short_name:'fr'}]},licenses={count:1,next:null,results:[{id:3,url:'https://creativecommons.org/publicdomain/zero/1.0/'}]}
 const save=()=>{fs.writeFileSync(path.join(root,'language.json'),JSON.stringify(languages));fs.writeFileSync(path.join(root,'license.json'),JSON.stringify(licenses))}
 save();assert.equal(loadRegistry(path.basename(root)).verified,true)
 languages.count=2;save();assert.throws(()=>loadRegistry(path.basename(root)),/incomplete-registry/)
 languages.count=1;languages.next='https://wger.de/next';save();assert.throws(()=>loadRegistry(path.basename(root)),/incomplete-registry/)
 languages.next=null;languages.results[0].short_name='FR';save();assert.throws(()=>loadRegistry(path.basename(root)),/invalid-registry/)
 languages.results=[{id:12,short_name:'fr'},{id:12,short_name:'en'}];languages.count=2;save();assert.throws(()=>loadRegistry(path.basename(root)),/invalid-registry/)
})
test('a paginated-complete registry must also cover the dump foreign keys before import',()=>{
 const registry={...repositoryRegistry,verified:true},audit={languageIds:{1:2,2:3,12:4},licenseIds:{3:2,5:4}}
 assert.doesNotThrow(()=>verifyRegistryCoverage(registry,audit))
 assert.throws(()=>verifyRegistryCoverage(registry,{...audit,languageIds:{99:1}}),/registry-source-language-missing/)
 assert.throws(()=>verifyRegistryCoverage(registry,{...audit,licenseIds:{77:1}}),/registry-source-license-missing/)
 assert.doesNotThrow(()=>verifyRegistryCoverage(repositoryRegistry,{languageIds:{99:1},licenseIds:{77:1}}))
})
