import { test, expect } from 'vitest'
import { backupFixture } from './backup.test-util.js'
import { food, entry, recipe } from './fixtures.test-util.js'
import { hasCode } from './persistence.test-util.js'
import { createNutritionCommands, nutritionNumber, quantityOptions, quantityValue, editedQuantity, daySummary, historyDays, nutritionSearchText } from './ui-service.js'
import { createRecipeSnapshot } from './recipe.js'
import { encodePartition } from './serialization.js'
import { jsonClone, libraryPartitionId } from './persistence-contract.js'

test('form parsing preserves unknown and zero, accepts decimal comma, rejects lossy sanitization', () => {
  expect(nutritionNumber('', true)).toBeNull(); expect(nutritionNumber('0')).toBe(0); expect(nutritionNumber(' 1,5 ')).toBe(1.5)
  for (const value of ['', '-1', 'NaN', 'Infinity', '1abc', '1.2.3', '0x10', '1e309']) expect(() => nutritionNumber(value)).toThrow()
})
test('local search folds case and diacritics without using a remote catalogue', () => {
  expect(nutritionSearchText('CRÈME', 'fr')).toBe('creme'); expect(nutritionSearchText('İNCİR', 'tr')).toBe('incir')
})
test('quantity choices require density or measured yield and named portions retain identifiers', () => {
  expect(quantityOptions(food())).not.toContain('ml'); expect(quantityOptions(food({ densityGPerMl: 1.1 }))).toContain('ml')
  expect(quantityValue('0,5', 'portion:scoop')).toEqual({ amount: .5, unit: 'portion', portionId: 'scoop' })
  expect(quantityOptions(createRecipeSnapshot(recipe({ yield: { servings: 2 } })))).toEqual(['serving'])
})
test('quantity edits preserve future metadata while removing incompatible portion ids', () => {
  expect(editedQuantity({ amount: 1, unit: 'portion', portionId: 'scoop', future: 'keep' }, '20', 'g')).toEqual({ amount: 20, unit: 'g', future: 'keep' })
})
test('history includes the final supported calendar day without advancing into an extended ISO year', () => {
  expect(historyDays([], [], '9999-12-30', '9999-12-31').map(row => row.d)).toEqual(['9999-12-30', '9999-12-31'])
})
test('goals are inclusive; overlap is explicit, zero differs from unknown and exceedances stay negative', () => {
  const goals = [{ start: '2026-10-10', end: '2026-10-10', targets: { kcal: 0 } }]
  expect(daySummary([entry()], goals, '2026-10-10').remaining.kcal).toBe(-190)
  expect(daySummary([], goals, '2026-10-11').goal).toBeNull()
  expect(daySummary([], [...goals, ...goals], '2026-10-10').overlapping).toBe(true)
  const missing = daySummary([entry({ snapshot: food({ nutrients: { protein: 5 } }) })], [], '2026-10-10')
  expect(missing.totals.kcal).toBeNull(); expect(missing.knownTotals.kcal).toBe(0); expect(missing.missing.kcal).toBe(1)
})
test('calendar history includes leap days and separates empty days from logged unknowns', () => {
  const days = historyDays([entry({ d: '2024-02-29' })], [], '2024-02-28', '2024-03-01')
  expect(days.map(d => d.d)).toEqual(['2024-02-28', '2024-02-29', '2024-03-01']); expect(days[0].count).toBe(0); expect(days[1].totals.kcal).toBe(190)
})
for (const kind of ['idb', 'fs']) {
  test(`UI ${kind}: food/recipe/entry CRUD is durable and immutable history survives library deletion`, async () => {
    const f = await backupFixture(kind), cmd = createNutritionCommands({ store: f.store })
    await cmd.save('customFoods', food()); await cmd.save('recipes', recipe())
    const row = entry({ snapshot: createRecipeSnapshot(recipe()), quantity: { amount: 1, unit: 'serving' } })
    await cmd.save('foodEntries', row)
    await cmd.save('customFoods', food({ name: 'Changed', nutrients: { kcal: 10 } }), food())
    await cmd.remove('recipes', recipe()); await f.reopen()
    expect((await f.store.readDay(row.d)).entries[0].snapshot.name).toBe('Porridge')
    expect((await f.store.readDay(row.d)).entries[0].snapshot.nutrients.kcal).toBe(500)
    const next = createNutritionCommands({ store: f.store })
    await next.save('foodEntries', { ...row, quantity: { amount: 2, unit: 'serving' } }, row)
    const updated = (await f.store.readDay(row.d)).entries[0]
    await next.remove('foodEntries', updated)
    expect((await f.store.readDay(row.d)).entries).toEqual([])
    const state = await f.store.read(); expect(state.pendingOperations.length).toBeGreaterThan(0)
    expect(state.domains.some(p => p.sync.tombstones.some(m => m.id === row.id))).toBe(true)
  })
}
test('stale form and repeated creation refuse overwriting a newer or deleted record', async () => {
  const f = await backupFixture(), cmd = createNutritionCommands({ store: f.store })
  await cmd.save('customFoods', food()); await cmd.save('customFoods', food({ name: 'New' }), food())
  await expect(cmd.save('customFoods', food({ name: 'Stale' }), food())).rejects.toSatisfy(hasCode('record_changed'))
  await expect(cmd.save('customFoods', food())).rejects.toSatisfy(hasCode('record_changed'))
  await cmd.remove('customFoods', food({ name: 'New' }))
  await expect(cmd.save('customFoods', food())).rejects.toSatisfy(hasCode('permanently_deleted_id'))
})
test('command rejection preserves queue and full validators, including inconsistent nutrients', async () => {
  const f = await backupFixture(), cmd = createNutritionCommands({ store: f.store })
  await cmd.save('foodEntries', entry()); const before = await f.store.read()
  await expect(cmd.save('customFoods', food({ nutrients: { carbs: 5, sugar: 10 } }))).rejects.toThrow()
  expect((await f.store.read()).head).toEqual(before.head); expect((await f.store.read()).pendingOperations).toEqual(before.pendingOperations)
})
test('quota failure cannot publish a partial command and retry retains its intended id', async () => {
  const f = await backupFixture(), cmd = createNutritionCommands({ store: f.store })
  f.control.failAt = 1
  await expect(cmd.save('foodEntries', entry())).rejects.toSatisfy(hasCode('quota_exceeded'))
  expect((await f.store.read()).head).toBeNull()
  f.control.failAt = null; await cmd.save('foodEntries', entry()); expect((await f.store.readDay(entry().d)).entries).toHaveLength(1)
})
test('batched commands publish one coherent revision and advanced field clocks remain monotonic', async () => {
  const f = await backupFixture(), cmd = createNutritionCommands({ store: f.store })
  await cmd.batch([entry(), entry({ id: 'entry-2' })].map(value => ({ collection: 'foodEntries', id: value.id, value, base: null })))
  const before = await f.store.read(); expect(before.pendingOperations).toHaveLength(1)
  await cmd.save('foodEntries', { ...entry(), meal: 'dinner' }, entry())
  const state = await f.store.read(), marker = state.domains[0].sync.edits.find(m => m.id === entry().id)
  expect(marker.fields.meal.counter).toBeGreaterThan(marker.fields.snapshot.counter)
  expect((await f.store.readDay(entry().d)).entries).toHaveLength(2)
})
test('an exact command replay is a no-op and JSON own prototype-named metadata cannot pollute marker objects', async () => {
  const f = await backupFixture(), cmd = createNutritionCommands({ store: f.store })
  const value = { ...food(), ...JSON.parse('{"__proto__":{"future":"keep"}}') }
  await cmd.save('customFoods', value); const head = (await f.store.read()).head
  expect((await cmd.save('customFoods', value)).repeated).toBe(true); expect((await f.store.read()).head).toEqual(head)
  await cmd.save('customFoods', { ...value, name: 'New' }, value)
  const stored = (await f.store.readLibrary()).domains[0]
  expect(Object.hasOwn(stored.records.customFoods[0], '__proto__')).toBe(true)
  expect(Object.hasOwn(stored.sync.edits[0].fields, '__proto__')).toBe(true); expect({}.future).toBeUndefined()
})
test('shard capacity includes complete field clocks and write metadata before choosing an almost-full partition', async () => {
  const f = await backupFixture(), first = food({ id: 'large', padding: '' }), second = food({ id: 'second' })
  const stamp = { counter: 1, deviceId: f.store.deviceId }, nextStamp = { ...stamp, counter: 2 }
  const fields = Object.fromEntries(Object.keys(first).filter(key => !['id', 'schemaVersion'].includes(key)).map(key => [key, stamp]))
  const domain = { ...f.store.scope, id: libraryPartitionId(`${f.store.deviceId}-0`), kind: 'library', records: { customFoods: [first] },
    sync: { revision: 1, writeId: 'seed', edits: [{ collection: 'customFoods', id: first.id, stamp, fields }], tombstones: [] } }
  const sparse = jsonClone(domain)
  sparse.records.customFoods.push(second); sparse.sync.revision = 2; sparse.sync.writeId = `ui-${'b'.repeat(32)}`
  sparse.sync.edits.push({ collection: 'customFoods', id: second.id, stamp: nextStamp })
  const sparseSize = new TextEncoder().encode(JSON.stringify(await encodePartition(sparse))).length
  first.padding = 'x'.repeat(512 * 1024 - sparseSize - 16)
  sparse.records.customFoods[0].padding = first.padding
  expect(new TextEncoder().encode(JSON.stringify(await encodePartition(sparse))).length).toBe(512 * 1024 - 16)
  await f.store.commit({ commitId: 'seed', partitions: [await encodePartition(domain)] })
  const cmd = createNutritionCommands({ store: f.store, newId: () => 'b'.repeat(32) })
  await cmd.save('customFoods', second)
  const state = await f.store.read()
  expect(state.domains).toHaveLength(2)
  expect(state.domains.flatMap(part => part.records.customFoods ?? []).map(row => row.id).sort()).toEqual(['large', 'second'])
  expect(state.domains.flatMap(part => part.records.customFoods ?? []).find(row => row.id === 'large').padding).toBe(first.padding)
})

