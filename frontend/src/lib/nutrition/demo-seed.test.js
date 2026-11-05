import { test, expect, vi } from 'vitest'
import { backupFixture } from './backup.test-util.js'
import { createNutritionCommands } from './ui-service.js'
import { createNutritionUISession } from './ui-session.js'
import { seedDemoNutrition, demoNutritionRecords } from './demo-seed.js'
import { nutrientsForQuantity, sumFoodEntries } from './calculate.js'
import { hasCode } from './persistence.test-util.js'

const day = '2026-11-05'
const fixture = () => backupFixture('idb', { namespace: { profileId: 'demo-fixture', serverOrigin: null } })

test('real v1 publication preserves g, ml, decimal and unknown examples through reopening', async () => {
  const f = await fixture()
  expect(await seedDemoNutrition(f.store, { day, locale: 'fr-FR' })).toEqual({ seeded: true })
  await f.reopen()
  const foods = (await f.store.readLibrary()).domains.flatMap(p => p.records.customFoods ?? [])
  expect(foods).toHaveLength(4)
  expect(foods[0].name).toBe('Flocons d’avoine · Demo')
  expect(foods[2].nutrients.fat).toBe(0.3)
  expect(foods[3].nutrients.carbs).toBeNull()
  const entries = (await f.store.readDay(day)).entries
  expect(sumFoodEntries(entries).totals.kcal).toBe(242)
  expect(entries.find(row => row.snapshot.id === 'demo-milk').quantity).toEqual({ amount: 150, unit: 'ml' })
  expect(() => nutrientsForQuantity(foods[1], { amount: 100, unit: 'g' })).toThrow()
})

test('first-open concurrency and different dates never duplicate or overwrite the winning seed', async () => {
  const f = await fixture(), other = await f.fork()
  await Promise.all([seedDemoNutrition(f.store, { day, locale: 'fr' }), seedDemoNutrition(other, { day: '2026-11-06', locale: 'en' })])
  const before = await f.store.read()
  expect(before.domains.flatMap(p => p.records.foodEntries ?? [])).toHaveLength(2)
  await seedDemoNutrition(other, { day: '2026-11-07' })
  expect((await other.read()).head).toEqual(before.head)
})

test('user edits, deletions and offline queue survive another visit; removed examples are not reintroduced', async () => {
  const f = await fixture()
  await seedDemoNutrition(f.store, { day })
  const row = (await f.store.readDay(day)).entries.find(row => row.snapshot.id === 'demo-oats'), commands = createNutritionCommands({ store: f.store })
  await commands.save('foodEntries', { ...row, quantity: { amount: 80, unit: 'g' } }, row)
  const food = (await f.store.readLibrary()).domains[0].records.customFoods[0]
  await commands.remove('customFoods', food)
  const before = await f.store.read()
  await f.reopen(); await seedDemoNutrition(f.store, { day: '2026-11-10' })
  const after = await f.store.read()
  expect(after.head).toEqual(before.head)
  expect(after.pendingOperations).toEqual(before.pendingOperations)
  expect((await f.store.readDay(day)).entries.find(row => row.snapshot.id === 'demo-oats').snapshot).toEqual(food)
  expect((await f.store.readDay(day)).entries.find(row => row.snapshot.id === 'demo-oats').quantity.amount).toBe(80)
})

test('quota/interruption during initial publication leaves no half-seeded journal and can retry', async () => {
  const f = await fixture()
  f.control.failAt = f.control.operations + 2
  await expect(seedDemoNutrition(f.store, { day })).rejects.toThrow()
  f.control.failAt = null
  await f.reopen()
  expect((await f.store.inspect()).head).toBeNull()
  await seedDemoNutrition(f.store, { day })
  expect((await f.store.readDay(day)).entries).toHaveLength(2)
})

test('seed refuses ordinary guest/account scopes; local session never calls sync or catalog transports', async () => {
  const ordinary = await backupFixture()
  await expect(seedDemoNutrition(ordinary.store, { day })).rejects.toSatisfy(hasCode('demo_scope_required'))
  const f = await fixture(), network = vi.fn(() => { throw Error('network forbidden') })
  const session = f.session.value
  const ui = createNutritionUISession({ store: f.store, session, getSession: () => session, transport: network,
    catalogTransport: network, catalogCapabilitiesTransport: network, catalogEnabled: false })
  try {
    expect(ui.catalog.enabled).toBe(false)
    await ui.save('customFoods', demoNutritionRecords(day).library.customFoods[0])
    expect(await ui.synchronize()).toEqual({ status: 'local' })
    expect(network).not.toHaveBeenCalled()
  } finally { ui.close() }
})
