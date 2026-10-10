import { describe, it } from 'vitest'
import assert from 'node:assert/strict'
import { NUTRIENTS, NutritionValidationError } from './contracts.js'
import {
  normalizeNutrients, convertQuantity, kcalFromKj, kjFromKcal, quantityInReference,
  nutrientsForQuantity, sumNutrients, sumFoodEntries, macroEnergy, remainingNutrients,
} from './calculate.js'
import { food, entry, freeze, close } from './fixtures.test-util.js'

describe('nutrition unit conversions', () => {
  for (const [amount, from, to, expected] of [
    [2, 'kg', 'g', 2000], [500, 'mg', 'g', 0.5], [1, 'lb', 'g', 453.59237],
    [1, 'oz', 'g', 28.349523125], [1, 'lb', 'oz', 16],
    [1.5, 'l', 'ml', 1500], [3, 'cl', 'ml', 30], [2.5, 'dl', 'ml', 250],
    [125, 'ml', 'l', 0.125], [0, 'kg', 'g', 0],
  ]) it(`converts ${amount} ${from} to ${to} without display rounding`, () => {
    close(convertQuantity(amount, from, to), expected)
    close(convertQuantity(expected, to, from), amount)
  })

  it('uses an explicit density in both directions', () => {
    close(convertQuantity(100, 'ml', 'g', { densityGPerMl: 0.92 }), 92)
    close(convertQuantity(92, 'g', 'ml', { densityGPerMl: 0.92 }), 100)
    close(convertQuantity(0.1, 'l', 'kg', { densityGPerMl: 0.92 }), 0.092)
  })

  it('does not assume that one ml weighs one gram', () => {
    assert.throws(() => convertQuantity(10, 'ml', 'g'), NutritionValidationError)
    for (const densityGPerMl of [0, -1, NaN, Infinity, '1']) {
      assert.throws(() => convertQuantity(10, 'ml', 'g', { densityGPerMl }), NutritionValidationError)
    }
  })

  it('rejects ambiguous, unknown or inherited unit names', () => {
    for (const unit of ['cup', 'fl-oz', 'serving', 'portion', 'toString', '__proto__', null, ['g']]) {
      assert.throws(() => convertQuantity(1, unit, 'g'), NutritionValidationError)
      assert.throws(() => convertQuantity(1, 'g', unit), NutritionValidationError)
    }
  })

  it('rejects invalid numbers and overflowing results', () => {
    for (const amount of [-1, NaN, Infinity, '12', '', null, undefined, true]) {
      assert.throws(() => convertQuantity(amount, 'g', 'g'), NutritionValidationError)
    }
    assert.throws(() => convertQuantity(Number.MAX_VALUE, 'kg', 'g'), NutritionValidationError)
    assert.equal(convertQuantity(Number.MAX_VALUE, 'kg', 'kg'), Number.MAX_VALUE)
  })

  it('converts energy at 4.184 kJ per kcal', () => {
    close(kcalFromKj(418.4), 100)
    close(kjFromKcal(100), 418.4)
    close(kcalFromKj(kjFromKcal(123.456)), 123.456)
    assert.equal(kcalFromKj(0), 0)
    for (const value of [-1, NaN, Infinity, '100', null]) {
      assert.throws(() => kcalFromKj(value), NutritionValidationError)
      assert.throws(() => kjFromKcal(value), NutritionValidationError)
    }
    assert.throws(() => kjFromKcal(Number.MAX_VALUE), NutritionValidationError)
  })
})

describe('nutrients for a consumed quantity', () => {
  it('scales calories and macros per 100 g', () => {
    const result = nutrientsForQuantity(food(), { amount: 50, unit: 'g' })
    assert.deepEqual(result, { kcal: 190, protein: 6.5, carbs: 30, fat: 3.5, fiber: 5, sugar: 0.5, saturatedFat: 0.5, sodium: 0 })
  })

  it('supports any explicit reference amount, including ml', () => {
    const f = food({ reference: { amount: 250, unit: 'ml' }, portions: [] })
    assert.equal(nutrientsForQuantity(f, { amount: 0.5, unit: 'l' }).kcal, 760)
  })

  it('scales fractional, food-specific portions', () => {
    assert.equal(quantityInReference(food(), { amount: 1.5, unit: 'portion', portionId: 'scoop' }), 60)
    close(nutrientsForQuantity(food(), { amount: 1.5, unit: 'portion', portionId: 'scoop' }).kcal, 228)
  })

  it('converts a volume-based portion using the food density', () => {
    const f = food({ densityGPerMl: 0.92, portions: [{ id: 'spoon', label: 'Spoon', amount: 15, unit: 'ml' }] })
    close(quantityInReference(f, { amount: 2, unit: 'portion', portionId: 'spoon' }), 27.6)
  })

  it('scales a volume label consumed by mass only with known density', () => {
    const f = food({ reference: { amount: 100, unit: 'ml' }, portions: [], densityGPerMl: 1.03 })
    assert.equal(nutrientsForQuantity(f, { amount: 103, unit: 'g' }).kcal, 380)
    assert.throws(() => nutrientsForQuantity({ ...f, densityGPerMl: null }, { amount: 103, unit: 'g' }), NutritionValidationError)
  })

  it('rejects overflowing scales even when all nutrients are unknown', () => {
    const f = food({ reference: { amount: Number.MIN_VALUE, unit: 'g' }, nutrients: {} })
    assert.throws(() => nutrientsForQuantity(f, { amount: 1, unit: 'g' }), NutritionValidationError)
  })

  it('rejects portions from another food and unitless food servings', () => {
    assert.throws(() => nutrientsForQuantity(food(), { amount: 1, unit: 'portion', portionId: 'unknown' }), NutritionValidationError)
    assert.throws(() => nutrientsForQuantity(food(), { amount: 1, unit: 'serving' }), NutritionValidationError)
    assert.throws(() => nutrientsForQuantity(food(), { amount: 0, unit: 'g' }), NutritionValidationError)
  })

  it('keeps missing values null and real zeros zero', () => {
    const result = nutrientsForQuantity(food({ nutrients: { kcal: 0, protein: null, carbs: 0 } }), { amount: 50, unit: 'g' })
    assert.equal(result.kcal, 0)
    assert.equal(result.carbs, 0)
    for (const k of ['protein', 'fat', 'fiber', 'sugar', 'saturatedFat', 'sodium']) assert.equal(result[k], null)
  })

  it('does not round intermediate values or mutate its arguments', () => {
    const f = freeze(food()), quantity = freeze({ amount: 33.333, unit: 'g' })
    const before = JSON.stringify({ f, quantity })
    close(nutrientsForQuantity(f, quantity).protein, 4.33329)
    assert.equal(JSON.stringify({ f, quantity }), before)
  })

  it('retains declared energy instead of reconstructing it from macros', () => {
    const values = nutrientsForQuantity(food(), { amount: 100, unit: 'g' })
    assert.equal(values.kcal, 380)
    assert.equal(macroEnergy(values).totalKcal, 355)
  })
})

