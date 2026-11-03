import { test, expect } from 'vitest'
import { backupFixture } from '../backup.test-util.js'
import { createNutritionCommands } from '../ui-service.js'
import { normalizeProduct } from './normalize.js'
import { offProduct } from './fixtures.test-util.js'
const intake = (food, id = 'off-intake') => ({ schemaVersion: 1, id, d: '2026-10-10', meal: 'dinner', snapshot: food, quantity: { amount: 50, unit: 'g' } })
const batch = row => [{ collection: 'savedFoods', id: row.snapshot.id, value: row.snapshot, base: null }, { collection: 'foodEntries', id: row.id, value: row, base: null }]
for (const kind of ['idb', 'fs']) {
  test(`${kind}: provider product/intake publish together, replay no-op, snapshot remains stable after new revision`, async () => {
    const f = await backupFixture(kind), cmd = createNutritionCommands({ store: f.store }), a = (await normalizeProduct(offProduct())).food, first = intake(a)
    await cmd.batch(batch(first)); await f.store.beginPending(); const head = (await f.store.inspect()).head; await cmd.batch(batch(first)); expect((await f.store.inspect()).head).toEqual(head)
    const b = (await normalizeProduct(offProduct({ nutriments: { 'energy-kcal_100g': 100 } }))).food
    await cmd.batch(batch(intake(b, 'off-intake-2'))); await f.reopen()
    const rows = (await f.store.readDay(first.d)).entries; expect(rows.find(r => r.id === first.id).snapshot.nutrients.kcal).toBe(539)
    expect(rows.find(r => r.id !== first.id).snapshot.nutrients.kcal).toBe(100); expect((await f.store.read()).pendingOperations.length).toBe(2)
    await createNutritionCommands({ store: f.store }).remove('foodEntries', rows[0]); expect((await f.store.readLibrary()).domains.flatMap(p => p.records.savedFoods ?? [])).toHaveLength(2)
  })
}
test('two device connections publishing same product keep both intakes and a single library revision', async () => {
  const f = await backupFixture(), other = await f.fork(), value = (await normalizeProduct(offProduct())).food
  const a = createNutritionCommands({ store: f.store }), b = createNutritionCommands({ store: other })
  await Promise.all([a.batch(batch(intake(value, 'a'))), b.batch(batch(intake(value, 'b')))])
  expect((await f.store.readDay('2026-10-10')).entries).toHaveLength(2)
  expect((await f.store.readLibrary()).domains.flatMap(p => p.records.savedFoods ?? [])).toHaveLength(1)
  expect((await f.store.read()).pendingOperations.length).toBeGreaterThan(0); other.close()
})
for (let phase = 1; phase <= 5; phase++) {
  test(`IDB interruption/quota phase ${phase} cannot publish half a product/intake or discard previous outbox`, async () => {
    const f = await backupFixture(), cmd = createNutritionCommands({ store: f.store }), value = (await normalizeProduct(offProduct())).food
    await cmd.batch(batch(intake(value, 'previous'))); const prior = (await f.store.read()).pendingOperations.length
    f.control.failAt = f.control.operations + phase
    try { await cmd.batch(batch(intake((await normalizeProduct(offProduct({ brands: 'New brand' }))).food, 'next'))) } catch (error) { expect(error.issues?.some(i => i.code === 'quota_exceeded')).toBe(true) }
    f.control.failAt = null; await f.reopen(); const state = await f.store.read()
    expect(state.pendingOperations.length).toBeGreaterThanOrEqual(prior)
    const library = state.domains.flatMap(p => p.records.savedFoods ?? []), rows = state.domains.flatMap(p => p.records.foodEntries ?? [])
    expect(rows.some(r => r.id === 'previous')).toBe(true); expect(library.some(v => v.brand === 'New brand')).toBe(rows.some(r => r.id === 'next'))
  })
}
test('provider records are validated, not a bypass through the new UI allowlist', async () => {
  const f = await backupFixture(), cmd = createNutritionCommands({ store: f.store }), value = (await normalizeProduct(offProduct())).food
  await expect(cmd.batch(batch(intake({ ...value, nutrients: { protein: -1 } })))).rejects.toThrow()
  expect((await f.store.readDay('2026-10-10')).entries).toHaveLength(0)
})

test('OFF attribution and immutable revisions round-trip through actual Nutrition backup', async () => {
  const { readNutritionBackup } = await import('../backup.js'), f = await backupFixture(), value = (await normalizeProduct(offProduct())).food
  await createNutritionCommands({ store: f.store }).batch(batch(intake(value)))
  const exported = await f.service().export(), restored = await readNutritionBackup(exported.blob)
  const saved = restored.current.flatMap(p => p.records.savedFoods ?? []), rows = restored.current.flatMap(p => p.records.foodEntries ?? [])
  expect(saved[0]).toEqual(value); expect(rows[0].snapshot.source).toEqual(value.source); expect(rows[0].snapshot.nutrients.kcal).toBe(539)
})

test('two actual devices synchronize external products and snapshots using existing server publication protocol', async () => {
  const { environment } = await import('../sync.test-util.js'), env = await environment(), a = await env.client('a'), b = await env.client('b'), value = (await normalizeProduct(offProduct())).food
  const cmdA = createNutritionCommands({ store: a.store }), cmdB = createNutritionCommands({ store: b.store })
  await cmdA.batch(batch(intake(value, 'device-a'))); await cmdB.batch(batch(intake(value, 'device-b')))
  expect((await a.makeSync().run()).status).toBe('synced'); expect((await b.makeSync().run()).status).toBe('synced'); await a.makeSync().run()
  expect((await a.store.readDay('2026-10-10')).entries).toHaveLength(2); expect((await b.store.readDay('2026-10-10')).entries).toHaveLength(2)
  expect((await a.store.readLibrary()).domains.flatMap(p => p.records.savedFoods ?? []).every(f => f.source.license.id === 'ODbL-1.0')).toBe(true)
  expect((await a.store.read()).pendingOperations).toHaveLength(0); expect((await b.store.read()).pendingOperations).toHaveLength(0)
})
