import { describe, it } from 'vitest'
import assert from 'node:assert/strict'
import { NutritionValidationError, assertValid } from './contracts.js'
import {
  isNutritionDate, validateFood, validateQuantity, validateConsumption, validateRecipe,
  validateSnapshot, validateFoodEntry, validateMealTemplate, validateNutritionGoal,
} from './validate.js'
import { createRecipeSnapshot, recipeNutrients } from './recipe.js'
import { normalizeNutrients, nutrientsForQuantity } from './calculate.js'
import { food, entry, recipe, freeze } from './fixtures.test-util.js'

const codes = issues => issues.map(i => i.code)

describe('nutrition contracts', () => {
  it('validates complete JSON foods, journal entries, recipes and snapshots', () => {
    const f = freeze(food()), e = freeze(entry()), r = freeze(recipe())
    assert.deepEqual(validateFood(f), [])
    assert.deepEqual(validateFoodEntry(e), [])
    assert.deepEqual(validateRecipe(r), [])
    assert.deepEqual(validateSnapshot(createRecipeSnapshot(r)), [])
    assert.deepEqual(validateFood(JSON.parse(JSON.stringify(f))), [])
  })

  it('returns structured errors instead of throwing while validating bad shapes', () => {
    for (const validate of [validateFood, validateQuantity, validateRecipe, validateSnapshot, validateFoodEntry, validateMealTemplate, validateNutritionGoal]) {
      for (const value of [null, undefined, false, 42, 'food', [], {}]) {
        const issues = validate(value)
        assert.ok(issues.length > 0)
        assert.ok(issues.every(i => typeof i.path === 'string' && typeof i.code === 'string'))
      }
    }
    const issues = validateFood({ schemaVersion: 1, id: 'a', name: 'Food', kind: 'food' })
    assert.throws(() => assertValid(issues), e => e instanceof NutritionValidationError && e.issues === issues)
  })

  it('refuses unsupported versions without migrating or discarding data', () => {
    assert.ok(codes(validateFood(food({ schemaVersion: 2 }))).includes('unsupported_version'))
    assert.ok(codes(validateFoodEntry(entry({ schemaVersion: null }))).includes('unsupported_version'))
  })

  it('requires names and stable ids, but tolerates future metadata without mutating it', () => {
    assert.ok(validateFood(food({ id: '', name: '  ' })).length)
    const f = freeze(food({ future: { preserved: true }, _ts: 123 }))
    assert.deepEqual(validateFood(f), [])
    assert.equal(f.future.preserved, true)
  })

  it('accepts omitted nutrients as unknown and zero as a declared value', () => {
    assert.deepEqual(validateFood(food({ nutrients: {} })), [])
    assert.deepEqual(validateFood(food({ nutrients: { kcal: null, protein: 0 } })), [])
  })

  for (const value of [-1, NaN, Infinity, '12', '', true]) {
    it(`rejects invalid nutrient ${String(value)}`, () => {
      assert.ok(codes(validateFood(food({ nutrients: { protein: value } }))).includes('nonnegative_number_required'))
    })
  }

  it('validates nutrient subcomponents without rejecting label energy differences', () => {
    assert.ok(codes(validateFood(food({ nutrients: { carbs: 2, sugar: 3 } }))).includes('exceeds_parent_nutrient'))
    assert.ok(codes(validateFood(food({ nutrients: { fat: 2, saturatedFat: 3 } }))).includes('exceeds_parent_nutrient'))
    assert.deepEqual(validateFood(food({ nutrients: { kcal: 400, protein: 10, carbs: 20, fat: 10 } })), [])
  })

  it('checks individual nutrients against mass references, not volume references', () => {
    const nutrients = { carbs: 120 }
    assert.ok(codes(validateFood(food({ nutrients }))).includes('exceeds_reference_mass'))
    assert.deepEqual(validateFood(food({ reference: { amount: 100, unit: 'ml' }, nutrients, portions: [] })), [])
  })

  it('requires explicit positive references and validates portions', () => {
    for (const amount of [0, -1, NaN, '100']) assert.ok(validateFood(food({ reference: { amount, unit: 'g' } })).length)
    assert.ok(validateFood(food({ reference: { amount: 100, unit: 'cup' } })).length)
    assert.ok(codes(validateFood(food({ portions: [food().portions[0], food().portions[0]] }))).includes('duplicate_id'))
    assert.ok(validateFood(food({ portions: [{ id: 'p', label: 'Portion', amount: 0, unit: 'g' }] })).length)
    assert.ok(validateFood(food({ portions: new Array(1) })).length)
  })

  it('reserves default quantities for fast logging and validates them in context', () => {
    assert.deepEqual(validateFood(food({ defaultQuantity: { amount: 1, unit: 'portion', portionId: 'scoop' } })), [])
    assert.ok(codes(validateFood(food({ defaultQuantity: { amount: 1, unit: 'portion', portionId: 'other' } }))).includes('unknown_portion'))
    assert.ok(codes(validateFood(food({ defaultQuantity: { amount: 1, unit: 'ml' } }))).includes('density_required'))
  })

  it('requires positive quantities and refuses stray portion ids', () => {
    for (const amount of [0, -1, NaN, Infinity, '50', false]) assert.ok(validateQuantity({ amount, unit: 'g' }).length)
    assert.ok(codes(validateQuantity({ amount: 1, unit: 'g', portionId: 'scoop' })).includes('unexpected_portion_id'))
    assert.ok(validateQuantity({ amount: 1, unit: 'portion' }).length)
    assert.ok(validateConsumption({}, { amount: 1, unit: 'g' }).length)
  })

  it('requires external provenance and license attribution separately from custom food', () => {
    assert.deepEqual(validateFood(food()), [])
    assert.ok(validateFood(food({ source: { kind: 'open-food-facts' } })).length)
    const source = {
      kind: 'open-food-facts', externalId: '12345678', url: 'https://world.openfoodfacts.org/product/12345678',
      license: { id: 'ODbL-1.0', url: 'https://opendatacommons.org/licenses/odbl/1-0/', attribution: 'Open Food Facts contributors' },
    }
    assert.deepEqual(validateFood(food({ source })), [])
    assert.ok(validateFood(food({ source: { ...source, url: 'javascript:alert(1)' } })).length)
    assert.ok(validateFood(food({ source: { ...source, license: { ...source.license, attribution: '' } } })).length)
    assert.ok(validateFood(food({ source: { kind: 'custom', url: 'javascript:alert(1)' } })).length)
  })

  it('checks actual calendar dates, including leap years', () => {
    for (const d of ['2024-02-29', '2026-10-10']) assert.equal(isNutritionDate(d), true)
    for (const d of ['2026-02-29', '2026-02-30', '2026-13-01', '2026-1-01', '', null]) assert.equal(isNutritionDate(d), false)
  })

  it('preserves the chosen food day independently of travel and UTC timestamp', () => {
    const e = freeze(entry({ d: '2026-10-10', consumedAt: '2026-10-11T00:30:00Z', timeZone: 'America/New_York' }))
    assert.deepEqual(validateFoodEntry(e), [])
    assert.equal(e.d, '2026-10-10')
  })

  it('checks timestamps, time zones and meal categories', () => {
    for (const consumedAt of ['2026-02-30T12:00:00Z', '2026-10-10T24:00:00Z', '2026-10-10T12:00:00', 'bad', 123]) {
      assert.ok(codes(validateFoodEntry(entry({ consumedAt }))).includes('invalid_timestamp'))
    }
    assert.deepEqual(validateFoodEntry(entry({ consumedAt: '2026-10-10T12:30:59.123+02:00' })), [])
    assert.ok(codes(validateFoodEntry(entry({ timeZone: 'Invalid/Zone' }))).includes('invalid_time_zone'))
    assert.ok(codes(validateFoodEntry(entry({ meal: 'brunch' }))).includes('unknown_meal'))
  })

  it('reserves meal grouping and duplication provenance without creating entries', () => {
    const e = freeze(entry({ mealId: 'meal-2', copiedFromEntryId: 'old-entry' }))
    assert.deepEqual(validateFoodEntry(e), [])
    assert.ok(validateFoodEntry(entry({ mealId: '' })).length)
    const template = { schemaVersion: 1, id: 'breakfast', name: 'Usual breakfast', items: [
      { id: 'oats', snapshot: food(), quantity: { amount: 50, unit: 'g' } },
      { id: 'porridge', snapshot: createRecipeSnapshot(recipe()), quantity: { amount: 1, unit: 'serving' } },
    ] }
    assert.deepEqual(validateMealTemplate(freeze(template)), [])
    assert.ok(validateMealTemplate({ ...template, items: [] }).length)
    assert.ok(codes(validateMealTemplate({ ...template, items: [template.items[0], template.items[0]] })).includes('duplicate_id'))
  })

  it('checks measured recipe yields and snapshot consistency', () => {
    const snapshot = createRecipeSnapshot(recipe())
    assert.ok(validateSnapshot({ ...snapshot, reference: { amount: 3, unit: 'serving' } }).length)
    assert.ok(validateSnapshot({ ...snapshot, ingredientSources: [] }).length)
    for (const value of [0, -1, NaN, '100']) assert.ok(validateRecipe(recipe({ yield: { servings: 2, grams: value } })).length)
    assert.ok(validateConsumption({ ...snapshot, portions: food().portions }, { amount: 1, unit: 'portion', portionId: 'scoop' }).length)
  })

  it('accepts dated goals with partial targets and keeps them independent of food mass', () => {
    const goal = { schemaVersion: 1, id: 'bulk-1', start: '2026-10-10', end: null, mode: 'bulk', targets: { kcal: 2800, protein: 150 } }
    assert.deepEqual(validateNutritionGoal(freeze(goal)), [])
    assert.deepEqual(validateNutritionGoal({ ...goal, targets: { kcal: 0 } }), [])
    assert.ok(validateNutritionGoal({ ...goal, end: '2026-10-09' }).length)
    assert.ok(validateNutritionGoal({ ...goal, targets: {} }).length)
    assert.ok(validateNutritionGoal({ ...goal, targets: { kcal: -1 } }).length)
    assert.deepEqual(validateNutritionGoal({ ...goal, basis: { weightKg: 80, maintenanceKcal: 2600, energyAdjustmentKcal: 200 } }), [])
    assert.deepEqual(validateNutritionGoal({ ...goal, mode: 'cut', basis: { energyAdjustmentKcal: -200 } }), [])
    assert.ok(validateNutritionGoal({ ...goal, basis: { weightKg: 0 } }).length)
    assert.ok(validateNutritionGoal({ ...goal, basis: { energyAdjustmentKcal: Infinity } }).length)
  })
})

