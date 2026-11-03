import { test, expect } from 'vitest'
import { normalizeProduct, barcode, normalizedBarcode, inspectExternal, imageUrl } from './normalize.js'
import { offProduct, v3Product } from './fixtures.test-util.js'
import { nutrientsForQuantity } from '../calculate.js'
import { validateFood } from '../validate.js'
test('local catalogue warnings survive provenance while generation changes keep food identity stable',async()=>{
  const raw={...offProduct(),opengym_catalog:{version:'a'.repeat(64),warnings:['export-qualifiers-unavailable','source-quality-warning']}}
  const first=await normalizeProduct(raw)
  expect(first.warnings).toContain('export-qualifiers-unavailable')
  expect(first.food.source.catalogueWarnings).toContain('source-quality-warning')
  raw.opengym_catalog.version='b'.repeat(64)
  expect((await normalizeProduct(raw)).food.id).toBe(first.food.id)
})
test('rejected local nutrition and unknown extension fields cannot bypass validation',async()=>{
  await expect(normalizeProduct({...offProduct(),opengym_catalog:{version:'a'.repeat(64),warnings:['nutrition-rejected']}})).rejects.toMatchObject({code:'invalid-nutrients'})
  await expect(normalizeProduct({...offProduct(),opengym_catalog:{version:'a'.repeat(64),warnings:[],privateField:'hidden'}})).rejects.toMatchObject({code:'invalid-response'})
})
test('localized name, safe portions, explicit provenance and engine calculations', async () => {
  const p = await normalizeProduct(offProduct()); expect(p.name).toBe('Pâte à tartiner'); expect(validateFood(p.food)).toEqual([])
  expect(p.food.source.externalId).toBe('3017620422003'); expect(p.food.source.license.id).toBe('ODbL-1.0')
  expect(nutrientsForQuantity(p.food, { amount: 1, unit: 'portion', portionId: 'off-serving' }).kcal).toBeCloseTo(80.85)
})
test('kJ conversion, no macro-derived energy, no double conversion of contributor units', async () => {
  expect((await normalizeProduct(offProduct({ nutriments: { energy_100g: '418.4' } }))).food.nutrients.kcal).toBeCloseTo(100)
  const p = await normalizeProduct(offProduct({ nutriments: { sodium_100g: .1, sodium_unit: 'mg' } }))
  expect(p.food.nutrients.sodium).toBe(.1); expect(p.food.nutrients.kcal).toBeNull()
})
test('v3 volume basis never acquires a fabricated density', async () => {
  const p = await normalizeProduct(v3Product()); expect(p.food.reference).toEqual({ amount: 100, unit: 'ml' })
  expect(nutrientsForQuantity(p.food, { amount: 250, unit: 'ml' }).kcal).toBe(115)
  expect(() => nutrientsForQuantity(p.food, { amount: 250, unit: 'g' })).toThrow()
})
test.each([{ value_computed: 46 }, { value: 46, source: 'estimate' }])('computed/estimated energy %j stays unknown', async value => {
  const raw = v3Product(); raw.nutrition.aggregated_set.nutrients['energy-kcal'] = value
  expect((await normalizeProduct(raw)).food.nutrients.kcal).toBeNull()
})
test('ambiguous liquid legacy base refuses addition', async () => expect((await normalizeProduct(offProduct({ product_quantity_unit: 'ml' }))).food).toBeNull())
test('serving-only values retain actual reference; uninterpretable serving cannot be added', async () => {
  const p = await normalizeProduct(offProduct({ nutriments: { 'energy-kcal_serving': 50 } }))
  expect(p.food.reference).toEqual({ amount: 15, unit: 'g' }); expect(nutrientsForQuantity(p.food, { amount: 30, unit: 'g' }).kcal).toBe(100)
  expect((await normalizeProduct(offProduct({ serving_quantity: null, serving_size: 'One bowl', nutriments: { proteins_serving: 2 } }))).food).toBeNull()
})
test('strict textual serving, missing nutrient and true zero', async () => {
  const p = await normalizeProduct(offProduct({ serving_quantity: null, serving_size: '30 ml', nutrition_data_per: '100ml', nutriments: { proteins_100g: 0 } }))
  expect(p.food.portions[0]).toMatchObject({ amount: 30, unit: 'ml' }); expect(p.food.nutrients.protein).toBe(0); expect(p.food.nutrients.fiber).toBeNull()
})
test.each([-1, Infinity, NaN, 'bad', true, {}, '1e5', '1,2', 100001])('unsafe nutrient %j rejected', async value => await expect(normalizeProduct(offProduct({ nutriments: { proteins_100g: value } }))).rejects.toThrow())
test.each([{ proteins_100g: 101 }, { carbohydrates_100g: 1, sugars_100g: 2 }, { fat_100g: 1, 'saturated-fat_100g': 2 }, { 'energy-kcal_100g': 5000 }, { 'energy-kcal_100g': 100, energy_100g: 1000 }])('inconsistent %j rejected by unchanged business rules', async nutriments => await expect(normalizeProduct(offProduct({ nutriments }))).rejects.toThrow())
test.each(['', '123', 3017620422003, '../12345678', '01234567x', ' 3017620422003', '12345678901'])('malformed barcode %j rejected', code => expect(() => barcode(code)).toThrow())
test('leading zeros and OFF equivalence accepted, mismatched code refused', async () => {
  expect(barcode('0034000470693')).toBe('0034000470693'); expect(normalizedBarcode('034000470693')).toBe('0034000470693')
  expect((await normalizeProduct(offProduct({ code: '0034000470693' }), { expectedCode: '034000470693' })).code).toBe('0034000470693')
  await expect(normalizeProduct(offProduct(), { expectedCode: '00000000' })).rejects.toMatchObject({ code: 'barcode-mismatch' })
})
test('IDs deterministic per revision, updated product cannot mutate old revision', async () => {
  const a = await normalizeProduct(offProduct()), b = await normalizeProduct(offProduct()), c = await normalizeProduct(offProduct({ brands: 'Other' }))
  expect(a.food.id).toBe(b.food.id); expect(a.food.id).not.toBe(c.food.id); expect(a.food.brand).toBe('Example')
})
test.each(['javascript:alert(1)', 'https://images.openfoodfacts.org.evil.org/images/products/1/front.jpg', 'https://user@images.openfoodfacts.org/images/products/1/front.jpg', 'data:image/png,hi', 'https://images.openfoodfacts.org/other.png', 'https://images.openfoodfacts.org/images/products/1/front_fr.full.jpg', 'https://images.openfoodfacts.org/images/products/1/front_fr.200.jpg?redirect=elsewhere'])('unsafe image %s omitted', url => expect(imageUrl(url)).toBeNull())
test('safe fixed-host product image accepted', () => expect(imageUrl('https://images.openfoodfacts.org/images/products/301/762/042/2003/front_fr.200.jpg')).toBeTruthy())
test.each([null, [], {}, offProduct({ product_name: '', product_name_fr: '' }), offProduct({ brands: 'x'.repeat(301) })])('invalid product shape rejected', async raw => await expect(normalizeProduct(raw)).rejects.toThrow())
test('prototype/accessor/symbol/deep/circular/pollution inputs rejected without executing getters', () => {
  const circular = {}; circular.self = circular; const getter = {}; Object.defineProperty(getter, 'secret', { get() { throw Error('executed') }, enumerable: true })
  let deep = {}; for (let n = 0; n < 14; n++) deep = { child: deep }
  for (const value of [Object.create({ name: 'inherited' }), getter, circular, deep, { [Symbol()]: 1 }, JSON.parse('{"__proto__":{"polluted":true}}')]) expect(() => inspectExternal(value)).toThrow()
  expect({}.polluted).toBeUndefined()
})

test.each(['100g', 'serving'])('legacy %s qualifier is not silently promoted to an exact value', async suffix => {
  const p = await normalizeProduct(offProduct({ nutriments: { [`energy-kcal_${suffix}`]: 20, [`proteins_${suffix}`]: .5, proteins_modifier: '<' } }))
  expect(p.food.nutrients.protein).toBeNull(); expect(p.warnings).toContain('missing-values')
})
