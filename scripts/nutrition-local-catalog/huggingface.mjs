// Bounded, offline adapter for the observed OFF Hugging Face viewer schema.
// No download and no alternate nutrient calculations. Raw contributor units are
// deliberately ignored: standardized 100g/serving fields have documented units.
import fs from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectExternal, CatalogError, barcode } from '../../frontend/src/lib/nutrition/catalog/normalize.js'
import { normalizeRecord } from './normalize.mjs'

const fail = (ok, code) => { if (!ok) throw new CatalogError(code) }
const own = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v)) && Reflect.ownKeys(v).every(k => {
  const d = Object.getOwnPropertyDescriptor(v, k)
  return typeof k === 'string' && keys.includes(k) && d.enumerable && Object.hasOwn(d, 'value')
})
const text = (v, max) => typeof v === 'string' && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v)
const flatArray = (v, max) => Array.isArray(v) && Object.getPrototypeOf(v) === Array.prototype && v.length <= max && Reflect.ownKeys(v).length === v.length + 1 && Reflect.ownKeys(v).every(k => {
  if (k === 'length') return true
  const d = Object.getOwnPropertyDescriptor(v, k)
  return typeof k === 'string' && /^(?:0|[1-9]\d*)$/.test(k) && Number(k) < v.length && d.enumerable && Object.hasOwn(d, 'value')
})
const nutrientKeys = ['name', 'value', '100g', 'serving', 'unit', 'prepared_value', 'prepared_100g', 'prepared_serving', 'prepared_unit']
const supported = new Set(['energy', 'energy-kcal', 'energy-kj', 'proteins', 'carbohydrates', 'fat', 'fiber', 'sugars', 'saturated-fat', 'sodium'])
const quality = /^en:(?:nutrition-|energy-)/

function validateServing(row) {
  const quantity = row.serving_quantity
  fail(row.serving_size == null || text(row.serving_size, 200), 'hf-invalid-serving-size')
  if (quantity == null || quantity === '') return
  fail((typeof quantity === 'number' || (typeof quantity === 'string' && /^\d+(?:\.\d+)?$/.test(quantity) && quantity.length <= 30)) && Number.isFinite(Number(quantity)) && Number(quantity) >= 0 && Number(quantity) <= 100000, 'hf-invalid-serving-quantity')
  // Cross-check the two supplied representations only, never guess a unit. The
  // actual portion and nutrient calculations remain those of normalizeProduct.
  const parsed = typeof row.serving_size === 'string' && /^(?:[^()]*\()?\s*(\d+(?:[.,]\d+)?)\s*(g|ml)\s*\)?$/i.exec(row.serving_size)
  if (parsed) {
    const amount = Number(parsed[1].replace(',', '.'))
    fail(Math.abs(amount-Number(quantity)) <= Math.max(1e-6, amount*1e-6), 'hf-contradictory-serving')
  }
}

