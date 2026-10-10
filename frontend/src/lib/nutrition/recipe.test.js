import { describe, it } from 'vitest'
import assert from 'node:assert/strict'
import { NutritionValidationError } from './contracts.js'
import { recipeNutrients, createRecipeSnapshot } from './recipe.js'
import { nutrientsForQuantity, sumFoodEntries } from './calculate.js'
import { validateRecipe } from './validate.js'
import { food, entry, recipe, freeze, close } from './fixtures.test-util.js'

describe('recipe nutrition foundations', () => {
  it('sums foods with different reference units into batch nutrients', () => {
    const result = recipeNutrients(recipe())
    assert.equal(result.totals.kcal, 500)
    assert.equal(result.totals.protein, 19)
    assert.equal(result.totals.carbs, 70)
    assert.equal(result.totals.fat, 13)
  })

  it('calculates a fractional serving from the full batch', () => {
    const snapshot = createRecipeSnapshot(recipe())
    assert.equal(nutrientsForQuantity(snapshot, { amount: 0.5, unit: 'serving' }).kcal, 125)
    assert.equal(nutrientsForQuantity(snapshot, { amount: 1, unit: 'serving' }).protein, 9.5)
  })

  it('uses the cooked weight, not the raw ingredients total', () => {
    const snapshot = createRecipeSnapshot(recipe())
    assert.equal(nutrientsForQuantity(snapshot, { amount: 140, unit: 'g' }).kcal, 250)
    assert.equal(nutrientsForQuantity(snapshot, { amount: 0.28, unit: 'kg' }).kcal, 500)
    close(nutrientsForQuantity(snapshot, { amount: 100, unit: 'g' }).kcal, 500 / 280 * 100)
  })

  it('supports a measured volume independently of a measured mass', () => {
    const snapshot = createRecipeSnapshot(recipe({ yield: { servings: 2, ml: 400 } }))
    assert.equal(nutrientsForQuantity(snapshot, { amount: 2, unit: 'dl' }).kcal, 250)
    assert.throws(() => nutrientsForQuantity(snapshot, { amount: 100, unit: 'g' }), NutritionValidationError)
  })

  it('allows servings without inventing cooked mass or volume', () => {
    const snapshot = createRecipeSnapshot(recipe({ yield: { servings: 2 } }))
    assert.equal(nutrientsForQuantity(snapshot, { amount: 1, unit: 'serving' }).kcal, 250)
    for (const unit of ['g', 'ml']) assert.throws(() => nutrientsForQuantity(snapshot, { amount: 100, unit }), NutritionValidationError)
  })

  it('keeps an unknown ingredient nutrient unknown in every serving', () => {
    const r = recipe()
    r.ingredients[1].food.nutrients.protein = null
    const result = recipeNutrients(r)
    assert.equal(result.totals.protein, null)
    assert.equal(result.knownTotals.protein, 13)
    assert.equal(result.missing.protein, 1)
    assert.equal(nutrientsForQuantity(createRecipeSnapshot(r), { amount: 1, unit: 'serving' }).protein, null)
  })

  it('creates independent snapshots and retains external source attribution', () => {
    const r = recipe()
    r.ingredients[0].food.source = {
      kind: 'open-food-facts', externalId: '12345678', url: 'https://world.openfoodfacts.org/product/12345678',
      license: { id: 'ODbL-1.0', url: 'https://opendatacommons.org/licenses/odbl/1-0/', attribution: 'Open Food Facts contributors' },
    }
    const snapshot = createRecipeSnapshot(r)
    r.ingredients[0].food.source.license.attribution = 'Changed'
    r.ingredients[0].food.nutrients.kcal = 100
    r.yield.servings = 4
    assert.equal(snapshot.nutrients.kcal, 500)
    assert.equal(snapshot.yield.servings, 2)
    assert.equal(snapshot.ingredientSources[0].source.license.attribution, 'Open Food Facts contributors')
    assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot)
  })

  it('accepts frozen recipes and mixes recipe and food journal snapshots', () => {
    const snapshot = createRecipeSnapshot(freeze(recipe()))
    const entries = [entry(), entry({ id: 'recipe-entry', snapshot, quantity: { amount: 1, unit: 'serving' } })]
    assert.equal(sumFoodEntries(freeze(entries)).totals.kcal, 440)
  })

  it('rejects empty recipes, invalid yields, duplicate ingredient ids and nested recipes', () => {
    assert.throws(() => createRecipeSnapshot(recipe({ ingredients: [] })), NutritionValidationError)
    for (const servings of [0, -1, NaN, '2', null]) {
      assert.throws(() => createRecipeSnapshot(recipe({ yield: { servings } })), NutritionValidationError)
    }
    const r = recipe()
    r.ingredients[1].id = r.ingredients[0].id
    assert.throws(() => recipeNutrients(r), NutritionValidationError)
    r.ingredients = [{ id: 'nested', food: createRecipeSnapshot(recipe()), quantity: { amount: 1, unit: 'serving' } }]
    assert.throws(() => recipeNutrients(r), NutritionValidationError)
  })

  it('accepts explicitly defined ingredient portions', () => {
    const r = recipe({ ingredients: [{ id: 'oats', food: food(), quantity: { amount: 2.5, unit: 'portion', portionId: 'scoop' } }] })
    assert.equal(recipeNutrients(r).totals.kcal, 380)
  })
})

