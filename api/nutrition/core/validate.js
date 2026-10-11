import { NUTRITION_SCHEMA_VERSION, NUTRIENTS, MEALS, QUANTITY_UNITS, MASS_UNITS, VOLUME_UNITS } from './contracts.js'

const object = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const text = v => typeof v === 'string' && v.trim().length > 0
const positive = v => typeof v === 'number' && Number.isFinite(v) && v > 0
const nonnegative = v => typeof v === 'number' && Number.isFinite(v) && v >= 0
const has = (o, k) => Object.hasOwn(o, k)
const issue = (out, path, code) => out.push({ path, code })
const child = (path, key) => path ? `${path}.${key}` : key
const url = v => {
  try { return typeof v === 'string' && ['https:', 'http:'].includes(new URL(v).protocol) } catch { return false }
}

/** Inspect data descriptors, never getters or toJSON hooks. Shared references are valid;
 * only a reference back to an ancestor is a cycle. Unknown metadata follows the same contract. */
export function validateJsonValue(value, path = '$') {
  const out = [], ancestors = new WeakSet()
  const visit = (v, p) => {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) issue(out, p, 'json_nonfinite_number')
      return
    }
    if (typeof v !== 'object') { issue(out, p, 'json_unsupported_value'); return }
    const array = Array.isArray(v), prototype = Object.getPrototypeOf(v)
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      issue(out, p, 'json_plain_object_required')
      return
    }
    if (ancestors.has(v)) { issue(out, p, 'json_circular_reference'); return }
    ancestors.add(v)
    const descriptors = Object.getOwnPropertyDescriptors(v)
    for (const key in v) {
      if (!has(v, key)) issue(out, child(p, key), 'json_inherited_property')
    }
    if (array) {
      for (let i = 0; i < v.length; i++) {
        if (!has(descriptors, i)) issue(out, `${p}[${i}]`, 'json_sparse_array')
      }
    }
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key === 'symbol') { issue(out, p, 'json_symbol_key'); continue }
      if (array && key === 'length') continue
      const index = Number(key)
      if (array && (!Number.isInteger(index) || index < 0 || index >= v.length || String(index) !== key)) {
        issue(out, child(p, key), 'json_array_property')
        continue
      }
      const propertyPath = array ? `${p}[${key}]` : child(p, key)
      const descriptor = descriptors[key]
      if (!has(descriptor, 'value')) { issue(out, propertyPath, 'json_data_property_required'); continue }
      if (!descriptor.enumerable) { issue(out, propertyPath, 'json_enumerable_property_required'); continue }
      visit(descriptor.value, propertyPath)
    }
    ancestors.delete(v)
  }
  try { visit(value, path) } catch {
    // Uninspectable objects or excessive nesting must still produce a domain error.
    issue(out, path, 'json_inspection_failed')
  }
  return out
}

export function isNutritionDate(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const date = new Date(`${v}T00:00:00Z`)
  return Number.isFinite(+date) && date.toISOString().slice(0, 10) === v
}

function record(v, out, path) {
  const jsonIssues = validateJsonValue(v, path || '$')
  out.push(...jsonIssues)
  // Finite-number failures are safe to inspect further, retaining the existing field-level
  // numeric errors as well. Other failures may hide accessors or inherited data: stop first.
  if (jsonIssues.some(i => i.code !== 'json_nonfinite_number')) return false
  if (!object(v)) { issue(out, path || '$', 'object_required'); return false }
  return true
}

function header(v, out, path, named = true) {
  if (!record(v, out, path)) return false
  if (v.schemaVersion !== NUTRITION_SCHEMA_VERSION) issue(out, child(path, 'schemaVersion'), 'unsupported_version')
  if (!text(v.id)) issue(out, child(path, 'id'), 'text_required')
  if (named && !text(v.name)) issue(out, child(path, 'name'), 'text_required')
  return true
}

export function validateNutrients(v, path = 'nutrients') {
  const out = []
  if (!record(v, out, path)) return out
  for (const key of NUTRIENTS) {
    if (!has(v, key) && key in v) { issue(out, child(path, key), 'json_inherited_property'); continue }
    // Absence and null both mean unknown; zero is an actual declared value.
    if (v[key] != null && !nonnegative(v[key])) issue(out, child(path, key), 'nonnegative_number_required')
  }
  for (const [part, total] of [['sugar', 'carbs'], ['saturatedFat', 'fat']]) {
    if (has(v, part) && has(v, total) && nonnegative(v[part]) && nonnegative(v[total]) && v[part] > v[total]) {
      issue(out, child(path, part), 'exceeds_parent_nutrient')
    }
  }
  return out
}

export function validateQuantity(v, path = 'quantity') {
  const out = []
  if (!record(v, out, path)) return out
  if (!positive(v.amount)) issue(out, child(path, 'amount'), 'positive_number_required')
  if (!QUANTITY_UNITS.includes(v.unit)) issue(out, child(path, 'unit'), 'unknown_unit')
  if (v.unit === 'portion' && !text(v.portionId)) issue(out, child(path, 'portionId'), 'text_required')
  if (v.unit !== 'portion' && has(v, 'portionId')) issue(out, child(path, 'portionId'), 'unexpected_portion_id')
  return out
}

