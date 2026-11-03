import { validateFood } from '../validate.js'
import { contentHash } from '../persistence-contract.js'

export class CatalogError extends Error {
  constructor(code, details = {}) { super(code); this.name = 'CatalogError'; this.code = code; Object.assign(this, details) }
}
export const fail = (condition, code) => { if (!condition) throw new CatalogError(code) }
/** Bounded descriptor walk: do not invoke getters/toJSON, accept prototypes or dangerous keys. */
export function inspectExternal(value) {
  let nodes = 0
  const ancestors = new WeakSet()
  const visit = (v, depth) => {
    fail(++nodes <= 20000 && depth <= 12, 'invalid-response')
    if (v === null || typeof v === 'boolean') return
    if (typeof v === 'string') { fail(v.length <= 10000, 'invalid-response'); return }
    if (typeof v === 'number') { fail(Number.isFinite(v), 'invalid-response'); return }
    fail(typeof v === 'object', 'invalid-response')
    fail(Object.getPrototypeOf(v) === (Array.isArray(v) ? Array.prototype : Object.prototype) || Object.getPrototypeOf(v) === null, 'invalid-response')
    fail(!ancestors.has(v), 'invalid-response'); ancestors.add(v)
    if (Array.isArray(v)) fail(v.length <= 1000, 'invalid-response')
    for (const [key, d] of Object.entries(Object.getOwnPropertyDescriptors(v))) {
      if (Array.isArray(v) && key === 'length') continue
      fail(!['__proto__', 'constructor', 'prototype'].includes(key) && Object.hasOwn(d, 'value') && d.enumerable, 'invalid-response')
      visit(d.value, depth + 1)
    }
    fail(Object.getOwnPropertySymbols(v).length === 0, 'invalid-response'); ancestors.delete(v)
  }
  visit(value, 0)
}
export function barcode(value) {
  fail(typeof value === 'string' && /^\d{8}$|^\d{12,14}$/.test(value), 'invalid-barcode')
  return value
}
export function normalizedBarcode(value) {
  barcode(value)
  const digits = value.replace(/^0+/, '')
  return digits.padStart(digits.length <= 8 ? 8 : digits.length <= 13 ? 13 : 14, '0')
}
const number = v => {
  if (v == null || v === '') return null
  if (typeof v === 'string' && !/^\d+(?:\.\d+)?$/.test(v)) throw new CatalogError('invalid-nutrients')
  fail(['number', 'string'].includes(typeof v), 'invalid-nutrients')
  const n = Number(v); fail(Number.isFinite(n) && n >= 0 && n <= 100000, 'invalid-nutrients'); return n
}
const text = (value, max, required = false) => {
  if (value == null && !required) return ''
  fail(typeof value === 'string' && value.length <= max, 'invalid-response')
  const result = value.trim(); fail(!required || result.length > 0, 'invalid-response'); return result
}
export function imageUrl(value) {
  if (typeof value !== 'string' || value.length > 1000) return null
  try { const u = new URL(value); return u.protocol === 'https:' && u.hostname === 'images.openfoodfacts.org' && !u.username && !u.password && !u.port && !u.search && !u.hash && /^\/images\/products\/[\d/]+\/[\w.\-]+\.(?:100|200|400)\.(?:jpg|jpeg|png)$/.test(u.pathname) ? u.href : null } catch { return null }
}
const keys = { protein: 'proteins', carbs: 'carbohydrates', fat: 'fat', fiber: 'fiber', sugar: 'sugars', saturatedFat: 'saturated-fat', sodium: 'sodium' }
function serving(p) {
  if (p.serving_quantity != null && ['g', 'ml'].includes(p.serving_quantity_unit)) {
    const amount = number(p.serving_quantity); return amount > 0 ? { amount, unit: p.serving_quantity_unit } : null
  }
  const match = typeof p.serving_size === 'string' && /^(?:[^()]*\()?\s*(\d+(?:[.,]\d+)?)\s*(g|ml)\s*\)?$/i.exec(p.serving_size)
  return match && Number(match[1].replace(',', '.')) > 0 ? { amount: Number(match[1].replace(',', '.')), unit: match[2].toLowerCase() } : null
}
/** Read as-sold explicit v3 references; legacy standardized suffixes never use *_value units.
 * Volume packages with an ambiguous legacy base require an explicit user choice. */
