import { test, expect } from 'vitest'
import { food, entry, recipe } from './fixtures.test-util.js'
import { validateFoodEntry } from './validate.js'
import { nutrientsForQuantity } from './calculate.js'
import {
  DEFAULT_WATER_TARGET_ML,
  isWaterEntry,
  isQuickAddEntry,
  createWaterSnapshot,
  createWaterEntry,
  sumWaterEntries,
  createQuickAddEntry,
  buildMealCopyCommands,
  rankMealCandidates,
} from './meal-helpers.js'

test('water helpers build valid entries, convert volume units to ml, and preserve chronological undo order', () => {
  expect(DEFAULT_WATER_TARGET_ML).toBe(2500)
  const w1 = createWaterEntry({ id: 'w-1', date: '2026-10-10', ml: 250 })
  expect(isWaterEntry(w1)).toBe(true)
  expect(isQuickAddEntry(w1)).toBe(false)
  expect(validateFoodEntry(w1)).toEqual([])

  const w2 = { ...createWaterEntry({ id: 'w-2', date: '2026-10-10', ml: 500 }), quantity: { amount: 50, unit: 'cl' } }
  const w3 = { ...createWaterEntry({ id: 'w-3', date: '2026-10-10', ml: 1000 }), quantity: { amount: 1, unit: 'l' } }
  const w4 = { ...createWaterEntry({ id: 'w-4', date: '2026-10-10', ml: 200 }), quantity: { amount: 2, unit: 'dl' } }

  const regular = entry({ id: 'food-1', d: '2026-10-10' })
  expect(isWaterEntry(regular)).toBe(false)

  const summary = sumWaterEntries([w1, regular, w2, w3, w4])
  expect(summary.totalMl).toBe(1950)
  expect(summary.entries.map(e => e.id)).toEqual(['w-1', 'w-2', 'w-3', 'w-4'])
  expect(summary.entries.at(-1).id).toBe('w-4')

  // Timestamped entries sort chronologically for undo
  const late = createWaterEntry({ id: 'w-late', date: '2026-10-10', ml: 300, consumedAt: '2026-10-10T18:00:00Z' })
  const early = createWaterEntry({ id: 'w-early', date: '2026-10-10', ml: 200, consumedAt: '2026-10-10T08:00:00Z' })
  expect(sumWaterEntries([late, early]).entries.map(e => e.id)).toEqual(['w-early', 'w-late'])

  expect(() => createWaterEntry({ date: '2026-10-10', ml: 0 })).toThrow()
  expect(() => createWaterEntry({ date: '2026-10-10', ml: -250 })).toThrow()
  expect(createWaterSnapshot().id).toBe('opengym-water')
})

test('quick add helper handles large macro totals (>100g) and preserves existing keys on edit', () => {
  const created = createQuickAddEntry({
    id: 'qa-1',
    date: '2026-10-10',
    meal: 'dinner',
    name: '  Burger & frites  ',
    kcal: 1450,
    protein: 65,
    carbs: 185,
    fat: 52,
    fiber: 11,
    note: 'resto',
  })

  expect(isQuickAddEntry(created)).toBe(true)
  expect(isWaterEntry(created)).toBe(false)
  expect(created.snapshot.name).toBe('Burger & frites')
  expect(created.snapshot.reference.amount).toBe(314)
  expect(validateFoodEntry(created)).toEqual([])
  expect(nutrientsForQuantity(created.snapshot, created.quantity)).toEqual({
    kcal: 1450,
    protein: 65,
    carbs: 185,
    fat: 52,
    fiber: 11,
    sugar: null,
    saturatedFat: null,
    sodium: null,
  })

  // Blank name defaults to 'Ajout rapide'; editing preserves existing fields (no field erasure)
  const edited = createQuickAddEntry({
    existing: { ...created, consumedAt: '2026-10-10T20:15:00Z' },
    date: '2026-10-10',
    meal: 'dinner',
    name: '   ',
    kcal: 900,
    protein: null,
  })
  expect(edited.id).toBe('qa-1')
  expect(edited.snapshot.id).toBe(created.snapshot.id)
  expect(edited.snapshot.name).toBe('Ajout rapide')
  expect(edited.consumedAt).toBe('2026-10-10T20:15:00Z')
  expect(edited.snapshot.nutrients.protein).toBeNull()
  expect(validateFoodEntry(edited)).toEqual([])

  expect(() => createQuickAddEntry({ date: '2026-10-10', meal: 'lunch', kcal: -10 })).toThrow()
})

