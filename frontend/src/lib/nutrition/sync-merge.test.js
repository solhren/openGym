import assert from 'node:assert/strict'
import { test } from 'vitest'
import { mergeNutritionDomains } from './sync-merge.js'
import { preserveHistory } from '../../../../api/nutrition/core/history.js'
import { encodePartition, decodePartition } from './serialization.js'
import { hasCode } from './persistence.test-util.js'
import { markedDomain, marker, entry } from './sync.test-util.js'

const merge = (remote, local) => mergeNutritionDomains({ remote, local, writeId: 'resolution' })
const edited = (value, counter, device, fields) => markedDomain({ records: { foodEntries: [value] },
  sync: { revision: 1, writeId: device, edits: [marker(value.id, counter, device, fields)], tombstones: [] } })

test('Nutrition merges additions across stable partitions and deduplicates identical entity ids', async () => {
  const a = markedDomain(), b = markedDomain({ id: 'journal-2026-10-device-b-0', records: { foodEntries: [entry({ id: 'b' })] },
    sync: { revision: 0, writeId: null, edits: [marker('b', 2, 'b')], tombstones: [] } })
  const result = await merge([a], [b])
  assert.equal(result.domains.flatMap(p => p.records.foodEntries ?? []).length, 2)
  assert.equal((await merge([a], [{ ...a, id: b.id }])).domains.flatMap(p => p.records.foodEntries ?? []).length, 1)
})
test('Nutrition preserves independent field edits and retains complete conflicting source records', async () => {
  const base = { quantity: { counter: 1, deviceId: 'base' }, meal: { counter: 1, deviceId: 'base' } }
  const a = edited(entry({ quantity: { amount: 80, unit: 'g' } }), 5, 'a', { ...base, quantity: { counter: 5, deviceId: 'a' } })
  const b = edited(entry({ meal: 'dinner' }), 6, 'b', { ...base, meal: { counter: 6, deviceId: 'b' } })
  const result = await merge([a], [b]), row = result.domains[0].records.foodEntries[0]
  assert.equal(row.quantity.amount, 80); assert.equal(row.meal, 'dinner')
  const archive = Object.values(result.domains[0].extensions.nutritionSyncConflicts.records)
  assert.equal(archive.length, 2); assert.deepEqual(archive.map(v => v.record), [a.records.foodEntries[0], b.records.foodEntries[0]])
  preserveHistory([a], result.domains); preserveHistory([b], result.domains)
  assert.deepEqual(await decodePartition(await encodePartition(result.domains[0])), result.domains[0])
})
test('Nutrition resolves equal counters from different devices with an advancing deterministic stamp', async () => {
  const a = edited(entry({ meal: 'lunch' }), 5, 'a'), b = edited(entry({ meal: 'dinner' }), 5, 'b')
  const ab = await merge([a], [b]), ba = await merge([b], [a])
  assert.deepEqual(ab.domains, ba.domains)
  assert.equal(ab.domains[0].sync.edits[0].stamp.counter, 6)
  assert.equal(ab.domains[0].records.foodEntries[0].meal, 'dinner')
})
test('Nutrition resolves divergent values with identical stamps without regressing field clocks', async () => {
  const a = edited(entry({ meal: 'lunch' }), 5, 'a', { meal: { counter: 8, deviceId: 'a' } })
  const b = edited(entry({ meal: 'dinner' }), 5, 'a', { meal: { counter: 8, deviceId: 'a' } })
  const result = await merge([a], [b])
  assert.equal(result.domains[0].sync.edits[0].fields.meal.counter, 9)
  preserveHistory([a, b], result.domains)
})
test('Nutrition permanent deletion wins over a long-offline edit and archives its snapshot', async () => {
  const a = edited(entry(), 200, 'long-offline'), b = markedDomain({ records: { foodEntries: [] },
    sync: { revision: 1, writeId: 'deletion', edits: [], tombstones: [marker('entry-a', 3, 'b')] } })
  const result = await merge([b], [a])
  assert.equal(result.domains[0].records.foodEntries?.length ?? 0, 0)
  assert.equal(result.domains[0].sync.tombstones[0].stamp.counter, 200)
  assert.deepEqual(Object.values(result.domains[0].extensions.nutritionSyncConflicts.records)[0].record.snapshot, entry().snapshot)
  preserveHistory([a, b], result.domains)
})
test('Nutrition does not guess when an existing divergent record has no modification marker', async () => {
  const a = markedDomain(), b = markedDomain({ records: { foodEntries: [entry({ meal: 'dinner' })] },
    sync: { revision: 1, writeId: 'b', edits: [], tombstones: [] } })
  await assert.rejects(merge([a], [b]), hasCode('untracked_sync_conflict'))
})
test('Nutrition seeds previously unmarked new ids from their durable operation stamp', async () => {
  const a = markedDomain({ sync: { revision: 0, writeId: null, edits: [], tombstones: [] } })
  const result = await mergeNutritionDomains({ remote: [], local: [a], localStamp: { counter: 4, deviceId: 'a' }, writeId: 'seed' })
  assert.deepEqual(result.domains[0].sync.edits[0].stamp, { counter: 4, deviceId: 'a' })
})
test('Nutrition keeps removed optional values and their markers rather than pruning history', async () => {
  const a = edited(entry({ metadata: { note: 'kept' } }), 5, 'a', { metadata: { counter: 5, deviceId: 'a' } })
  const b = edited(entry(), 6, 'b')
  const result = await merge([a], [b])
  assert.deepEqual(result.domains[0].records.foodEntries[0].metadata, { note: 'kept' })
  preserveHistory([a, b], result.domains)
})
test('Nutrition refuses unknown divergent extensions and overflow without weakening validation', async () => {
  await assert.rejects(merge([{ ...markedDomain(), extensions: { future: 'a' } }], [{ ...markedDomain(), extensions: { future: 'b' } }]), hasCode('extension_conflict'))
  await assert.rejects(merge([edited(entry({ meal: 'lunch' }), Number.MAX_SAFE_INTEGER, 'a')],
    [edited(entry({ meal: 'dinner' }), Number.MAX_SAFE_INTEGER, 'b')]), hasCode('counter_overflow'))
})
test('Nutrition rejects invalid combinations created by independent atomic field merges', async () => {
  const a = edited(entry({ snapshot: { ...entry().snapshot, reference: { amount: 100, unit: 'ml' } }, quantity: { amount: 50, unit: 'ml' } }), 5, 'a',
    { snapshot: { counter: 5, deviceId: 'a' }, quantity: { counter: 1, deviceId: 'base' } })
  const b = edited(entry({ quantity: { amount: 70, unit: 'g' } }), 6, 'b',
    { snapshot: { counter: 1, deviceId: 'base' }, quantity: { counter: 6, deviceId: 'b' } })
  await assert.rejects(merge([a], [b]))
})

test('Nutrition whole-record resolution respects a stronger field clock', async () => {
  const a = edited(entry({ quantity: { amount: 80, unit: 'g' } }), 5, 'a', { quantity: { counter: 100, deviceId: 'a' } })
  const b = edited(entry({ meal: 'dinner' }), 6, 'b')
  const result = await merge([a], [b])
  assert.equal(result.domains[0].records.foodEntries[0].quantity.amount, 80)
  assert.equal(result.domains[0].sync.edits[0].fields.quantity.counter, 100)
  assert.equal(result.domains[0].sync.edits[0].stamp.counter, 100)
  preserveHistory([a, b], result.domains)
})
