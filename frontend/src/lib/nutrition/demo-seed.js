import { encodePartition } from './serialization.js'
import { check, journalPartitionId, libraryPartitionId } from './persistence-contract.js'

/** Synthetic examples, not a food catalogue or dietary advice. Kept out of normal builds.
 * Names are French/English; nutrient values deliberately exercise g, ml and unknowns. */
export function demoNutritionRecords(day, locale = 'en') {
  const fr = locale.startsWith('fr')
  const names = fr ? ['Flocons d’avoine', 'Lait', 'Banane', 'Yaourt', 'Porridge'] : ['Oats', 'Milk', 'Banana', 'Yogurt', 'Porridge']
  const food = (id, i, unit, nutrients) => ({ schemaVersion: 1, kind: 'food', id: `demo-${id}`,
    name: `${names[i]} · Demo`, reference: { amount: 100, unit }, nutrients,
    portions: [], source: { kind: 'custom' } })
  const foods = [
    food('oats', 0, 'g', { kcal: 380, protein: 13, carbs: 60, fat: 7 }),
    food('milk', 1, 'ml', { kcal: 60, protein: 3, carbs: 5, fat: 3 }),
    food('banana', 2, 'g', { kcal: 90, protein: 1, carbs: 20, fat: 0.3 }),
    food('yogurt', 3, 'g', { kcal: 70, protein: 4, carbs: null, fat: 3 }),
  ]
  const recipe = { schemaVersion: 1, id: 'demo-porridge', name: `${names[4]} · Demo`,
    ingredients: [
      { id: 'oats', food: foods[0], quantity: { amount: 40, unit: 'g' } },
      { id: 'milk', food: foods[1], quantity: { amount: 150, unit: 'ml' } },
    ], yield: { servings: 1 } }
  return {
    library: { customFoods: foods, recipes: [recipe] },
    journal: { foodEntries: [
      { schemaVersion: 1, id: 'demo-breakfast-oats', d: day, meal: 'breakfast', snapshot: foods[0], quantity: { amount: 40, unit: 'g' } },
      { schemaVersion: 1, id: 'demo-breakfast-milk', d: day, meal: 'breakfast', snapshot: foods[1], quantity: { amount: 150, unit: 'ml' } },
    ] },
  }
}

/** Initialize only a genuinely empty demo scope, in ONE durable CAS publication. The head
 * itself is the seed marker: deleting examples or clearing localStorage never re-seeds an
 * existing journal. Concurrent first tabs cannot overwrite one another's edits. */
export async function seedDemoNutrition(store, { day, locale, guard = () => {} }) {
  check(store.scope.namespace.serverOrigin === null && store.scope.namespace.profileId.startsWith('demo-'), 'demo', 'demo_scope_required')
  guard()
  const meta = await store.inspect()
  guard()
  check(meta.status !== 'recovery-required', 'demo', 'recovery_required')
  if (meta.head !== null) return { seeded: false }
  const records = demoNutritionRecords(day, locale)
  const stamp = { counter: 1, deviceId: store.deviceId }, commitId = 'demo-initial-v1'
  const partitions = []
  for (const kind of ['library', 'journal']) {
    const rows = records[kind]
    partitions.push(await encodePartition({
      ...store.scope, kind, id: kind === 'library' ? libraryPartitionId('demo') : journalPartitionId(day.slice(0, 7), 'demo'),
      records: rows, sync: { revision: 1, writeId: commitId, tombstones: [],
        edits: Object.entries(rows).flatMap(([collection, values]) => values.map(value => ({ collection, id: value.id, stamp }))) },
    }))
  }
  guard()
  try {
    await store.commit({ commitId, expectedHead: null, partitions }, { guard })
    return { seeded: true }
  } catch (error) {
    if (!error.issues?.some(issue => ['stale_root', 'reused_commit_id'].includes(issue.code))) throw error
    // Another tab won. Do not change its values or manufacture a second seed.
    const winner = await store.inspect()
    guard()
    check(winner.status !== 'recovery-required' && winner.head !== null, 'demo', 'recovery_required')
    return { seeded: false }
  }
}
