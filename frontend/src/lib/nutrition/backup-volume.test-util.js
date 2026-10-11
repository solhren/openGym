import { entry, recipe, food } from './fixtures.test-util.js'
import { createRecipeSnapshot } from './recipe.js'
import { encodePartition, decodePartition } from './serialization.js'

/** Fixed ten-year corpus, shared by correctness tests and isolated-process measurements. */
export async function tenYearBackupFixture(store) {
  const { namespace, generation } = store.scope
  const snapshot = createRecipeSnapshot(recipe()), partitions = []
  let count = 0
  for (let year = 2016; year <= 2025; year++) for (let month = 1; month <= 12; month++) {
    const prefix = `${year}-${String(month).padStart(2, '0')}`, date = new Date(`${prefix}-01T00:00:00Z`), rows = []
    while (date.toISOString().slice(0, 7) === prefix) {
      for (let meal = 0; meal < 3; meal++) rows.push(entry({ id: `entry-${++count}`, d: date.toISOString().slice(0, 10), snapshot, quantity: { amount: 1, unit: 'serving' } }))
      date.setUTCDate(date.getUTCDate() + 1)
    }
    partitions.push(await encodePartition({ namespace, generation, id: `journal-${prefix}-ten-years`, kind: 'journal', records: { foodEntries: rows },
      sync: { revision: 0, writeId: null, edits: [], tombstones: [{ collection: 'foodEntries', id: `deleted-${prefix}`, stamp: { counter: 1, deviceId: 'a' } }] } }))
  }
  for (let i = 0; i < 10; i++) partitions.push(await encodePartition({ namespace, generation, id: `library-volume-${i}`, kind: 'library',
    records: { customFoods: Array.from({ length: 20 }, (_, n) => food({ id: `food-${i}-${n}` })),
      recipes: Array.from({ length: 10 }, (_, n) => recipe({ id: `recipe-${i}-${n}` })), savedFoods: [], mealTemplates: [], nutritionGoals: [] },
    sync: { revision: 0, writeId: null, edits: [], tombstones: [] } }))
  await store.commit({ commitId: 'ten-years', partitions }); await store.beginPending()
  const decoded = await decodePartition(partitions[119]); decoded.sync.revision++; decoded.sync.writeId = 'latest'; decoded.records.foodEntries[0].quantity.amount = 2
  decoded.sync.edits.push({ collection: 'foodEntries', id: decoded.records.foodEntries[0].id, stamp: { counter: 100, deviceId: 'a' } })
  await store.commit({ commitId: 'latest', partitions: [await encodePartition(decoded)] })
  return { years: 10, entries: count, partitions: partitions.length, customFoods: 200, recipes: 100, tombstones: 120, offlineCheckpoints: 2 }
}
