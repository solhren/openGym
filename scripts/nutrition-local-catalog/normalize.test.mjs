import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { normalizeRecord, projectTsv } from './normalize.mjs'
import { jsonLines } from './build.mjs'
import { fixture } from './fixtures.mjs'

const raw = extra => ({ code: '3017620422003', product_name: 'Produit de test', product_name_fr: 'Aliment test', brands: 'Exemple', countries_tags: ['en:france'], nutrition_data_per: '100g', nutriments: { 'energy-kcal_100g': '83.33333333333333', proteins_100g: '0.10000000000000002', carbohydrates_100g: '12.35', fat_100g: '0' }, ...extra })

test('normalization preserves exact parsed decimals and explicit zero', async () => {
  const r = await normalizeRecord(raw())
  assert.deepEqual(r.nutrients, { kcal: 83.33333333333333, protein: 0.10000000000000002, carbs: 12.35, fat: 0 })
  assert.deepEqual(r.reference, { amount: 100, unit: 'g' })
})
test('kJ conversion reuses engine/provider rules, never macro-derived kcal', async () => {
  const r = await normalizeRecord(raw({ nutriments: { 'energy-kj_100g': '418.4', proteins_100g: 2 } }))
  assert.equal(r.nutrients.kcal, 418.4 / 4.184)
  assert.equal(r.nutrients.carbs, null)
  assert.equal(r.nutrients.fat, null)
})
test('v3 ml is preserved, no density assumed and mass stays mass', async () => {
  const liquid = await normalizeRecord(fixture(2)), solid = await normalizeRecord(fixture(5))
  assert.deepEqual(liquid.reference, { amount: 100, unit: 'ml' })
  assert.equal(liquid.nutrients.protein, 3.2)
  assert.deepEqual(solid.reference, { amount: 100, unit: 'g' })
})
test('known serving converted to same-unit 100 reference through engine', async () => {
  const r = await normalizeRecord(raw({ nutrition_data_per: 'serving', serving_quantity: 30, serving_quantity_unit: 'g', serving_size: 'Portion (30 g)', nutriments: { 'energy-kcal_serving': 60, proteins_serving: 3.75, carbohydrates_serving: 5.1, fat_serving: 0 } }))
  assert.deepEqual(r.reference, { amount: 100, unit: 'g' })
  assert.equal(r.nutrients.kcal, 200)
  assert.equal(r.nutrients.protein, 12.5)
  assert.equal(r.nutrients.carbs, 17)
  assert.equal(r.portions[0].amount, 30)
})
test('unknown portions and ambiguous volume never invent nutrients or grams', async () => {
  const r = await normalizeRecord(raw({ product_quantity_unit: 'ml', serving_size: 'un verre' }))
  assert.equal(r.reference, null)
  assert.deepEqual(r.nutrients, { kcal: null, protein: null, carbs: null, fat: null })
  assert.ok(r.warnings.includes('reference-required'))
})
test('completely missing nutrients retain known unit and null values', async () => {
  const r = await normalizeRecord(fixture(0))
  assert.deepEqual(r.reference, { amount: 100, unit: 'g' })
  assert.deepEqual(r.nutrients, { kcal: null, protein: null, carbs: null, fat: null })
})
test('invalid nutrients, energy discrepancy and estimates are treated safely', async () => {
  for (const value of ['-1', '-0', NaN, Infinity, 'abc', true, 101]) {
    await assert.rejects(normalizeRecord(raw({ nutriments: { proteins_100g: value } })))
  }
  await assert.rejects(normalizeRecord(raw({ nutriments: { 'energy-kcal_100g': 100, 'energy-kj_100g': 1000 } })), { code: 'inconsistent-energy' })
  const r = await normalizeRecord(raw({ nutriments: { proteins_100g: 12, proteins_modifier: '~' } }))
  assert.equal(r.nutrients.protein, null)
})
test('French name, barcode zeroes, countries and source modification retained', async () => {
  const r = await normalizeRecord(raw({ code: '00012345', countries_tags: ['en:france', 'en:france', 'en:belgium'], last_modified_t: 12345 }))
  assert.equal(r.code, '00012345')
  assert.equal(r.nameFr, 'Aliment test')
  assert.deepEqual(r.countries, ['en:belgium', 'en:france'])
  assert.equal(r.modifiedAt, 12345)
})
test('no private/unknown fields or image bytes are retained', async () => {
  const r = await normalizeRecord(raw({ editor: 'PRIVATE_SENTINEL', image_front_small_url: 'https://evil.invalid/image', user: { token: 'PRIVATE_SENTINEL' } }))
  assert.ok(!JSON.stringify(r).includes('PRIVATE_SENTINEL'))
  assert.ok(!Object.hasOwn(r, 'image'))
})
test('malicious objects, country tags and excessive strings are rejected', async () => {
  for (const r of [JSON.parse('{"__proto__":{},"code":"00012345"}'), Object.create(raw()), raw({ countries_tags: [{}] }), raw({ product_name: 'x'.repeat(301) }), raw({ last_modified_t: true })]) await assert.rejects(normalizeRecord(r))
})
test('TSV explicit reference retains decimal values and countries', async () => {
  const { raw: product, ambiguousReference } = projectTsv({ code: '00012345', product_name: 'Lait', nutrition_data_per: '100ml', 'energy-kcal_100g': '46.5', proteins_100g: '3.2', countries_tags: 'en:france,en:belgium' })
  const r = await normalizeRecord(product, { ambiguousReference })
  assert.deepEqual(r.reference, { amount: 100, unit: 'ml' })
  assert.equal(r.nutrients.kcal, 46.5)
})
test('TSV missing quantity metadata cannot silently assign 100g', async () => {
  const { raw: product, ambiguousReference } = projectTsv({ code: '00012345', product_name: 'Lait', 'energy-kcal_100g': '46.5', proteins_100g: '3.2' })
  assert.equal(ambiguousReference, true)
  const r = await normalizeRecord(product, { ambiguousReference })
  assert.equal(r.reference, null)
  assert.equal(r.nutrients.kcal, null)
})
test('TSV absent nutrient versus numeric zero', async () => {
  const projected = projectTsv({ code: '00012345', product_name: 'Riz', nutrition_data_per: '100g', proteins_100g: '0', fat_100g: '' })
  const r = await normalizeRecord(projected.raw, projected)
  assert.equal(r.nutrients.protein, 0)
  assert.equal(r.nutrients.fat, null)
})
test('bounded line stream decodes UTF-8 across arbitrary chunk boundaries', async () => {
  const bytes = Buffer.from('pâtes\nCoca-Cola\n')
  assert.deepEqual(await Array.fromAsync(jsonLines(Readable.from([...bytes].map(b => Buffer.from([b]))))), ['pâtes', 'Coca-Cola'])
})
test('truncated, oversized, empty and invalid UTF-8 lines rejected', async () => {
  for (const value of [Buffer.from('truncated'), Buffer.alloc(1024*1024+1, 65), Buffer.from('\n'), Buffer.from([255, 10])]) await assert.rejects(Array.fromAsync(jsonLines(Readable.from([value]))))
})

