import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyHuggingFace, convertEnvelope, projectHuggingFace, validateEnvelope } from './huggingface.mjs'
import { normalizeRecord } from './normalize.mjs'

// Synthetic examples of the observed schema. No production product dump needed.
export const hfFeatures = () => [
  { name: 'code', type: { dtype: 'string', _type: 'Value' } },
  { name: 'product_name', type: { _type: 'List', feature: { lang: { dtype: 'string' }, text: { dtype: 'string' } } } },
  { name: 'nutriments', type: { _type: 'List', feature: { name: { dtype: 'string' }, '100g': { dtype: 'float32' }, serving: { dtype: 'float32' }, value: { dtype: 'float32' }, unit: { dtype: 'string' } } } },
]
export const hfRow = extra => ({ code: '00012345', product_name: [{ lang: 'main', text: 'Example food' }, { lang: 'fr', text: 'Aliment français' }], generic_name: null, lang: 'fr', brands: null, countries_tags: ['en:france'], last_modified_t: 1700000000, nutrition_data_per: '100g',
  nutriments: [{ name: 'energy-kcal', '100g': 35.5, unit: 'kcal' }, { name: 'proteins', '100g': 0, unit: 'g' }, { name: 'carbohydrates', '100g': 8.890000343322754, unit: 'g' }, { name: 'fat', '100g': 0, unit: 'g' }], ...extra })
export const hfEnvelope = rows => ({ features: hfFeatures(), rows: rows.map((row, i) => ({ row_idx: i, row, truncated_cells: [] })), num_rows_total: rows.length, num_rows_per_page: 100, partial: false })