describe('nutrition validation regressions', () => {
  for (const [label, nutrients] of [
    ['negative', { protein: -1 }], ['NaN', { protein: NaN }],
    ['infinite', { protein: Infinity }], ['string', { protein: '12' }],
    ['boolean', { protein: true }], ['blank', { protein: '' }],
    ['sugar above carbs', { carbs: 2, sugar: 3 }],
    ['saturated fat above fat', { fat: 2, saturatedFat: 3 }],
  ]) it(`applies the same ${label} nutrient rejection to foods, recipes and snapshots`, () => {
    const f = food({ nutrients }), r = recipe()
    r.ingredients[0].food = f
    const snapshot = { ...createRecipeSnapshot(recipe()), nutrients }
    const code = label.includes('above') ? 'exceeds_parent_nutrient' : 'nonnegative_number_required'
    for (const issues of [validateFood(f), validateRecipe(r), validateSnapshot(snapshot)]) {
      assert.ok(codes(issues).includes(code), `${label}: ${JSON.stringify(issues)}`)
    }
    assert.throws(() => normalizeNutrients(nutrients), NutritionValidationError)
    assert.throws(() => recipeNutrients(r), NutritionValidationError)
    assert.throws(() => nutrientsForQuantity(snapshot, { amount: 1, unit: 'serving' }), NutritionValidationError)
  })

  it('accepts equal subcomponents, zeros and unknown parents without inventing label energy', () => {
    for (const nutrients of [{ kcal: 999, carbs: 2, sugar: 2, fat: 1, saturatedFat: 1 },
      { carbs: 0, sugar: 0, fat: null, saturatedFat: 2 }, { sugar: 1 }]) {
      assert.deepEqual(validateFood(food({ nutrients })), [])
      assert.deepEqual(validateSnapshot({ ...createRecipeSnapshot(recipe()), nutrients }), [])
      assert.deepEqual(normalizeNutrients(nutrients).sugar, nutrients.sugar)
    }
  })

  for (const key of ['nutrients', 'reference', 'source']) {
    it(`rejects inherited ${key} data before calculations or JSON roundtrips`, () => {
      const f = food()
      f[key] = Object.create(f[key])
      assert.ok(validateFood(f).some(i => i.path === `food.${key}` && i.code === 'json_plain_object_required'))
      assert.throws(() => nutrientsForQuantity(f, { amount: 100, unit: 'g' }), NutritionValidationError)
    })
  }

  it('rejects inherited fields on records, quantities, recipe yields and ingredient rows', () => {
    assert.ok(validateFood(Object.create(food())).length)
    assert.ok(validateQuantity(Object.create({ amount: 50, unit: 'g' })).length)
    for (const key of ['yield', 'ingredient']) {
      const r = recipe()
      if (key === 'yield') r.yield = Object.create(r.yield)
      else r.ingredients[0] = Object.create(r.ingredients[0])
      assert.ok(validateRecipe(r).length)
      assert.throws(() => createRecipeSnapshot(r), NutritionValidationError)
    }
  })

  it('accepts own data properties on null-prototype records', () => {
    const f = Object.assign(Object.create(null), food())
    f.nutrients = Object.assign(Object.create(null), f.nutrients)
    f.source = Object.assign(Object.create(null), f.source)
    assert.deepEqual(validateFood(f), [])
    assert.equal(nutrientsForQuantity(f, { amount: 100, unit: 'g' }).kcal, 380)
    assert.deepEqual(validateFood(JSON.parse(JSON.stringify(f))), [])
  })

  it('rejects getters on custom prototypes before reading inherited nutrient data', () => {
    let calls = 0
    const prototype = Object.defineProperty({}, 'kcal', { get() { calls++; throw new Error('must not read') } })
    const f = food({ nutrients: Object.create(prototype) })
    assert.ok(validateFood(f).some(i => i.code === 'json_plain_object_required'))
    assert.throws(() => normalizeNutrients(f.nutrients), NutritionValidationError)
    assert.equal(calls, 0)
  })

  it('rejects accessors without invoking them, including snapshot dispatch', () => {
    let calls = 0
    for (const key of ['kind', 'nutrients']) {
      const f = food()
      Object.defineProperty(f, key, { enumerable: true, get() { calls++; throw new Error('must not read') } })
      assert.ok(validateFood(f).some(i => i.code === 'json_data_property_required'))
      assert.ok(validateSnapshot(f).some(i => i.code === 'json_data_property_required'))
    }
    assert.equal(calls, 0)
  })

  it('rejects non-enumerable and symbol properties that JSON would discard', () => {
    const f = food()
    Object.defineProperty(f.nutrients, 'kcal', { value: 380, enumerable: false })
    assert.ok(validateFood(f).some(i => i.path === 'food.nutrients.kcal' && i.code === 'json_enumerable_property_required'))
    const withSymbol = food({ [Symbol('metadata')]: 'lost' })
    assert.ok(validateFood(withSymbol).some(i => i.code === 'json_symbol_key'))
  })

  it('rejects metadata cycles on all exported record validators with a structured path', () => {
    const snapshot = createRecipeSnapshot(recipe())
    const template = { schemaVersion: 1, id: 't', name: 'Meal', items: [{ id: 'i', snapshot: food(), quantity: { amount: 50, unit: 'g' } }] }
    const goal = { schemaVersion: 1, id: 'g', start: '2026-10-10', mode: 'bulk', targets: { kcal: 2800 } }
    for (const [validate, value] of [[validateFood, food()], [validateRecipe, recipe()],
      [validateSnapshot, snapshot], [validateFoodEntry, entry()], [validateMealTemplate, template],
      [validateNutritionGoal, goal], [validateQuantity, { amount: 50, unit: 'g' }]]) {
      value.extra = { loop: value }
      const issues = validate(value)
      assert.ok(issues.some(i => i.path.endsWith('.extra.loop') && i.code === 'json_circular_reference'))
    }
  })
})