function reference(v, out, path, units) {
  if (!record(v, out, path)) return
  if (!positive(v.amount)) issue(out, child(path, 'amount'), 'positive_number_required')
  if (!units.includes(v.unit)) issue(out, child(path, 'unit'), 'unknown_reference_unit')
}

function uniqueItems(items, out, path, visit) {
  if (!Array.isArray(items)) { issue(out, path, 'array_required'); return }
  const ids = new Set()
  Array.from(items).forEach((item, i) => {
    const p = `${path}[${i}]`
    if (!record(item, out, p)) return
    if (!text(item.id)) issue(out, child(p, 'id'), 'text_required')
    else if (ids.has(item.id)) issue(out, child(p, 'id'), 'duplicate_id')
    ids.add(item.id)
    visit(item, p)
  })
}

function foodSource(source, out, path) {
  if (!record(source, out, path)) return
  if (!['custom', 'open-food-facts'].includes(source.kind)) issue(out, child(path, 'kind'), 'unknown_source')
  const external = source.kind === 'open-food-facts'
  if ((external || source.externalId != null) && !text(source.externalId)) issue(out, child(path, 'externalId'), 'text_required')
  if ((external || source.url != null) && !url(source.url)) issue(out, child(path, 'url'), 'http_url_required')
  if ((external || source.license != null) && record(source.license, out, child(path, 'license'))) {
    for (const key of ['id', 'attribution']) if (!text(source.license[key])) issue(out, child(child(path, 'license'), key), 'text_required')
    if (!url(source.license.url)) issue(out, child(child(path, 'license'), 'url'), 'http_url_required')
  }
}

export function validateFood(v, path = 'food') {
  const out = []
  if (!header(v, out, path)) return out
  if (v.kind !== 'food') issue(out, child(path, 'kind'), 'food_required')
  if (v.brand != null && typeof v.brand !== 'string') issue(out, child(path, 'brand'), 'string_required')
  reference(v.reference, out, child(path, 'reference'), ['g', 'ml'])
  out.push(...validateNutrients(v.nutrients, child(path, 'nutrients')))
  if (v.densityGPerMl != null && !positive(v.densityGPerMl)) issue(out, child(path, 'densityGPerMl'), 'positive_number_required')
  uniqueItems(v.portions, out, child(path, 'portions'), (p, ppath) => {
    if (!text(p.label)) issue(out, child(ppath, 'label'), 'text_required')
    reference(p, out, ppath, ['g', 'ml'])
  })
  if (object(v.nutrients)) {
    if (v.reference?.unit === 'g' && positive(v.reference.amount)) {
      for (const key of NUTRIENTS.filter(k => k !== 'kcal')) {
        if (nonnegative(v.nutrients[key]) && v.nutrients[key] > v.reference.amount) issue(out, child(child(path, 'nutrients'), key), 'exceeds_reference_mass')
      }
    }
  }
  foodSource(v.source, out, child(path, 'source'))
  if (v.defaultQuantity != null) out.push(...validateConsumption(v, v.defaultQuantity, child(path, 'defaultQuantity')))
  return out
}

function recipeYield(v, out, path) {
  if (!record(v, out, path)) return
  if (!positive(v.servings)) issue(out, child(path, 'servings'), 'positive_number_required')
  for (const key of ['grams', 'ml']) if (v[key] != null && !positive(v[key])) issue(out, child(path, key), 'positive_number_required')
}

export function validateRecipe(v, path = 'recipe') {
  const out = []
  if (!header(v, out, path)) return out
  recipeYield(v.yield, out, child(path, 'yield'))
  if (Array.isArray(v.ingredients) && !v.ingredients.length) issue(out, child(path, 'ingredients'), 'ingredients_required')
  uniqueItems(v.ingredients, out, child(path, 'ingredients'), (item, p) => {
    out.push(...validateFood(item.food, child(p, 'food')))
    out.push(...validateConsumption(item.food, item.quantity, child(p, 'quantity')))
  })
  return out
}

export function validateSnapshot(v, path = 'snapshot') {
  const out = []
  if (!header(v, out, path)) return out
  if (v.kind === 'food') return validateFood(v, path)
  if (v.kind !== 'recipe') issue(out, child(path, 'kind'), 'unknown_snapshot_kind')
  reference(v.reference, out, child(path, 'reference'), ['serving'])
  recipeYield(v.yield, out, child(path, 'yield'))
  if (positive(v.reference?.amount) && positive(v.yield?.servings) && v.reference.amount !== v.yield.servings) {
    issue(out, child(path, 'reference.amount'), 'yield_mismatch')
  }
  out.push(...validateNutrients(v.nutrients, child(path, 'nutrients')))
  if (Array.isArray(v.ingredientSources) && !v.ingredientSources.length) issue(out, child(path, 'ingredientSources'), 'sources_required')
  uniqueItems(v.ingredientSources, out, child(path, 'ingredientSources'), (item, p) => {
    for (const key of ['foodId', 'name']) if (!text(item[key])) issue(out, child(p, key), 'text_required')
    foodSource(item.source, out, child(p, 'source'))
  })
  return out
}