test('viewer envelope -> original normalizer preserves float32 values, localized names and zeros', async () => {
  const result = convertEnvelope(hfEnvelope([hfRow()]))
  const record = await normalizeRecord(result.products[0])
  assert.equal(record.code, '00012345')
  assert.equal(record.nameFr, 'Aliment français')
  assert.equal(record.nutrients.carbs, 8.890000343322754)
  assert.equal(record.nutrients.protein, 0)
  assert.ok(record.warnings.includes('export-qualifiers-unavailable'))
})
test('standardized energy remains kJ despite contributor kcal unit; sodium standardized grams despite mg', async () => {
  const raw = projectHuggingFace(hfRow({ nutriments: [{ name: 'energy', value: 100, '100g': 418.4, unit: 'kcal' }, { name: 'sodium', value: 4, '100g': 0.004000000189989805, unit: 'mg' }] }))
  assert.equal(raw.nutriments.sodium_100g, 0.004000000189989805)
  const record = await normalizeRecord(raw)
  assert.equal(record.nutrients.kcal, 418.4/4.184)
})
test('prepared and contributor values never substitute absent standardized data', async () => {
  const raw = projectHuggingFace(hfRow({ nutriments: [{ name: 'energy-kcal', value: 200, prepared_100g: 200, '100g': null, serving: null }] }))
  assert.equal(Object.keys(raw.nutriments).length, 0)
  assert.equal((await normalizeRecord(raw)).nutrients.kcal, null)
})
test('null 100g fields do not hide impossible serving-only nutrition', async () => {
  const raw = projectHuggingFace(hfRow({ nutrition_data_per: 'serving', serving_size: '1g', serving_quantity: '1.0', product_quantity_unit: 'g', nutriments: [{ name: 'energy-kcal', '100g': null, serving: 280 }, { name: 'carbohydrates', '100g': null, serving: 70 }] }))
  assert.equal(Object.hasOwn(raw.nutriments, 'carbohydrates_100g'), false)
  await assert.rejects(normalizeRecord(raw), { code: 'invalid-nutrients' })
})
test('plausible known serving is scaled by engine; decimal string does not supply a guessed unit', async () => {
  const raw = projectHuggingFace(hfRow({ nutrition_data_per: 'serving', serving_size: '25 ml', serving_quantity: '25.0', nutriments: [{ name: 'energy-kcal', '100g': null, serving: 10 }, { name: 'carbohydrates', '100g': null, serving: 2 }] }))
  const record = await normalizeRecord(raw)
  assert.deepEqual(record.reference, { amount: 100, unit: 'ml' })
  assert.equal(record.nutrients.kcal, 40)
  assert.equal(record.nutrients.carbs, 8)
  raw.serving_size = 'un verre'; delete raw.nutrition
  assert.equal((await normalizeRecord(raw)).reference, null)
})
test('missing nutrition remains null with a known explicit 100g or 100ml reference', async () => {
  for (const unit of ['100g', '100ml']) {
    const record = await normalizeRecord(projectHuggingFace(hfRow({ nutrition_data_per: unit, nutriments: null })))
    assert.equal(record.reference.unit, unit === '100ml' ? 'ml' : 'g')
    assert.deepEqual(record.nutrients, { kcal: null, protein: null, carbs: null, fat: null })
  }
})
test('ambiguous liquid package stays unknown; no density of water assumption', async () => {
  const record = await normalizeRecord(projectHuggingFace(hfRow({ nutrition_data_per: null, product_quantity_unit: 'ml' })))
  assert.equal(record.reference, null)
  assert.equal(record.nutrients.kcal, null)
})
test('source nutrition errors rejected; nutrition warnings and export uncertainty retained', async () => {
  assert.throws(() => projectHuggingFace(hfRow({ data_quality_errors_tags: ['en:energy-value-in-kcal-does-not-match-value-computed-from-other-nutrients'] })), { code: 'hf-nutrition-quality-error' })
  const record = await normalizeRecord(projectHuggingFace(hfRow({ data_quality_warnings_tags: ['en:energy-value-in-kcal-may-not-match-value-computed-from-other-nutrients'] })))
  assert.ok(record.warnings.includes('source-quality-warning'))
})
test('projection rejection is counted, not misrepresented as no search result', () => {
  const result = convertEnvelope(hfEnvelope([hfRow(), hfRow({ code: 'bad' })]))
  assert.equal(result.rows, 2)
  assert.equal(result.products.length, 1)
  assert.equal(result.rejected[0].reason, 'invalid-barcode')
})
test('duplicate languages/nutrients and contradictory no-nutrition flag rejected', () => {
  for (const row of [hfRow({ product_name: [{ lang: 'fr', text: 'A' }, { lang: 'fr', text: 'B' }] }), hfRow({ nutriments: [{ name: 'fat', '100g': 0 }, { name: 'fat', '100g': 1 }] }), hfRow({ no_nutrition_data: true })]) assert.throws(() => projectHuggingFace(row))
})
test('partial, truncated, duplicate-index, malformed or future schemas rejected', () => {
  const base = hfEnvelope([hfRow()])
  for (const change of [data => data.partial = true, data => data.rows[0].truncated_cells = ['nutriments'], data => data.rows.push(data.rows[0]), data => data.features[0].type.dtype = 'int64', data => data.features[2].type.feature.modifier = { dtype: 'string' }, data => data.future = true]) {
    const data = structuredClone(base); change(data)
    assert.throws(() => validateEnvelope(data))
  }
})
test('filtered results retain their original bounded row indices rather than filter positions', () => {
  const data = hfEnvelope([hfRow()]); data.rows[0].row_idx = 12825
  assert.equal(validateEnvelope(data), data)
})
test('prototypes, getters, poison keys and oversized names never become products', () => {
  for (const row of [Object.create(hfRow()), JSON.parse('{"__proto__":{}}'), hfRow({ product_name: [{ lang: 'fr', text: 'x'.repeat(301) }] })]) assert.throws(() => projectHuggingFace(row))
  let called = false
  const data = {}; Object.defineProperty(data, 'rows', { enumerable: true, get() { called = true; return [] } })
  assert.throws(() => validateEnvelope(data)); assert.equal(called, false)
  const row = hfRow(); Object.defineProperty(row, 'code', { enumerable: true, get() { called=true; return '00012345' } })
  const result = convertEnvelope(hfEnvelope([row])); assert.equal(result.rejected.length, 1); assert.equal(called, false)
})