for (const kind of ['idb', 'fs']) {
  test(`optimized ${kind} mutation rechecks unrelated history and frozen outbox despite a warm UI cache`, async () => {
    const f = await backupFixture(kind), cmd = createNutritionCommands({ store: f.store })
    const old = entry({ id: 'old', d: '2020-01-01' }), recent = entry()
    await cmd.save('foodEntries', old); const flight = await f.store.beginPending()
    await cmd.save('foodEntries', recent)
    await f.store.readDay(recent.d) // Neither this hit nor the next command can authorize damaged unrelated bytes.
    const key = `p-${flight.operation.partitions[0].digest}`
    if (kind === 'idb') f.control.databases.values().next().value.stores.get('documents').set(key, '{truncated')
    else {
      const { writeFile } = await import('node:fs/promises'), { join } = await import('node:path')
      await writeFile(join(f.control.base, f.store.scopeId, key + '.json'), '{truncated')
    }
    const before = await f.store.inspect()
    await expect(cmd.save('foodEntries', { ...recent, note: 'must fail' }, recent)).rejects.toThrow()
    expect((await f.store.inspect()).head).toEqual(before.head)
    expect((await f.store.inspect()).manifest.pendingOperations).toEqual(before.manifest.pendingOperations)
  })
  test(`optimized ${kind} mutation rebases a different concurrent edit without losing either command or frozen operation`, async () => {
    const f = await backupFixture(kind), a = createNutritionCommands({ store: f.store }), b = createNutritionCommands({ store: await f.fork() })
    const first = entry(), second = entry({ id: 'second' })
    await a.batch([first, second].map(value => ({ collection: 'foodEntries', id: value.id, value, base: null })))
    const frozen = await f.store.beginPending()
    const results = await Promise.allSettled([a.save('foodEntries', { ...first, note: 'a' }, first), b.save('foodEntries', { ...second, note: 'b' }, second)])
    expect(results.map(r => r.status)).toEqual(['fulfilled', 'fulfilled'])
    await f.reopen()
    const state = await f.store.read()
    expect(state.domains.flatMap(p => p.records.foodEntries).map(r => r.note).sort()).toEqual(['a', 'b'])
    expect(await f.store.beginPending()).toEqual(frozen); expect(state.pendingOperations).toHaveLength(2)
  })
  test(`optimized ${kind} mutation refuses one of two competing edits rather than overwriting it`, async () => {
    const f = await backupFixture(kind), a = createNutritionCommands({ store: f.store }), b = createNutritionCommands({ store: await f.fork() })
    await a.save('foodEntries', entry())
    const results = await Promise.allSettled([a.save('foodEntries', { ...entry(), note: 'a' }, entry()), b.save('foodEntries', { ...entry(), note: 'b' }, entry())])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find(r => r.status === 'rejected')
    expect(hasCode('record_changed')(rejected.reason)).toBe(true)
    expect(['a', 'b']).toContain((await f.store.readDay(entry().d)).entries[0].note)
  })
}
for (let phase = 1; phase <= 4; phase++) test(`optimized private JSON command interrupted at durable phase ${phase} recovers a complete history and retains frozen queue`, async () => {
  const f = await backupFixture('fs'), cmd = createNutritionCommands({ store: f.store })
  await cmd.save('foodEntries', entry()); const frozen = await f.store.beginPending()
  const updated = { ...entry(), quantity: { amount: 75, unit: 'g' } }
  f.control.failAt = f.control.phases + phase
  await expect(cmd.save('foodEntries', updated, entry())).rejects.toSatisfy(hasCode('storage_io_failed'))
  f.control.failAt = null; await f.reopen()
  const row = (await f.store.readDay(entry().d)).entries[0]
  expect(row).toEqual(phase < 4 ? entry() : updated)
  expect(await f.store.beginPending()).toEqual(frozen)
  const next = createNutritionCommands({ store: f.store }); await next.save('foodEntries', updated, entry())
  expect((await f.store.readDay(entry().d)).entries).toEqual([updated]); expect(await f.store.beginPending()).toEqual(frozen)
})