describe('recipe JSON snapshot regressions', () => {
  for (const [label, value, code] of [
    ['undefined', undefined, 'json_unsupported_value'], ['bigint', 1n, 'json_unsupported_value'],
    ['function', () => 1, 'json_unsupported_value'], ['symbol', Symbol('x'), 'json_unsupported_value'],
    ['NaN', NaN, 'json_nonfinite_number'], ['infinity', Infinity, 'json_nonfinite_number'],
    ['negative infinity', -Infinity, 'json_nonfinite_number'],
    ['date', new Date('2026-10-10'), 'json_plain_object_required'],
    ['map', new Map([['a', 1]]), 'json_plain_object_required'],
    ['set', new Set([1]), 'json_plain_object_required'],
    ['typed array', new Uint8Array([1]), 'json_plain_object_required'],
    ['boxed number', new Number(1), 'json_plain_object_required'],
  ]) it(`rejects ${label} in provenance and recipe metadata with NutritionValidationError`, () => {
    for (const location of ['source', 'recipe']) {
      const r = recipe()
      const target = location === 'source' ? r.ingredients[0].food.source : r
      target.extra = { value }
      const path = location === 'source' ? 'recipe.ingredients[0].food.source.extra.value' : 'recipe.extra.value'
      assert.ok(validateRecipe(r).some(i => i.path === path && i.code === code))
      assert.throws(() => createRecipeSnapshot(r), e => e instanceof NutritionValidationError &&
        e.issues.some(i => i.path === path && i.code === code))
    }
  })

  it('rejects direct and indirect provenance cycles before JSON cloning', () => {
    for (const indirect of [false, true]) {
      const r = recipe(), source = r.ingredients[0].food.source
      source.extra = indirect ? [{ back: source }] : source
      const path = `recipe.ingredients[0].food.source.extra${indirect ? '[0].back' : ''}`
      assert.throws(() => createRecipeSnapshot(r), e => e instanceof NutritionValidationError &&
        e.issues.some(i => i.path === path && i.code === 'json_circular_reference'))
    }
  })

  it('rejects inherited external license data', () => {
    const r = recipe()
    r.ingredients[0].food.source.license = Object.create({ id: 'ODbL-1.0',
      url: 'https://opendatacommons.org/licenses/odbl/1-0/', attribution: 'Contributors' })
    assert.throws(() => createRecipeSnapshot(r), e => e instanceof NutritionValidationError &&
      e.issues.some(i => i.path.endsWith('.source.license') && i.code === 'json_plain_object_required'))
  })

  it('rejects accessors and toJSON hooks without invoking user code', () => {
    let calls = 0
    for (const hook of ['getter', 'toJSON']) {
      const r = recipe(), source = r.ingredients[0].food.source
      if (hook === 'getter') Object.defineProperty(source, 'extra', { enumerable: true, get() { calls++; throw new Error('must not read') } })
      else source.toJSON = () => { calls++; return { kind: 'custom' } }
      assert.throws(() => createRecipeSnapshot(r), NutritionValidationError)
    }
    assert.equal(calls, 0)
  })

  it('rejects sparse arrays and extra array properties that JSON would change or omit', () => {
    for (const makeArray of [() => new Array(1), () => [undefined], () => Object.assign([1], { note: 'lost' })]) {
      const r = recipe()
      r.ingredients[0].food.source.extra = makeArray()
      assert.throws(() => createRecipeSnapshot(r), NutritionValidationError)
    }
  })

  it('accepts shared acyclic metadata and copies nested provenance without mutation', () => {
    const r = recipe(), shared = { text: 'Attribution', flags: [true, false, null], score: 0 }
    r.ingredients[0].food.source.extra = { first: shared, second: shared }
    const before = JSON.stringify(r), snapshot = createRecipeSnapshot(freeze(r))
    assert.equal(JSON.stringify(r), before)
    assert.deepEqual(snapshot.ingredientSources[0].source.extra, { first: shared, second: shared })
    assert.notEqual(snapshot.ingredientSources[0].source.extra.first, shared)
    assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot)
  })
})
