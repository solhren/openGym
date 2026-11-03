// Prototype projection, deliberately outside the application runtime. All units,
// nutrients, portions and missing-value semantics come from the existing engine.
import { normalizeProduct, inspectExternal, CatalogError } from '../../frontend/src/lib/nutrition/catalog/normalize.js'
import { nutrientsForQuantity } from '../../frontend/src/lib/nutrition/calculate.js'

const fail = (condition, code) => { if (!condition) throw new CatalogError(code) }
const clean = (value, max) => {
  if (value == null) return ''
  fail(typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value), 'invalid-text')
  return value.trim()
}

/** Rows are search descriptors, never persistence v1 records. Retain only four
 * macros, safe portions and provenance metadata; no images, editor IDs or secrets.
 * Unknown TSV reference must stay unknown even when standardized suffixes exist.
 */
export async function normalizeRecord(raw, { ambiguousReference = false } = {}) {
  inspectExternal(raw)
  const exportMetadata = raw._prototype_hf ?? raw._prototype_tsv
  fail(!(raw._prototype_hf && raw._prototype_tsv), 'invalid-export-metadata')
  if (exportMetadata != null) fail(typeof exportMetadata === 'object' && !Array.isArray(exportMetadata) && Object.keys(exportMetadata).every(k => ['qualifiersUnavailable', 'qualityWarning', 'nutritionRejected', 'ambiguousReference'].includes(k)) && exportMetadata.qualifiersUnavailable === true && typeof exportMetadata.qualityWarning === 'boolean' && ['nutritionRejected', 'ambiguousReference'].every(k => !Object.hasOwn(exportMetadata, k) || exportMetadata[k] === true), 'hf-invalid-projection-metadata')
  ambiguousReference ||= exportMetadata?.ambiguousReference === true
  // Lost TSV reference is not permission to let the legacy default infer 100 g.
  // Keep identity, discard ambiguous nutrition before invoking the engine.
  const safeRaw = raw._prototype_tsv && (ambiguousReference || exportMetadata?.nutritionRejected)
    ? { ...raw, nutriments:{}, nutrition_data_per:null, product_quantity_unit:null, serving_size:null, serving_quantity:null, serving_quantity_unit:null } : raw
  const product = await normalizeProduct(safeRaw, { language: 'fr' })
  const countries = raw.countries_tags ?? []
  fail(Array.isArray(countries) && countries.length <= 100 && countries.every(v => typeof v === 'string' && /^[a-z]{2}:[a-z0-9-]{1,60}$/.test(v)), 'invalid-countries')
  const modifiedAt = raw.last_modified_t ?? null
  fail(modifiedAt === null || (Number.isSafeInteger(modifiedAt) && modifiedAt >= 0 && modifiedAt <= 1e12), 'invalid-modified-time')
  const food = ambiguousReference ? null : product.food
  const reference = ambiguousReference ? null : product.reference
  const values = food ? nutrientsForQuantity(food, { amount: 100, unit: food.reference.unit }) : {}
  const nutrients = Object.fromEntries(['kcal', 'protein', 'carbs', 'fat'].map(k => [k, values[k] ?? null]))
  if (exportMetadata?.nutritionRejected) fail(reference === null && Object.values(nutrients).every(v => v === null), 'hf-invalid-recovery-metadata')
  fail(Object.entries(nutrients).every(([k, v]) => v === null || v <= (k === 'kcal' ? 2000 : 100)), 'invalid-nutrients')
  return { code: product.code, name: clean(raw.product_name || raw.generic_name || product.name, 300), nameFr: clean(raw.product_name_fr, 300), brand: product.brand,
    countries: [...new Set(countries)].sort(), reference: reference ? { amount: 100, unit: reference.unit } : null,
    nutrients, portions: food?.portions ?? [], warnings: [...new Set([...product.warnings, ...(ambiguousReference ? ['reference-required'] : []), ...(exportMetadata ? ['export-qualifiers-unavailable'] : []), ...(exportMetadata?.qualityWarning ? ['source-quality-warning'] : []), ...(exportMetadata?.nutritionRejected ? ['nutrition-rejected'] : [])])].sort(), modifiedAt }
}

/** CSV export is TSV. Column names are allowlisted; nutrition_data_per/package
 * units are indispensable. Absent unit metadata is not an implicit 100 g basis.
 */
export function projectTsv(row) {
  fail(row && typeof row === 'object' && !Array.isArray(row) && [Object.prototype, null].includes(Object.getPrototypeOf(row)) && !Object.getOwnPropertySymbols(row).length, 'invalid-tsv-row')
  const descriptors = Object.getOwnPropertyDescriptors(row)
  fail(Object.entries(descriptors).every(([k,d]) => !['__proto__','prototype','constructor'].includes(k) && Object.hasOwn(d,'value') && d.enumerable && typeof d.value === 'string' && d.value.length <= 65536), 'invalid-tsv-row')
  const fields = ['code', 'product_name', 'product_name_fr', 'product_name_en', 'generic_name', 'brands', 'nutrition_data_per', 'serving_size', 'serving_quantity', 'serving_quantity_unit', 'product_quantity_unit']
  const raw = Object.fromEntries(fields.filter(k => row[k] !== undefined && row[k] !== '').map(k => [k, row[k]]))
  // 2026 exporter projects brands_tags and localized brands_en/fr, not always brands.
  if (!raw.brands) raw.brands = row.brands_fr || row.brands_en || row.brands_tags || ''
  const tags = value => { const result = value ? value.split(',').map(s=>s.trim()) : []; fail(result.length<=100 && result.every(s=>s.length<=300 && !/[\u0000-\u001f\u007f]/.test(s)), 'invalid-quality-tags'); return result }
  raw.countries_tags = tags(row.countries_tags)
  if (row.last_modified_t) {
    fail(/^\d{1,13}$/.test(row.last_modified_t), 'invalid-modified-time')
    raw.last_modified_t = Number(row.last_modified_t)
  }
  raw.nutriments = Object.fromEntries(['energy-kcal', 'energy-kj', 'energy', 'proteins', 'carbohydrates', 'fat', 'fiber', 'sugars', 'saturated-fat', 'sodium'].flatMap(k => ['_100g', '_serving', '_modifier'].map(s => [k + s, row[k + s]])).filter(([, v]) => v !== undefined && v !== ''))
  // Package mass/volume and serving text do not establish the nutrition basis.
  // In the current exporter, _100g columns also contain aggregated 100ml values.
  fail(raw.nutrition_data_per == null || ['100g','100ml','serving'].includes(raw.nutrition_data_per), 'invalid-nutrition-reference')
  const ambiguousReference = !['100g','100ml','serving'].includes(raw.nutrition_data_per)
  const errors = tags(row.data_quality_errors_tags), warnings = tags(row.data_quality_warnings_tags)
  fail(row.no_nutrition_data == null || ['', '0', '1', 'on', 'off'].includes(row.no_nutrition_data), 'invalid-no-nutrition-data')
  const nutritionRejected = errors.some(tag=>/^en:(?:nutrition-|energy-)/.test(tag)) || ['1','on'].includes(row.no_nutrition_data)
  raw._prototype_tsv = { qualifiersUnavailable:true, qualityWarning:errors.length>0 || warnings.length>0,
    ...(ambiguousReference ? {ambiguousReference:true} : {}), ...(nutritionRejected ? {nutritionRejected:true, ambiguousReference:true} : {}) }
  return { raw, ambiguousReference:ambiguousReference || nutritionRejected }
}