test('independent command services sharing a reader retry invalidated captures and preserve different intentional edits', async () => {
  const f = await backupFixture(), a = createNutritionCommands({ store: f.store }), b = createNutritionCommands({ store: f.store })
  const first = entry(), second = entry({ id: 'second' })
  await a.batch([first, second].map(value => ({ collection: 'foodEntries', id: value.id, value, base: null })))
  await Promise.all([a.save('foodEntries', { ...first, note: 'a' }, first), b.save('foodEntries', { ...second, note: 'b' }, second)])
  expect((await f.store.readDay(first.d)).entries.map(row => row.note).sort()).toEqual(['a', 'b'])
})

test('quota during an optimized edit leaves the warm view, durable root and pending operation unchanged', async () => {
  const f = await backupFixture(), cmd = createNutritionCommands({ store: f.store })
  const row = entry(); await cmd.save('foodEntries', row)
  const before = await f.store.read(), view = await f.store.readDay(row.d)
  f.control.failAt = f.control.operations + 2
  await expect(cmd.save('foodEntries', { ...row, note: 'cannot fit' }, row)).rejects.toSatisfy(hasCode('quota_exceeded'))
  f.control.failAt = null
  expect((await f.store.readDay(row.d)).entries).toEqual(view.entries)
  expect((await f.store.read()).head).toEqual(before.head)
  expect((await f.store.read()).pendingOperations).toEqual(before.pendingOperations)
})
