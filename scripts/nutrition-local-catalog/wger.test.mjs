import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {normalizeWger,licenseInfo} from './wger-normalize.mjs'
import {journalProof,evaluate} from './wger-evaluate.mjs'
import {nutrientsForQuantity} from '../../frontend/src/lib/nutrition/calculate.js'
const languages=[{id:12,short_name:'fr'},{id:2,short_name:'en'}],licenses=[{id:2,url:'https://creativecommons.org/licenses/by-sa/4.0/deed.en'},{id:5,url:'https://opendatacommons.org/licenses/odbl/'},{id:3,url:'http://creativecommons.org/publicdomain/zero/1.0/'}]
const context={languages,licenses}
const row=(patch={})=>({id:1,uuid:'12345678-1234-1234-1234-123456789abc',code:null,name:'Riz complet',brand:null,common_name:null,language:12,license:2,license_author:'Fixture contributor',source_name:'wger',source_url:'',energy:350,protein:'7.123',carbohydrates:'70.125',fat:'0.000',weight_units:[{uuid:'12345678-1234-1234-1234-123456789abd',name:'Portion',gram:150}],...patch})
test('generic UUID is not a fake GTIN; native declared grams preserve decimals, zero and attribution',async()=>{
 const p=await normalizeWger(row(),context);assert.equal(p.barcode,null);assert.equal(p.id,'wger:'+row().uuid);assert.equal(p.food.nutrients.protein,7.123);assert.equal(p.food.nutrients.fat,0);assert.equal(p.food.nutrients.sodium,null);assert.equal(p.food.reference.unit,'g');assert.ok(p.food.source.license.attribution.includes('Fixture contributor'));assert.equal(p.food.portions[0].amount,150);assert.equal(nutrientsForQuantity(p.food,{amount:1,unit:'portion',portionId:p.food.portions[0].id}).kcal,525)
})
test('OFF-derived complete macros do not restore their missing denominator',async()=>{
 const p=await normalizeWger(row({source_name:'Open Food Facts',source_url:'https://world.openfoodfacts.org/api/v2/product/0034000470693.json',license:5,code:'0034000470693',name:'Boisson'}),context)
 assert.equal(p.complete,true);assert.equal(p.food,null);assert.equal(p.barcode,'0034000470693');assert.ok(p.issues.includes('off-100g-or-100ml-reference-lost'))
})
test('legacy blank provenance + barcode cannot silently be called native per100g',async()=>{
 const p=await normalizeWger(row({source_name:null,code:'0034000470693'}),context);assert.equal(p.food,null)
})
test('unknown foreign keys are not defaulted to French or ODbL',async()=>{
 const p=await normalizeWger(row({language:999,license:999}),context);assert.equal(p.language,null);assert.equal(p.food,null);assert.ok(p.issues.includes('unresolved-license'))
})
test('missing nutrient remains unknown with partial classification, never invented zero',async()=>{
 const p=await normalizeWger(row({protein:null}),context);assert.equal(p.complete,false);assert.equal(p.food.nutrients.protein,null)
})
test('invalid nutrients and unsafe provenance prevent an addable Food',async()=>{
 for(const patch of [{protein:-1},{energy:Infinity},{fat:'NaN'},{protein:{}},{source_url:'javascript:alert(1)'},{license_author_url:0}]){const p=await normalizeWger(row(patch),context).catch(()=>({food:null}));assert.equal(p.food,null)}
})
test('invalid weight unit is reported without inventing mass or density',async()=>{
 const p=await normalizeWger(row({weight_units:[{uuid:row().uuid,name:'Glass 250ml',gram:0}]}),context);assert.ok(p.food);assert.deepEqual(p.food.portions,[]);assert.ok(p.warnings.includes('invalid-portion-omitted'))
})
test('dangerous objects/getters are rejected without execution',async()=>{
 let ran=false;const p=row();Object.defineProperty(p,'name',{enumerable:true,get(){ran=true;return 'Rice'}});await assert.rejects(normalizeWger(p,context));assert.equal(ran,false)
 await assert.rejects(normalizeWger(Object.assign(Object.create({energy:35}),row()),context))
})
test('USDA item uses declared per100g and its own CC0 row licence, not OFF attribution',async()=>{
 const p=await normalizeWger(row({source_name:'USDA',license:3}),context);assert.ok(p.food);assert.equal(p.food.source.license.id,'CC0-1.0');assert.equal(p.food.source.publicCatalogImport.sourceName,'USDA')
})
test('supported licence URLs are decoded independently of numeric registry IDs',()=>{
 assert.equal(licenseInfo({url:'https://creativecommons.org/licenses/by/4.0/'}).id,'CC-BY-4.0');assert.equal(licenseInfo({url:'https://evil.example/licenses/by-sa/4.0/'}),null);assert.equal(licenseInfo({url:'javascript:alert(1)'}),null)
})
test('real UI commands + real temp files retain native Food, calculations and pending queue after reopen without network',async()=>{
 const p=await normalizeWger(row(),context),proof=await journalProof(p.food);assert.equal(proof.totals.kcal,175);assert.equal(proof.totals.protein,7.123/2);assert.equal(proof.networkCalls,0);assert.equal(proof.pendingPreserved,true)
})
test('isolated SQLite FTS works with generic UUIDs and literal-only French search',async t=>{
 const base=fileURLToPath(new URL('./artifacts/',import.meta.url));fs.mkdirSync(base,{recursive:true});const suffix=randomUUID().slice(0,8),capture='wger-fixture-'+suffix,output='wger-result-'+suffix;const root=path.join(base,capture);fs.mkdirSync(root)
 t.after(()=>{fs.rmSync(root,{recursive:true,force:true});fs.rmSync(path.join(base,output),{recursive:true,force:true})})
 const files={},save=(name,data)=>{const b=Buffer.from(data);fs.writeFileSync(path.join(root,name),b);files[name]={bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')}}
 save('head.json','{}');save('language.json',JSON.stringify({results:languages}));save('license.json',JSON.stringify({results:licenses}));save('count.json','{"count":2}')
 save('rows.jsonl',JSON.stringify(row())+'\n'+JSON.stringify(row({id:2,uuid:'12345678-1234-1234-1234-123456789abe',source_name:'Open Food Facts',license:5,name:'Nutella',code:'3017620422003'}))+'\n')
 fs.writeFileSync(path.join(root,'capture.json'),JSON.stringify({format:'opengym-wger-evaluation-capture',version:1,complete:true,fixture:true,head:{url:'https://wger.de/media/ingredients/ingredients.jsonl.gz'},prefix:{rows:2},files}))
 const report=await evaluate(capture,output);assert.equal(report.counts.rows,2);assert.equal(report.counts.directComplete,1);assert.equal(report.search.riz.addableOnPage,1);assert.equal(report.search.Nutella.addableOnPage,0);assert.ok(report.journalProofs[0].passed);assert.equal(report.capture.fixture,true);assert.equal(report.externalCallsDuringEvaluation,0)
})