test('TSV package mass or serving text never substitutes for missing nutrition reference',async()=>{
  for(const fields of [{product_quantity_unit:'g'},{product_quantity_unit:'ml'}, {serving_size:'30 g',serving_quantity:'30'}]){
    const p=projectTsv({code:'00012345',product_name:'Public identity',...fields,'energy-kcal_100g':'6000',proteins_100g:'3.25'})
    const r=await normalizeRecord(p.raw,p)
    assert.equal(r.reference,null);assert.ok(Object.values(r.nutrients).every(v=>v===null));assert.equal(r.portions.length,0)
    assert.ok(r.warnings.includes('export-qualifiers-unavailable'))
  }
})
test('TSV official nutrition error tags retain identity without exposing macros as valid',async()=>{
  const p=projectTsv({code:'00012345',product_name:'Identity',nutrition_data_per:'100g','energy-kcal_100g':'200',data_quality_errors_tags:'en:nutrition-value-over-105'})
  const r=await normalizeRecord(p.raw,p);assert.equal(r.code,'00012345');assert.equal(r.reference,null);assert.ok(r.warnings.includes('nutrition-rejected'));assert.ok(r.warnings.includes('source-quality-warning'))
})
test('TSV known units and modifiers reuse engine; nulls are not zeroes',async()=>{
  const p=projectTsv({code:'00012345',product_name:'Milk',nutrition_data_per:'100ml','energy-kcal_100g':'46.125',proteins_100g:'0',fat_100g:'0.5',fat_modifier:'<',carbohydrates_100g:''})
  const r=await normalizeRecord(p.raw,p);assert.equal(r.reference.unit,'ml');assert.equal(r.nutrients.kcal,46.125);assert.equal(r.nutrients.protein,0);assert.equal(r.nutrients.fat,null);assert.equal(r.nutrients.carbs,null)
})
test('TSV unsafe descriptors and arbitrary reference tokens are rejected without getter invocation',()=>{
  let invoked=false;const row={code:'00012345',product_name:'Name'};Object.defineProperty(row,'brands',{enumerable:true,get(){invoked=true;return 'bad'}})
  assert.throws(()=>projectTsv(row));assert.equal(invoked,false)
  assert.throws(()=>projectTsv(Object.create({code:'00012345',product_name:'Name'})))
  assert.throws(()=>projectTsv({code:'00012345',product_name:'Name',nutrition_data_per:'water-density'}))
})

test('2026 official TSV brand tag/localized columns are supported without losing brand search',async()=>{
  const p=projectTsv({code:'00012345',product_name:'Synthetic brand product',brands_tags:'ferrero',brands_en:'Ferrero'})
  const r=await normalizeRecord(p.raw,p);assert.equal(r.brand,'Ferrero');assert.equal(r.reference,null)
})