describe('nutrition aggregation and goals', () => {
  it('normalizes omitted keys without coercing invalid values', () => {
    assert.deepEqual(normalizeNutrients({}), Object.fromEntries(NUTRIENTS.map(k => [k, null])))
    for (const value of ['', '0', false, NaN, Infinity, -1]) {
      assert.throws(() => normalizeNutrients({ kcal: value }), NutritionValidationError)
    }
    assert.throws(() => normalizeNutrients(null), NutritionValidationError)
  })

  it('sums complete meals', () => {
    const half = nutrientsForQuantity(food(), { amount: 50, unit: 'g' })
    const result = sumNutrients([half, half])
    assert.deepEqual(result.totals, food().nutrients)
    assert.deepEqual(result.totals, result.knownTotals)
    assert.equal(result.count, 2)
    assert.equal(result.missing.kcal, 0)
  })

  it('reports partial totals separately for each nutrient', () => {
    const result = sumNutrients([{ kcal: 100, protein: 0 }, { kcal: null, protein: 5 }])
    assert.equal(result.totals.kcal, null)
    assert.equal(result.knownTotals.kcal, 100)
    assert.equal(result.missing.kcal, 1)
    assert.equal(result.totals.protein, 5)
    assert.equal(result.missing.protein, 0)
    assert.equal(result.missing.fat, 2)
  })

  it('represents an empty selection explicitly and refuses malformed items', () => {
    const result = sumNutrients([])
    assert.equal(result.count, 0)
    assert.equal(result.totals.kcal, 0)
    assert.throws(() => sumNutrients({}), NutritionValidationError)
    assert.throws(() => sumNutrients([null]), NutritionValidationError)
    assert.throws(() => sumNutrients([{ kcal: Number.MAX_VALUE }, { kcal: Number.MAX_VALUE }]), NutritionValidationError)
  })

  it('sums food entries once per stable id and validates their dates', () => {
    const entries = freeze([entry(), entry({ id: 'entry-2' })])
    assert.equal(sumFoodEntries(entries).totals.kcal, 380)
    assert.throws(() => sumFoodEntries([entry(), entry()]), NutritionValidationError)
    assert.throws(() => sumFoodEntries([entry({ d: '2026-02-30' })]), NutritionValidationError)
  })

  it('computes the energy distribution rather than proportions of macro grams', () => {
    const result = macroEnergy({ protein: 10, carbs: 10, fat: 10, kcal: 200 })
    assert.deepEqual(result.kcal, { protein: 40, carbs: 40, fat: 90 })
    assert.equal(result.totalKcal, 170)
    close(result.percent.protein + result.percent.carbs + result.percent.fat, 100)
    close(result.percent.fat, 90 / 170 * 100)
  })

  it('distinguishes absent macros from a zero-calorie distribution', () => {
    assert.deepEqual(macroEnergy({ protein: 0, carbs: 0, fat: 0 }).percent, { protein: 0, carbs: 0, fat: 0 })
    assert.deepEqual(macroEnergy({ protein: 10, carbs: 20 }).percent, { protein: null, carbs: null, fat: null })
    assert.equal(macroEnergy({ protein: 10 }).kcal.protein, 40)
  })

  it('keeps exceedances negative and absent goals or totals unknown', () => {
    const remaining = remainingNutrients({ kcal: 2200, protein: null, carbs: 200 }, { kcal: 2000, protein: 100 })
    assert.equal(remaining.kcal, -200)
    assert.equal(remaining.protein, null)
    assert.equal(remaining.carbs, null)
    assert.equal(remainingNutrients({ kcal: 0 }, { kcal: 0 }).kcal, 0)
  })
})
