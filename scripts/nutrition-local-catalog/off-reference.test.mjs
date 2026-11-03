import test from 'node:test'
import assert from 'node:assert/strict'
import {normalizeReference,projectRaw} from './off-reference-normalize.mjs'
import {nutrientsForQuantity} from '../../frontend/src/lib/nutrition/calculate.js'
const evidence={kind:'fixture',rowSha256:'a'.repeat(64)}
function fixture(per='100g'){
 const set={source:'packaging',preparation:'as_sold',per,per_unit:per==='100g'?'g':'ml',per_quantity:100,nutrients:Object.fromEntries([['energy-kcal',100],['proteins',3.2],['carbohydrates',10.6],['fat',4.3]].map(([k,v])=>[k,{value:v,unit:k==='energy-kcal'?'kcal':'g'}]))}
 return {code:'3017620422003',product_name:'Synthetic fixture',nutrition:{input_sets:[set]},data_quality_errors_tags:[]}
}
test('explicit input mass and volume stay distinct and incompatible consumption fails',async()=>{
 for(const per of ['100g','100ml']){const p=await normalizeReference(fixture(per),evidence);assert.equal(p.reference.unit,per==='100g'?'g':'ml');assert.equal(p.food.nutrients.protein,3.2);assert.throws(()=>nutrientsForQuantity(p.food,{amount:50,unit:per==='100g'?'ml':'g'}))}
})
test('mixed OFF aggregate cannot turn the original input volume into mass',async()=>{
 const raw=fixture('100ml');raw.nutrition.aggregated_set={per:'100g',preparation:'as_sold',nutrients:{proteins:{value:900}}};raw.nutrition.input_sets.unshift({source:'packaging',preparation:'as_sold',per:'100g',nutrients:{}})
 const p=await normalizeReference(raw,evidence);assert.equal(p.reference.unit,'ml');assert.equal(p.food.nutrients.protein,3.2)
})
test('computed-only kcal is ignored while explicitly declared kJ uses the existing converter',async()=>{
 const raw=fixture('100ml'),ns=raw.nutrition.input_sets[0].nutrients;ns['energy-kcal']={value_computed:400,unit:'kcal'};ns['energy-kj']={value:180,unit:'kJ'}
 const p=await normalizeReference(raw,evidence);assert.equal(p.food.nutrients.kcal,180/4.184)
})
test('legacy suffixes or package units alone never become a validated reference',async()=>{
 await assert.rejects(normalizeReference({code:'3017620422003',product_name:'Fixture',product_quantity_unit:'ml',nutrition_data_per:'100g',nutriments:{proteins_100g:3}},evidence),/original-input-sets-unavailable/)
})
test('missing computed qualified negative and incompatible values remain rejected',async()=>{
 for(const mode of ['missing','computed','qualifier','negative','unit','NaN','estimated']){
  const raw=fixture(),s=raw.nutrition.input_sets[0],n=s.nutrients.proteins
  if(mode==='missing')delete s.nutrients.proteins
  if(mode==='computed'){n.value_computed=n.value;delete n.value}
  if(mode==='qualifier')n.modifier='<'
  if(mode==='negative')n.value=-1
  if(mode==='unit')n.unit='mg'
  if(mode==='NaN')n.value=NaN
  if(mode==='estimated')s.source='estimate'
  await assert.rejects(normalizeReference(raw,evidence))
 }
})
test('contradictory per fields and explicit no-nutrition flags reject',async()=>{
 for(const patch of [{per_unit:'ml'},{per_quantity:50},{preparation:'prepared'}]){const p=fixture();Object.assign(p.nutrition.input_sets[0],patch);await assert.rejects(normalizeReference(p,evidence))}
 const p=fixture();p.no_nutrition_data='on';await assert.rejects(normalizeReference(p,evidence))
})
test('errors are scoped to the input actually selected, unscoped nutrition errors block',async()=>{
 const p=fixture();p.data_quality_errors_tags=['en:nutrition-packaging-as-sold-serving-invalid'];assert.ok((await normalizeReference(p,evidence)).food)
 for(const tag of ['en:nutrition-packaging-as-sold-100g-invalid','en:nutrition-unknown-error','en:energy-invalid']){p.data_quality_errors_tags=[tag];await assert.rejects(normalizeReference(p,evidence))}
})
test('manufacturer cannot arbitrarily override a conflicting valid packaging set',async()=>{
 const p=fixture();const other=structuredClone(p.nutrition.input_sets[0]);other.source='manufacturer';other.nutrients.proteins.value=4;p.nutrition.input_sets.push(other)
 await assert.rejects(normalizeReference(p,evidence),/conflicting-valid-input-sets/)
 other.nutrients.proteins.value=3.2;assert.equal((await normalizeReference(p,evidence)).lineage.source,'manufacturer')
})
test('invalid packaging does not invalidate a separate consistent manufacturer set',async()=>{
 const p=fixture();const other=structuredClone(p.nutrition.input_sets[0]);other.source='manufacturer';p.nutrition.input_sets.push(other);p.data_quality_errors_tags=['en:nutrition-packaging-as-sold-100g-invalid']
 const result=await normalizeReference(p,evidence);assert.equal(result.lineage.source,'manufacturer');assert.deepEqual(result.lineage.qualityErrors,p.data_quality_errors_tags);assert.equal(result.lineage.rejectedInputSets.length,1)
})
test('all-zero unknown identities remain review-only; energy inconsistency is not hidden',async()=>{
 const p=fixture();for(const n of Object.values(p.nutrition.input_sets[0].nutrients))n.value=0;await assert.rejects(normalizeReference(p,evidence))
 const bad=fixture();bad.nutrition.input_sets[0].nutrients['energy-kj']={value:4000,unit:'kJ'};await assert.rejects(normalizeReference(bad,evidence))
})
test('prototypes accessors unsafe keys and malformed provenance do not cross the boundary',async()=>{
 let invoked=false;const p=fixture();Object.defineProperty(p,'product_name',{enumerable:true,get(){invoked=true;return 'bad'}});assert.throws(()=>projectRaw(p));assert.equal(invoked,false)
 assert.throws(()=>projectRaw(Object.create(fixture())));assert.throws(()=>projectRaw(JSON.parse('{"__proto__":{}}')))
 await assert.rejects(normalizeReference(fixture(),{kind:'api-v3.5',rowSha256:'bad'}))
})
test('food identity changes with immutable provenance and keeps ODbL attribution',async()=>{
 const a=await normalizeReference(fixture(),evidence),b=await normalizeReference(fixture(),{...evidence,rowSha256:'b'.repeat(64)})
 assert.notEqual(a.food.id,b.food.id);assert.equal(a.food.source.license.id,'ODbL-1.0');assert.equal(a.food.source.contentLicense,'DbCL-1.0');assert.equal(a.lineage.kind,'fixture')
})
test('leading-zero aliases require valid GTIN checksums and preserve the original code',async()=>{
 const p=fixture();p.code='00036000291452';const v=await normalizeReference(p,evidence);assert.equal(v.lineage.originalCode,p.code)
 p.code='00036000291453';await assert.rejects(normalizeReference(p,evidence))
 p.code='0000000000000';await assert.rejects(normalizeReference(p,evidence),/invalid-barcode/)
})
test('unknown future product schema is not silently interpreted',async()=>{
 const p=fixture();p.schema_version=1005;await assert.rejects(normalizeReference(p,evidence),/unsupported-product-schema/)
})