function localized(values) {
  if (values == null) return Object.create(null)
  fail(Array.isArray(values) && values.length <= 100, 'hf-invalid-localized-name')
  const names = Object.create(null)
  for (const item of values) {
    fail(own(item, ['lang', 'text']) && text(item.lang, 20) && /^(?:main|[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)$/.test(item.lang) && text(item.text, 300), 'hf-invalid-localized-name')
    fail(!Object.hasOwn(names, item.lang) || names[item.lang] === item.text.trim(), 'hf-conflicting-language')
    names[item.lang] = item.text.trim()
  }
  return names
}

export function validateEnvelope(data) {
  fail(own(data, ['features', 'rows', 'num_rows_total', 'num_rows_per_page', 'partial']), 'hf-invalid-envelope')
  fail(data.partial === false && Number.isSafeInteger(data.num_rows_total) && data.num_rows_total >= 0 && data.num_rows_total <= 10000000 && Number.isInteger(data.num_rows_per_page) && data.num_rows_per_page > 0 && data.num_rows_per_page <= 100, 'hf-partial-or-invalid-page')
  fail(flatArray(data.rows, 100) && data.rows.length > 0 && data.rows.length <= data.num_rows_per_page && data.rows.length <= data.num_rows_total && flatArray(data.features, 512), 'hf-invalid-envelope')
  const features = new Map()
  for (const field of data.features) {
    inspectExternal(field)
    fail(text(field.name, 100) && !features.has(field.name), 'hf-invalid-features')
    features.set(field.name, field.type)
  }
  fail(features.get('code')?.dtype === 'string', 'hf-unsupported-schema')
  const names = features.get('product_name'), nutrients = features.get('nutriments')
  fail(names?._type === 'List' && names.feature?.lang?.dtype === 'string' && names.feature?.text?.dtype === 'string', 'hf-unsupported-schema')
  fail(nutrients?._type === 'List' && nutrients.feature?.name?.dtype === 'string' && nutrients.feature?.['100g']?.dtype === 'float32' && nutrients.feature?.serving?.dtype === 'float32', 'hf-unsupported-schema')
  // Known projection drops modifiers/source. Do not silently accept a new schema
  // that introduces qualifiers we would otherwise discard.
  fail(Object.keys(nutrients.feature).every(k => nutrientKeys.includes(k)), 'hf-unsupported-nutrient-schema')
  const indices = new Set()
  for (const item of data.rows) {
    // Filtered/search slices retain original row indices; their matching total
    // can be smaller. Never interpret this index as a position in the filter.
    fail(own(item, ['row_idx', 'row', 'truncated_cells']) && Number.isSafeInteger(item.row_idx) && item.row_idx >= 0 && item.row_idx < 10000000 && !indices.has(item.row_idx), 'hf-invalid-row-index')
    fail(flatArray(item.truncated_cells, 0) && item.row && typeof item.row === 'object' && !Array.isArray(item.row), 'hf-truncated-or-invalid-row')
    indices.add(item.row_idx)
  }
  return data
}

export function projectHuggingFace(row) {
  inspectExternal(row)
  barcode(row.code)
  validateServing(row)
  const names = localized(row.product_name), generic = localized(row.generic_name)
  fail(row.lang == null || text(row.lang, 20), 'hf-invalid-language')
  const name = names.main || names[row.lang] || names.fr || names.en || Object.values(names).find(Boolean)
  fail(name || Object.values(generic).find(Boolean), 'hf-missing-product-name')
  const raw = { code: row.code, product_name: name || Object.values(generic).find(Boolean), product_name_fr: names.fr || '', generic_name: generic.main || generic.fr || generic.en || '', brands: row.brands ?? '', countries_tags: row.countries_tags ?? [], last_modified_t: row.last_modified_t ?? null, nutriments: {} }
  for (const key of ['nutrition_data_per', 'product_quantity_unit', 'serving_size', 'serving_quantity']) if (row[key] != null) raw[key] = row[key]
  fail(row.no_nutrition_data == null || typeof row.no_nutrition_data === 'boolean', 'hf-invalid-no-nutrition-data')
  const errors = row.data_quality_errors_tags ?? [], warnings = row.data_quality_warnings_tags ?? []
  fail([errors, warnings].every(tags => Array.isArray(tags) && tags.length <= 100 && tags.every(v => text(v, 300))), 'hf-invalid-quality-tags')
  fail(row.nutriments == null || (Array.isArray(row.nutriments) && row.nutriments.length <= 256), 'hf-invalid-nutriments')
  const seen = new Set()
  for (const nutrient of row.nutriments ?? []) {
    fail(own(nutrient, nutrientKeys) && text(nutrient.name, 100) && !seen.has(nutrient.name), 'hf-invalid-or-duplicate-nutrient')
    fail(['unit', 'prepared_unit'].every(k => nutrient[k] == null || text(nutrient[k], 20)), 'hf-invalid-nutrient-unit')
    fail(['value', '100g', 'serving', 'prepared_value', 'prepared_100g', 'prepared_serving'].every(k => nutrient[k] == null || (typeof nutrient[k] === 'number' && Number.isFinite(nutrient[k]))), 'hf-invalid-nutrient-type')
    seen.add(nutrient.name)
    if (!supported.has(nutrient.name)) continue
    for (const [field, suffix] of [['100g', '_100g'], ['serving', '_serving']]) {
      const value = nutrient[field]
      // Never emit a null _100g key: the existing normalizer detects reference
      // availability by key presence; a serving-only record must stay serving-only.
      if (value == null) continue
      fail(typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100000, 'hf-invalid-standardized-nutrient')
      raw.nutriments[nutrient.name + suffix] = value
    }
  }
  if (row.no_nutrition_data === true) {
    fail(Object.keys(raw.nutriments).length === 0, 'hf-contradictory-no-nutrition-data')
  }
  // Validate structural types first: a quality tag must not hide malformed data
  // behind the optional metadata-only recovery branch.
  fail(!errors.some(tag => quality.test(tag)), 'hf-nutrition-quality-error')
  // Empty explicit reference can be represented by a v3-shaped empty table. No
  // nutrient is invented and normalizeProduct remains responsible for validation.
  if (!Object.keys(raw.nutriments).length && ['100g', '100ml'].includes(raw.nutrition_data_per)) {
    raw.nutrition = { aggregated_set: { per: raw.nutrition_data_per, preparation: 'as_sold', nutrients: {} } }
  }
  raw._prototype_hf = { qualifiersUnavailable: true, qualityWarning: warnings.some(tag => quality.test(tag)) }
  // This simplified export can lose reference metadata. A suffix alone does
  // not prove that the product is solid: preserve uncertainty instead of guesstimates.
  if (Object.keys(raw.nutriments).some(k => k.endsWith('_100g')) && !['100g', '100ml'].includes(raw.nutrition_data_per) && !['g', 'kg'].includes(raw.product_quantity_unit)) raw._prototype_hf.ambiguousReference = true
  return raw
}

export function convertEnvelope(data) {
  validateEnvelope(data)
  const products = [], rejected = []
  for (const item of data.rows) {
    try { products.push(projectHuggingFace(item.row)) }
    catch (error) {
      if (!(error instanceof CatalogError)) throw error
      const code = Object.getOwnPropertyDescriptor(item.row, 'code')?.value
      rejected.push({ rowIndex: item.row_idx, code: typeof code === 'string' && /^\d{8,14}$/.test(code) ? code : null, reason: error.code })
    }
  }
  return { products, rejected, rows: data.rows.length, totalRowsReported: data.num_rows_total, qualifiersUnavailable: true, precision: 'float32', source: 'https://huggingface.co/datasets/openfoodfacts/product-database', license: 'ODbL-1.0', contentLicense: 'DbCL-1.0', attribution: 'Open Food Facts contributors' }
}

/** Explicit metadata-only recovery. Never guess which of contradictory macros is
 * correct. Unsafe identities/structures still fail; the original rejection stays
 * in the audit. This descriptor is not an importable user Food with fake zeros.
 */
export async function classifyHuggingFace(row, { retainUnusableNutrition = false } = {}) {
  try {
    const raw = projectHuggingFace(row), record = await normalizeRecord(raw)
    const known = Object.values(record.nutrients).filter(v => v !== null).length
    return { raw, record, status: known === 4 ? 'complete' : known ? 'partial' : 'unusable', originalError: null }
  } catch (error) {
    if (!(error instanceof CatalogError) || !retainUnusableNutrition || !['hf-nutrition-quality-error', 'invalid-nutrients', 'hf-contradictory-serving'].includes(error.code)) throw error
    inspectExternal(row)
    const identity = { ...row, nutriments: null, no_nutrition_data: true, nutrition_data_per: null, product_quantity_unit: null, serving_size: null, serving_quantity: null, data_quality_errors_tags: [] }
    const raw = projectHuggingFace(identity)
    raw._prototype_hf.nutritionRejected = true
    const record = await normalizeRecord(raw)
    return { raw, record, status: 'unusable', originalError: error.code }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const [input, output, mode] = process.argv.slice(2)
    fail(input && output && (process.argv.length === 4 || (process.argv.length === 5 && mode === '--retain-unusable-nutrition')), 'hf-invalid-arguments')
    fail(fs.statSync(input).isFile() && fs.statSync(input).size <= 8*1024*1024, 'hf-envelope-too-large')
    const bytes = fs.readFileSync(input), hash = createHash('sha256').update(bytes).digest('hex')
    let data
    try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { throw new CatalogError('hf-invalid-json') }
    const converted = convertEnvelope(data)
    if (mode) {
      converted.products = []; converted.rejected = []; converted.recoveredNutrition = []
      for (const item of data.rows) {
        try {
          const result = await classifyHuggingFace(item.row, { retainUnusableNutrition: true })
          converted.products.push(result.raw)
          if (result.originalError) converted.recoveredNutrition.push({ rowIndex: item.row_idx, code: result.record.code, reason: result.originalError })
        } catch (error) {
          if (!(error instanceof CatalogError)) throw error
          converted.rejected.push({ rowIndex: item.row_idx, reason: error.code })
        }
      }
    }
    fail(converted.products.length > 0, 'hf-no-projectable-products')
    // Only a complete successful conversion creates the exclusive output file.
    const wire = converted.products.map(p => JSON.stringify(p)+'\n').join('')
    const artifacts = fs.realpathSync(fileURLToPath(new URL('./artifacts', import.meta.url)))
    const outputDirectory = fs.realpathSync(path.dirname(path.resolve(output)))
    fail(outputDirectory === artifacts || outputDirectory.startsWith(artifacts + path.sep), 'hf-output-outside-artifacts')
    const temporary = path.join(outputDirectory, `.hf-${randomUUID()}.tmp`)
    try {
      fs.writeFileSync(temporary, wire, { flag: 'wx', mode: 0o600 })
      const fd = fs.openSync(temporary, 'r')
      try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      // Atomic publication without overwriting an existing conversion/source.
      fs.linkSync(temporary, output)
      fs.unlinkSync(temporary)
      const dir = fs.openSync(outputDirectory, 'r')
      try { fs.fsyncSync(dir) } finally { fs.closeSync(dir) }
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary) }
    const { products, ...report } = converted
    console.log(JSON.stringify({ ...report, projectedProducts: products.length, originalSha256: hash, jsonlSha256: createHash('sha256').update(wire).digest('hex'), sourceVersion: `hf-viewer-v1-${hash}`, note: 'Projection only: run the existing importer and inspect its invalid-product counters.' }, null, 2))
  } catch (error) { console.error(JSON.stringify({ error: error.code || 'hf-conversion-failed' })); process.exitCode = 1 }
}