test('meal copy helper builds valid batch commands while excluding water entries and cloning snapshots', () => {
  const breakfast1 = entry({ id: 'b1', d: '2026-10-09', meal: 'breakfast', note: 'chaud' })
  const lunch1 = entry({ id: 'l1', d: '2026-10-09', meal: 'lunch' })
  const quick1 = createQuickAddEntry({ id: 'q1', date: '2026-10-09', meal: 'breakfast', name: 'Café latte', kcal: 140 })
  const water1 = createWaterEntry({ id: 'w1', date: '2026-10-09', ml: 500 })

  let seq = 0
  const cmds = buildMealCopyCommands({
    entries: [breakfast1, lunch1, quick1, water1],
    sourceMeal: 'breakfast',
    targetDate: '2026-10-10',
    targetMeal: 'snack',
    idFactory: () => `copy-${++seq}`,
  })

  expect(cmds).toHaveLength(2)
  expect(cmds[0]).toMatchObject({
    collection: 'foodEntries',
    id: 'copy-1',
    base: null,
    value: {
      id: 'copy-1',
      d: '2026-10-10',
      meal: 'snack',
      copiedFromEntryId: 'b1',
      note: 'chaud',
    },
  })
  expect(cmds[1].value.entryKind).toBe('quick')
  expect(cmds[1].value.copiedFromEntryId).toBe('q1')
  expect(cmds[0].value.snapshot).not.toBe(breakfast1.snapshot)
  for (const c of cmds) expect(validateFoodEntry(c.value)).toEqual([])
})

test('rankMealCandidates scores meal habits, recalls last compatible portion, excludes water/quick-add, and boosts prefix queries', () => {
  const oats = food({
    id: 'oats',
    name: 'Flocons d’avoine',
    portions: [{ id: 'bowl', label: 'Bol', amount: 80, unit: 'g' }],
  })
  const skyr = food({ id: 'skyr', name: 'Skyr nature', brand: 'Danone' })
  const bananaBread = food({ id: 'cake', name: 'Gâteau banane' })
  const banana = food({ id: 'banana', name: 'Banane' })
  const porridge = recipe({ id: 'rec-porridge', name: 'Porridge protéiné' })
  const archivedSnap = food({ id: 'deleted-lib-food', name: 'Miel d’acacia' })

  const recentEntries = [
    entry({ id: 'e1', d: '2026-10-08', meal: 'breakfast', snapshot: oats, quantity: { amount: 65, unit: 'g' } }),
    entry({ id: 'e2', d: '2026-10-09', meal: 'breakfast', snapshot: oats, quantity: { amount: 1, unit: 'portion', portionId: 'bowl' } }),
    // Same latest date (2026-10-09) in dinner with 120g -> breakfast query should still prefer the breakfast portion ('bowl')!
    entry({ id: 'e3', d: '2026-10-09', meal: 'dinner', snapshot: oats, quantity: { amount: 120, unit: 'g' } }),
    entry({ id: 'e4', d: '2026-10-09', meal: 'dinner', snapshot: skyr, quantity: { amount: 150, unit: 'g' } }),
    entry({ id: 'e5', d: '2026-10-07', meal: 'breakfast', snapshot: archivedSnap, quantity: { amount: 15, unit: 'g' } }),
    createWaterEntry({ id: 'w-ignore', date: '2026-10-09', ml: 500 }),
    createQuickAddEntry({ id: 'q-ignore', date: '2026-10-09', meal: 'breakfast', kcal: 300 }),
  ]

  // Duplicate e2 in todayEntries should not double-count
  const rankedBreakfast = rankMealCandidates({
    foods: [oats, skyr, bananaBread, banana],
    recipes: [porridge],
    recentEntries,
    todayEntries: [recentEntries[1]],
    meal: 'breakfast',
    referenceDate: '2026-10-10',
  })

  expect(rankedBreakfast.some(c => c.snapshot.id === 'opengym-water')).toBe(false)
  expect(rankedBreakfast.some(c => c.snapshot.id.startsWith('quick-'))).toBe(false)

  // Oats logged twice at breakfast + once at dinner => top candidate for breakfast
  expect(rankedBreakfast[0]).toMatchObject({
    key: 'food:oats',
    mealCount: 2,
    totalCount: 3,
    lastDate: '2026-10-09',
    isHabit: true,
    suggestedQuantity: { amount: 1, unit: 'portion', portionId: 'bowl' },
  })

  // Archived food not in library still surfaces from recent entries
  expect(rankedBreakfast.some(c => c.key === 'food:deleted-lib-food' && c.isHabit)).toBe(true)
  // Recipe candidate has default 1 serving quantity
  const recCand = rankedBreakfast.find(c => c.key === 'recipe:rec-porridge')
  expect(recCand.suggestedQuantity).toEqual({ amount: 1, unit: 'serving' })

  // If library food removes a legacy portion, suggestedQuantity falls back safely
  const oatsWithoutPortion = food({ id: 'oats', name: 'Flocons d’avoine', portions: [], defaultQuantity: { amount: 50, unit: 'g' } })
  const fallbackRanked = rankMealCandidates({
    foods: [oatsWithoutPortion],
    recentEntries: [recentEntries[1]],
    meal: 'breakfast',
  })
  expect(fallbackRanked[0].suggestedQuantity).toEqual({ amount: 50, unit: 'g' })

  // Query filtering: prefix match ('Banane') ranks above substring match ('Gâteau banane') even if substring was logged once
  const queryRanked = rankMealCandidates({
    foods: [bananaBread, banana],
    recentEntries: [entry({ id: 'e-cake', d: '2026-10-09', meal: 'breakfast', snapshot: bananaBread, quantity: { amount: 80, unit: 'g' } })],
    meal: 'breakfast',
    query: 'ban',
    locale: 'fr',
  })
  expect(queryRanked.map(c => c.key)).toEqual(['food:banana', 'food:cake'])
})
