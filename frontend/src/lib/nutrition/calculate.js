import { NUTRIENTS, MASS_UNITS, VOLUME_UNITS, NutritionValidationError, assertValid } from './contracts.js'
import { validateNutrients, validateSnapshot, validateConsumption, validateFoodEntry } from './validate.js'

const own = (o, k) => Object.hasOwn(o, k)
const fail = (path, code) => { throw new NutritionValidationError([{ path, code }]) }
const finite = n => {
  if (!Number.isFinite(n)) fail('calculation', 'numeric_overflow')
  return n
}

/** Missing values are explicit nulls. Never interpret a blank form field as zero. */
export function normalizeNutrients(values) {
  assertValid(validateNutrients(values))
  return Object.fromEntries(NUTRIENTS.map(k => [k, values[k] ?? null]))
}

/** Mass/volume conversion only. Density is grams per ml and is never guessed. */
export function convertQuantity(amount, from, to, { densityGPerMl } = {}) {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) fail('amount', 'nonnegative_number_required')
  const units = { ...MASS_UNITS, ...VOLUME_UNITS }
  if (typeof from !== 'string' || typeof to !== 'string' || !own(units, from) || !own(units, to)) fail('unit', 'unknown_unit')
  const massFrom = own(MASS_UNITS, from), massTo = own(MASS_UNITS, to)
  // Form the ratio first so identity and equivalent conversions don't overflow needlessly.
  let ratio = units[from] / units[to]
  if (massFrom !== massTo) {
    if (typeof densityGPerMl !== 'number' || !Number.isFinite(densityGPerMl) || densityGPerMl <= 0) fail('densityGPerMl', 'density_required')
    ratio = massFrom ? ratio / densityGPerMl : ratio * densityGPerMl
  }
  return finite(amount * ratio)
}

export function kcalFromKj(kj) {
  if (typeof kj !== 'number' || !Number.isFinite(kj) || kj < 0) fail('kj', 'nonnegative_number_required')
  return kj / 4.184
}

export function kjFromKcal(kcal) {
  if (typeof kcal !== 'number' || !Number.isFinite(kcal) || kcal < 0) fail('kcal', 'nonnegative_number_required')
  return finite(kcal * 4.184)
}

/** Quantity expressed in the snapshot's reference unit (g, ml, or recipe servings). */
export function quantityInReference(snapshot, quantity) {
  assertValid(validateSnapshot(snapshot))
  assertValid(validateConsumption(snapshot, quantity))
  if (snapshot.kind === 'recipe') {
    if (quantity.unit === 'serving') return quantity.amount
    const mass = own(MASS_UNITS, quantity.unit)
    const amount = convertQuantity(quantity.amount, quantity.unit, mass ? 'g' : 'ml')
    const batch = mass ? snapshot.yield.grams : snapshot.yield.ml
    return finite(amount / batch * snapshot.yield.servings)
  }
  let { amount, unit } = quantity
  if (unit === 'portion') {
    const portion = snapshot.portions.find(p => p.id === quantity.portionId)
    amount = finite(amount * portion.amount)
    unit = portion.unit
  }
  return convertQuantity(amount, unit, snapshot.reference.unit, { densityGPerMl: snapshot.densityGPerMl })
}

/** Declared calories are scaled as supplied; the macro estimate never replaces them. */
export function nutrientsForQuantity(snapshot, quantity) {
  const factor = finite(quantityInReference(snapshot, quantity) / snapshot.reference.amount)
  const values = normalizeNutrients(snapshot.nutrients)
  return Object.fromEntries(NUTRIENTS.map(k => [k, values[k] === null ? null : finite(values[k] * factor)]))
}

/** Strict totals become null if any item is unknown. Known subtotals remain available explicitly. */
export function sumNutrients(items) {
  if (!Array.isArray(items)) fail('items', 'array_required')
  const knownTotals = Object.fromEntries(NUTRIENTS.map(k => [k, 0]))
  const missing = Object.fromEntries(NUTRIENTS.map(k => [k, 0]))
  for (const item of items) {
    const values = normalizeNutrients(item)
    for (const k of NUTRIENTS) {
      if (values[k] === null) missing[k]++
      else knownTotals[k] = finite(knownTotals[k] + values[k])
    }
  }
  const totals = Object.fromEntries(NUTRIENTS.map(k => [k, missing[k] ? null : knownTotals[k]]))
  return { totals, knownTotals, missing, count: items.length }
}

/** The caller filters by day/meal; no clock, locale, storage or React dependency is involved. */
export function sumFoodEntries(entries) {
  if (!Array.isArray(entries)) fail('entries', 'array_required')
  const seen = new Set()
  return sumNutrients(entries.map(entry => {
    assertValid(validateFoodEntry(entry))
    if (seen.has(entry.id)) fail('entry.id', 'duplicate_id')
    seen.add(entry.id)
    return nutrientsForQuantity(entry.snapshot, entry.quantity)
  }))
}

/** Distribution among macro-derived calories, not percentages of the label's declared kcal. */
export function macroEnergy(values) {
  const nutrients = normalizeNutrients(values)
  const energy = Object.fromEntries([['protein', 4], ['carbs', 4], ['fat', 9]].map(([k, factor]) =>
    [k, nutrients[k] === null ? null : finite(nutrients[k] * factor)]))
  const complete = Object.values(energy).every(v => v !== null)
  const totalKcal = complete ? finite(energy.protein + energy.carbs + energy.fat) : null
  const percent = Object.fromEntries(Object.keys(energy).map(k => [k,
    totalKcal === null ? null : totalKcal === 0 ? 0 : energy[k] / totalKcal * 100]))
  return { kcal: energy, totalKcal, percent }
}

/** A negative result means over the target; an unknown target/intake stays unknown. */
export function remainingNutrients(consumed, targets) {
  const have = normalizeNutrients(consumed), goal = normalizeNutrients(targets)
  return Object.fromEntries(NUTRIENTS.map(k => [k,
    have[k] === null || goal[k] === null ? null : finite(goal[k] - have[k])]))
}