export async function normalizeProduct(raw, { language = 'fr', expectedCode, legacyUnit, requireExplicitReference = false, requireAggregatedReference = false, origin = 'https://world.openfoodfacts.org' } = {}) {
  fail(['https://world.openfoodfacts.org', 'https://world.openfoodfacts.net'].includes(origin), 'invalid-response')
  inspectExternal(raw); fail(raw && !Array.isArray(raw), 'invalid-response')
  const code = normalizedBarcode(text(raw.code, 14, true))
  if (expectedCode) fail(code === normalizedBarcode(expectedCode), 'barcode-mismatch')
  const name = text(raw[`product_name_${language}`] || raw.product_name || raw.generic_name, 300, true)
  const brand = text(raw.brands, 300), portion = serving(raw), warnings = []
  const catalogue = raw.opengym_catalog
  if (catalogue != null) {
    fail(catalogue && typeof catalogue === 'object' && !Array.isArray(catalogue) && Object.keys(catalogue).sort().join(',') === 'version,warnings' && typeof catalogue.version === 'string' && /^[a-f0-9]{64}$/.test(catalogue.version) && Array.isArray(catalogue.warnings) && catalogue.warnings.length <= 7 && catalogue.warnings.every(w => ['estimated-values','reference-required','serving-only','missing-values','export-qualifiers-unavailable','source-quality-warning','nutrition-rejected'].includes(w)), 'invalid-response')
    warnings.push(...catalogue.warnings)
  }
  let reference, read
  // A search export's `_100g` suffix is not proof of mass rather than volume.
  // Selection/cache callers demand an explicit as-sold reference. Existing
  // archive/user Food contracts remain unchanged.
  if (requireExplicitReference) {
    fail(raw.data_quality_errors_tags == null || (Array.isArray(raw.data_quality_errors_tags) && raw.data_quality_errors_tags.every(tag=>typeof tag==='string')), 'invalid-response')
    fail(!Array.isArray(raw.data_quality_errors_tags) || !raw.data_quality_errors_tags.some(tag => typeof tag === 'string' && /^en:(nutrition-|energy-)/.test(tag)), 'invalid-nutrients')
    const aggregate = raw.nutrition?.aggregated_set
    const explicit = aggregate ? aggregate.preparation === 'as_sold' && ['100g','100ml'].includes(aggregate.per)
      : !requireAggregatedReference && ['100g','100ml','serving'].includes(raw.nutrition_data_per)
    if (!explicit || ['1','on',1,true].includes(raw.no_nutrition_data)) {
      raw = { ...raw, nutrition: null, nutriments: {}, serving_size: '', serving_quantity: null, serving_quantity_unit: null }
    }
  }
  const set = raw.nutrition?.aggregated_set
  if (set && set.preparation === 'as_sold' && ['100g', '100ml'].includes(set.per)) {
    reference = { amount: 100, unit: set.per === '100ml' ? 'ml' : 'g' }
    read = key => {
      const n = set.nutrients?.[key]
      if (n == null) return null
      fail(typeof n === 'object' && !Array.isArray(n), 'invalid-nutrients')
      if (requireExplicitReference && n.unit != null) fail(n.unit === (key === 'energy-kcal' ? 'kcal' : ['energy-kj','energy'].includes(key) ? 'kJ' : 'g'), 'invalid-nutrients')
      if (n.source === 'estimate' || n.modifier != null) { warnings.push('estimated-values'); return null }
      return number(n.value)
    }
  } else {
    const nutrients = raw.nutriments ?? {}, per = raw.nutrition_data_per
    fail(typeof nutrients === 'object' && !Array.isArray(nutrients), 'invalid-nutrients')
    fail(per == null || ['100g', '100ml', 'serving'].includes(per), 'invalid-nutrients')
    const standardRead = suffix => key => {
      if (nutrients[`${key}_modifier`]) { warnings.push('estimated-values'); return null }
      return number(nutrients[`${key}${suffix}`])
    }
    const has100 = Object.keys(nutrients).some(k => k.endsWith('_100g'))
    if (has100) {
      const volumePackage = ['ml', 'cl', 'dl', 'l'].includes(raw.product_quantity_unit)
      if (per === '100ml' || legacyUnit === 'ml') reference = { amount: 100, unit: 'ml' }
      else if (volumePackage && !legacyUnit) warnings.push('reference-required')
      else reference = { amount: 100, unit: 'g' }
      read = standardRead('_100g')
    } else if (portion) { reference = portion; read = standardRead('_serving'); warnings.push('serving-only') }
    else { warnings.push('reference-required'); read = () => null }
  }
  const values = Object.fromEntries(Object.entries(keys).map(([key, off]) => [key, read(off)]))
  const kcal = read('energy-kcal'), kj = read('energy-kj') ?? read('energy')
  fail(kcal == null || kj == null || Math.abs(kcal - kj / 4.184) <= Math.max(5, kcal * .1), 'inconsistent-energy')
  values.kcal = kcal ?? (kj == null ? null : kj / 4.184)
  if (warnings.includes('nutrition-rejected')) fail(!reference && Object.values(values).every(v => v == null), 'invalid-nutrients')
  if (Object.values(values).some(v => v == null)) warnings.push('missing-values')
  fail(values.kcal == null || !reference || values.kcal / reference.amount <= 20, 'invalid-nutrients')
  const source = { kind: 'open-food-facts', externalId: code, url: `${origin}/product/${code}`,
    license: { id: 'ODbL-1.0', url: 'https://opendatacommons.org/licenses/odbl/1-0/', attribution: 'Open Food Facts contributors' },
    contentLicense: 'DbCL-1.0', ...(origin.endsWith('.net') ? { environment: 'staging' } : {}) }
  if (catalogue?.warnings.length) source.catalogueWarnings = [...new Set(catalogue.warnings)]
  let food = null
  if (reference && Object.values(values).some(v => v != null)) {
    const value = { schemaVersion: 1, kind: 'food', name, brand, reference, nutrients: values,
      portions: portion && portion.unit === reference.unit ? [{ id: 'off-serving', label: text(raw.serving_size, 200) || `${portion.amount} ${portion.unit}`, ...portion }] : [], source }
    const id = `off-${code}-${await contentHash(value)}`
    food = { ...value, id }; fail(validateFood(food).length === 0, 'invalid-nutrients')
  }
  return { code, name, brand, food, warnings: [...new Set(warnings)], reference: reference ?? null,
    serving: text(raw.serving_size, 200), image: imageUrl(raw.image_front_small_url), sourceUrl: source.url }
}
