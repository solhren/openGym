import assert from 'node:assert/strict'
import { test } from 'vitest'
import { performance } from 'node:perf_hooks'
import { environment, scope, entry } from './sync.test-util.js'
import { encodePartition } from './serialization.js'
import { library } from './persistence.test-util.js'
import { createRecipeSnapshot } from './recipe.js'
import { recipe } from './fixtures.test-util.js'

test('Nutrition sync preserves a ten-year partitioned recipe history and sends only the changed month', async () => {
  const f = await environment(), a = await f.client(), b = await f.client('b')
  const parts = [], snapshot = createRecipeSnapshot(recipe())
  let count = 0
  for (let year = 2016; year < 2026; year++) for (let month = 1; month <= 12; month++) {
    const prefix = `${year}-${String(month).padStart(2, '0')}`, date = new Date(`${prefix}-01T00:00:00Z`)
    const rows = []
    while (date.toISOString().slice(0, 7) === prefix) {
      const d = date.toISOString().slice(0, 10)
      rows.push(entry({ id: `entry-${++count}`, d, snapshot, quantity: { amount: 1, unit: 'serving' } }))
      date.setUTCDate(date.getUTCDate() + 1)
    }
    parts.push(await encodePartition({ ...scope, id: `journal-${prefix}-device-a-0`, kind: 'journal', records: { foodEntries: rows },
      sync: { revision: 0, writeId: null, edits: [], tombstones: [] } }))
  }
  parts.push(await encodePartition(library(scope)))
  await a.store.commit({ commitId: 'ten-years-offline', partitions: parts })
  const start = performance.now(), result = await a.makeSync().run(), duration = performance.now() - start
  assert.equal(result.status, 'synced'); assert.equal((await a.store.read()).pendingOperations.length, 0)
  assert.equal(f.calls.filter(c => c.method === 'PUT').length, 121)
  assert.equal((await b.makeSync().run()).status, 'synced')
  const copied = await b.store.read()
  assert.equal(copied.domains.flatMap(p => p.records.foodEntries ?? []).length, count)
  assert.deepEqual(copied.domains[0].records.foodEntries[0].snapshot, snapshot)
  assert.deepEqual(copied.domains.find(p => p.kind === 'library').records, library(scope).records)
  const before = f.calls.length
  assert.equal((await a.makeSync().run()).status, 'synced')
  assert.equal(f.calls.slice(before).filter(c => c.path.includes('/partitions/')).length, 0)
  const current = structuredClone((await a.store.read()).domains.find(p => p.kind === 'journal'))
  current.records.foodEntries.push(entry({ id: 'new-after-ten-years', d: current.records.foodEntries[0].d }))
  current.sync.revision++; current.sync.writeId = 'new-after-ten-years'
  current.sync.edits.push({ collection: 'foodEntries', id: 'new-after-ten-years', stamp: { counter: 100, deviceId: 'a' } })
  await a.commit(current)
  const changed = f.calls.length
  assert.equal((await a.makeSync().run()).status, 'synced')
  assert.equal(f.calls.slice(changed).filter(c => c.method === 'PUT').length, 1)
  await a.store.collect(); await a.reopen()
  assert.equal((await a.store.verify()).records, count + 1)
  console.info(JSON.stringify({ nutritionSyncVolume: { years: 10, entries: count, partitions: parts.length,
    initialSyncMs: Math.round(duration), heapUsedMiB: Math.round(process.memoryUsage().heapUsed / 1048576),
    note: 'Vitest process heap, no forced GC; not a mobile/browser peak measurement' } }))
}, 300000)
