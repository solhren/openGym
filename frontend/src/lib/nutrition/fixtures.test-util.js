export const food = (overrides = {}) => ({
  schemaVersion: 1, kind: 'food', id: 'oats', name: 'Oats',
  reference: { amount: 100, unit: 'g' },
  nutrients: { kcal: 380, protein: 13, carbs: 60, fat: 7, fiber: 10, sugar: 1, saturatedFat: 1, sodium: 0 },
  portions: [{ id: 'scoop', label: 'Scoop', amount: 40, unit: 'g' }],
  source: { kind: 'custom' },
  ...overrides,
})

export const entry = (overrides = {}) => ({
  schemaVersion: 1, id: 'entry-1', d: '2026-10-10', meal: 'breakfast',
  snapshot: food(), quantity: { amount: 50, unit: 'g' }, ...overrides,
})

export const recipe = (overrides = {}) => ({
  schemaVersion: 1, id: 'porridge', name: 'Porridge',
  ingredients: [
    { id: 'oats', food: food(), quantity: { amount: 100, unit: 'g' } },
    { id: 'milk', food: food({
      id: 'milk', name: 'Milk', reference: { amount: 100, unit: 'ml' }, portions: [],
      nutrients: { kcal: 60, protein: 3, carbs: 5, fat: 3, fiber: 0, sugar: 5, saturatedFat: 2, sodium: 0.04 },
    }), quantity: { amount: 200, unit: 'ml' } },
  ],
  yield: { servings: 2, grams: 280 }, ...overrides,
})

export function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}

export const close = (actual, expected, tolerance = 1e-10) => {
  if (Math.abs(actual - expected) > tolerance || !Number.isFinite(actual)) {
    throw new Error(`Expected ${actual} to be within ${tolerance} of ${expected}`)
  }
}