test('explicit metadata-only recovery retains identity, discards all contradictory nutrition', async () => {
  for (const row of [hfRow({ data_quality_errors_tags: ['en:nutrition-value-over-100'] }), hfRow({ nutrition_data_per: 'serving', serving_size: '1g', serving_quantity: '1.0', nutriments: [{ name: 'energy-kcal', serving: 280 }, { name: 'carbohydrates', serving: 70 }] })]) {
    await assert.rejects(classifyHuggingFace(row))
    const result = await classifyHuggingFace(row, { retainUnusableNutrition: true })
    assert.equal(result.status, 'unusable'); assert.ok(result.originalError)
    assert.equal(result.record.reference, null)
    assert.deepEqual(result.record.nutrients, { kcal: null, protein: null, carbs: null, fat: null })
    assert.equal(result.record.portions.length, 0)
    assert.ok(result.record.warnings.includes('nutrition-rejected'))
    assert.equal(result.record.nameFr, 'Aliment français')
  }
})
test('metadata-only recovery never salvages unsafe identity or malformed schema', async () => {
  for (const row of [hfRow({ code: 'bad' }), hfRow({ product_name: 'unexpected' }), hfRow({ nutriments: [{ name: 'fat', '100g': -1 }] }), hfRow({ nutriments: 'malformed', data_quality_errors_tags: ['en:nutrition-invalid'] }), hfRow({ countries_tags: ['unsafe'], data_quality_errors_tags: ['en:nutrition-invalid'] })]) await assert.rejects(classifyHuggingFace(row, { retainUnusableNutrition: true }))
})
test('partial, zero and empty are distinct classifications, never implicit rejection', async () => {
  assert.equal((await classifyHuggingFace(hfRow())).status, 'complete')
  assert.equal((await classifyHuggingFace(hfRow({ nutriments: [{ name: 'fat', '100g': 0 }] }))).status, 'partial')
  assert.equal((await classifyHuggingFace(hfRow({ nutriments: null }))).status, 'unusable')
})
test('names may use language-specific, main or generic fallback without inventing French', async () => {
  for (const names of [[{ lang: 'en', text: 'English' }], [{ lang: 'main', text: 'Main' }], []]) {
    const result = await classifyHuggingFace(hfRow({ product_name: names, generic_name: [{ lang: 'en', text: 'Generic' }] }))
    assert.equal(result.record.nameFr, '')
    assert.ok(result.record.name)
  }
})
test('contradictory supplied portion quantities are rejected rather than choosing one', async () => {
  const row = hfRow({ serving_size: '25 ml', serving_quantity: '250.0' })
  assert.throws(()=>projectHuggingFace(row),{code:'hf-contradictory-serving'})
  const recovered=await classifyHuggingFace(row,{retainUnusableNutrition:true})
  assert.equal(recovered.originalError,'hf-contradictory-serving')
  assert.deepEqual(recovered.record.nutrients,{kcal:null,protein:null,carbs:null,fat:null})
})
test('float32-sized rounding difference is tolerated but units and types are not invented', () => {
  assert.doesNotThrow(()=>projectHuggingFace(hfRow({serving_size:'Portion (14 g)',serving_quantity:'14.000000000000002'})))
  for(const row of [hfRow({serving_quantity: 'one'}),hfRow({nutriments:[{name:'fat','100g':'1'}]}),hfRow({nutriments:[{name:'fat','100g':1,unit:{bad:1}}]})]) assert.throws(()=>projectHuggingFace(row))
})
test('missing standardized reference metadata never implies a solid food by suffix alone', async () => {
  const row=hfRow({nutrition_data_per:null,product_quantity_unit:null})
  const result=await classifyHuggingFace(row)
  assert.equal(result.status,'unusable'); assert.equal(result.record.reference,null)
  assert.ok(result.record.warnings.includes('reference-required'))
  assert.deepEqual(result.record.nutrients,{kcal:null,protein:null,carbs:null,fat:null})
})