// Context validation is separate from the quantity shape: a valid unit may still need density
// or a recipe's measured cooked yield before its amount can be calculated.
export function validateConsumption(snapshot, quantity, path = 'quantity') {
  const out = validateQuantity(quantity, path)
  if (out.length) return out
  if (!record(snapshot, out, child(path, 'snapshot'))) return out
  if (!['food', 'recipe'].includes(snapshot.kind)) { issue(out, path, 'unknown_snapshot_kind'); return out }
  if (snapshot.kind === 'recipe' && quantity.unit === 'portion') { issue(out, path, 'recipe_serving_required'); return out }
  let unit = quantity.unit
  if (unit === 'portion') {
    const portion = Array.isArray(snapshot.portions) ? snapshot.portions.find(p => p?.id === quantity.portionId) : null
    if (!portion) { issue(out, child(path, 'portionId'), 'unknown_portion'); return out }
    unit = portion.unit
  }
  if (snapshot.kind === 'recipe') {
    if (has(MASS_UNITS, unit) && !positive(snapshot.yield?.grams)) issue(out, path, 'recipe_mass_required')
    if (has(VOLUME_UNITS, unit) && !positive(snapshot.yield?.ml)) issue(out, path, 'recipe_volume_required')
    return out
  }
  if (unit === 'serving') issue(out, child(path, 'unit'), 'food_portion_required')
  else if ((snapshot.reference?.unit === 'g' && has(VOLUME_UNITS, unit)) || (snapshot.reference?.unit === 'ml' && has(MASS_UNITS, unit))) {
    if (!positive(snapshot.densityGPerMl)) issue(out, path, 'density_required')
  }
  return out
}

export function validateFoodEntry(v, path = 'entry') {
  const out = []
  if (!header(v, out, path, false)) return out
  if (!isNutritionDate(v.d)) issue(out, child(path, 'd'), 'invalid_date')
  if (!MEALS.includes(v.meal)) issue(out, child(path, 'meal'), 'unknown_meal')
  out.push(...validateSnapshot(v.snapshot, child(path, 'snapshot')))
  out.push(...validateConsumption(v.snapshot, v.quantity, child(path, 'quantity')))
  for (const key of ['mealId', 'copiedFromEntryId']) if (v[key] != null && !text(v[key])) issue(out, child(path, key), 'text_required')
  if (v.note != null && typeof v.note !== 'string') issue(out, child(path, 'note'), 'string_required')
  if (v.consumedAt != null && (typeof v.consumedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,3})?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/.test(v.consumedAt) || !isNutritionDate(v.consumedAt.slice(0, 10)) || !Number.isFinite(Date.parse(v.consumedAt)))) {
    issue(out, child(path, 'consumedAt'), 'invalid_timestamp')
  }
  if (v.timeZone != null) {
    try {
      if (!text(v.timeZone)) throw new Error('invalid zone')
      new Intl.DateTimeFormat('en', { timeZone: v.timeZone })
    } catch { issue(out, child(path, 'timeZone'), 'invalid_time_zone') }
  }
  return out
}

export function validateMealTemplate(v, path = 'template') {
  const out = []
  if (!header(v, out, path)) return out
  if (Array.isArray(v.items) && !v.items.length) issue(out, child(path, 'items'), 'items_required')
  uniqueItems(v.items, out, child(path, 'items'), (item, p) => {
    out.push(...validateSnapshot(item.snapshot, child(p, 'snapshot')))
    out.push(...validateConsumption(item.snapshot, item.quantity, child(p, 'quantity')))
  })
  return out
}

export function validateNutritionGoal(v, path = 'goal') {
  const out = []
  if (!header(v, out, path, false)) return out
  if (!isNutritionDate(v.start)) issue(out, child(path, 'start'), 'invalid_date')
  if (v.end != null && (!isNutritionDate(v.end) || v.end < v.start)) issue(out, child(path, 'end'), 'invalid_end_date')
  if (!['custom', 'maintenance', 'bulk', 'cut'].includes(v.mode)) issue(out, child(path, 'mode'), 'unknown_goal_mode')
  out.push(...validateNutrients(v.targets, child(path, 'targets')))
  if (object(v.targets) && !NUTRIENTS.some(k => nonnegative(v.targets[k]))) issue(out, child(path, 'targets'), 'target_required')
  if (v.basis != null && record(v.basis, out, child(path, 'basis'))) {
    for (const key of ['weightKg', 'maintenanceKcal']) {
      if (v.basis[key] != null && !positive(v.basis[key])) issue(out, child(child(path, 'basis'), key), 'positive_number_required')
    }
    if (v.basis.energyAdjustmentKcal != null && (typeof v.basis.energyAdjustmentKcal !== 'number' || !Number.isFinite(v.basis.energyAdjustmentKcal))) {
      issue(out, child(child(path, 'basis'), 'energyAdjustmentKcal'), 'finite_number_required')
    }
  }
  return out
}
