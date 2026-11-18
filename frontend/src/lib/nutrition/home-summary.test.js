// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from 'vitest'
import { readHomeNutritionSummary } from './home-summary.js'
import { nutritionInstallationIdentity } from './ui-identity.js'
import { createNutritionLocalStore } from './local-store.js'
import { nutritionIdbBackend } from './local-store-idb.js'
import { transactionalIdb } from './local-storage.test-util.js'
import { encodePartition } from './serialization.js'
import { entry, food } from './fixtures.test-util.js'
import { journalPartitionId, libraryPartitionId } from './persistence-contract.js'

const DATE = '2026-10-10'
const cleanups = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const fn of cleanups.splice(0)) await fn()
})

function makeBackendTracker(engine) {
  const calls = { publish: 0, open: 0, close: 0, headers: 0 }
  const openBackend = () => {
    const backend = nutritionIdbBackend({ idb: engine.idb })
    const origOpen = backend.open.bind(backend)
    const origClose = backend.close.bind(backend)
    const origHeaders = backend.headers.bind(backend)
    const origPublish = backend.publish.bind(backend)
    backend.open = async scopeId => {
      calls.open++
      return origOpen(scopeId)
    }
    backend.close = () => {
      calls.close++
      return origClose()
    }
    backend.headers = async () => {
      calls.headers++
      return origHeaders()
    }
    backend.publish = async input => {
      calls.publish++
      return origPublish(input)
    }
    return backend
  }
  return { openBackend, calls }
}

async function seedScope(engine, { namespace, goals = [], entries = [] }) {
  const store = await createNutritionLocalStore({
    namespace,
    generation: 'generation-1',
    deviceId: 'device-a',
    backend: nutritionIdbBackend({ idb: engine.idb }),
  })
  cleanups.push(() => store.close())
  const stamp = { counter: 1, deviceId: 'device-a' }
  const libRecords = {
    customFoods: [food()],
    savedFoods: [],
    recipes: [],
    mealTemplates: [],
    nutritionGoals: goals,
  }
  const partitions = [
    await encodePartition({
      id: libraryPartitionId('device-a-0'),
      kind: 'library',
      namespace,
      generation: 'generation-1',
      records: libRecords,
      sync: {
        revision: 1,
        writeId: 'seed-1',
        edits: goals.map(g => ({ collection: 'nutritionGoals', id: g.id, stamp })),
        tombstones: [],
      },
    }),
  ]
  if (entries.length) {
    partitions.push(
      await encodePartition({
        id: journalPartitionId(DATE.slice(0, 7), 'device-a-0'),
        kind: 'journal',
        namespace,
        generation: 'generation-1',
        records: { foodEntries: entries },
        sync: {
          revision: 1,
          writeId: 'seed-1',
          edits: entries.map(e => ({ collection: 'foodEntries', id: e.id, stamp })),
          tombstones: [],
        },
      }),
    )
  }
  await store.commit({ commitId: 'seed-1', expectedHead: null, partitions })
  return store
}

describe('readHomeNutritionSummary', () => {
  test('returns null cleanly in happy-dom when unauthenticated or when indexedDB is undefined', async () => {
    expect(typeof globalThis.indexedDB).toBe('undefined')
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    await expect(readHomeNutritionSummary({ date: DATE })).resolves.toBeNull()
    await expect(readHomeNutritionSummary({ date: DATE, isGuestMode: true })).resolves.toBeNull()
    await expect(
      readHomeNutritionSummary({
        date: DATE,
        user: { id: 'user-1' },
        serverUrl: 'https://gym.test/app',
      }),
    ).resolves.toBeNull()
    await expect(
      readHomeNutritionSummary({
        date: DATE,
        user: { id: 'user-1' },
        serverUrl: null,
        openBackend: () => {
          throw new Error('should not open without serverUrl')
        },
      }),
    ).resolves.toBeNull()

    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test('uninitialized guest storage performs zero writes and returns null', async () => {
    const engine = transactionalIdb()
    const { openBackend, calls } = makeBackendTracker(engine)
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const summary = await readHomeNutritionSummary({
      date: DATE,
      isGuestMode: true,
      openBackend,
    })

    expect(summary).toBeNull()
    expect(calls.headers).toBe(1)
    expect(calls.publish).toBe(0)
    expect(calls.open).toBe(1)
    expect(calls.close).toBe(1)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test('initialized account with empty or recovery-required storage returns empty summary without network calls', async () => {
    const engine = transactionalIdb()
    const { openBackend, calls } = makeBackendTracker(engine)
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const empty = await readHomeNutritionSummary({
      date: DATE,
      user: { id: 'user-empty' },
      serverUrl: 'https://gym.test/subpath/',
      isTrainingDay: true,
      openBackend,
    })

    expect(empty).toEqual({
      hasData: false,
      hasGoal: false,
      consumedKcal: 0,
      targetKcal: null,
      remainingKcal: null,
      consumedProtein: 0,
      targetProtein: null,
      remainingProtein: null,
      isTrainingDay: true,
    })
    expect(calls.publish).toBe(0)
    expect(calls.open).toBe(1)
    expect(calls.close).toBe(1)
    expect(fetchSpy).not.toHaveBeenCalled()

    // Simulate recovery-required (orphan documents without root)
    const scope = { namespace: { profileId: 'user-damaged', serverOrigin: 'https://gym.test' }, generation: 'generation-1' }
    const store = await createNutritionLocalStore({
      namespace: scope.namespace,
      generation: 'generation-1',
      deviceId: 'device-a',
      backend: nutritionIdbBackend({ idb: engine.idb }),
    })
    cleanups.push(() => store.close())
    const db = engine.control.databases.get(`opengym-nutrition-${store.scopeId}`)
    db.stores.get('documents').set('p-' + 'a'.repeat(64), '{}')

    const degraded = await readHomeNutritionSummary({
      date: DATE,
      user: { id: 'user-damaged' },
      serverUrl: 'https://gym.test',
      openBackend,
    })

    expect(degraded).toEqual({
      hasData: false,
      hasGoal: false,
      consumedKcal: 0,
      targetKcal: null,
      remainingKcal: null,
      consumedProtein: 0,
      targetProtein: null,
      remainingProtein: null,
      isTrainingDay: false,
    })
    expect(calls.publish).toBe(0)
  })

  test('computes totals, excludes water entries, and applies trainingTargets overrides on training days', async () => {
    const engine = transactionalIdb()
    const identity = await nutritionInstallationIdentity({ backend: nutritionIdbBackend({ idb: engine.idb }) })
    const namespace = { profileId: `local-${identity.profileId}`, serverOrigin: null }

    const goal = {
      schemaVersion: 1,
      id: 'goal-1',
      start: '2026-10-01',
      end: '2026-10-31',
      mode: 'bulk',
      targets: { kcal: 2200, protein: 150, carbs: 240, fat: 70 },
      trainingTargets: { kcal: 2600, protein: null },
    }
    const oatsEntry = entry({
      id: 'food-1',
      d: DATE,
      snapshot: food({ id: 'oats', name: 'Oats', nutrients: { kcal: 380, protein: 13, carbs: 60, fat: 7 } }),
      quantity: { amount: 100, unit: 'g' }, // 380 kcal, 13 protein
    })
    const chickenEntry = entry({
      id: 'food-2',
      d: DATE,
      meal: 'lunch',
      snapshot: food({ id: 'chicken', name: 'Chicken', nutrients: { kcal: 165, protein: 31, carbs: 0, fat: 3.6 } }),
      quantity: { amount: 200, unit: 'g' }, // 330 kcal, 62 protein
    })
    const otherDayEntry = entry({
      id: 'food-other-day',
      d: '2026-10-09',
      quantity: { amount: 100, unit: 'g' },
    })
    const waterByKind = entry({
      id: 'water-1',
      d: DATE,
      entryKind: 'water',
      snapshot: food({
        id: 'water-custom',
        name: 'Water',
        reference: { amount: 100, unit: 'ml' },
        nutrients: { kcal: 10, protein: 1 },
      }),
      quantity: { amount: 250, unit: 'ml' },
    })
    const waterBySource = entry({
      id: 'water-2',
      d: DATE,
      snapshot: food({
        id: 'sparkling',
        name: 'Sparkling water',
        reference: { amount: 100, unit: 'ml' },
        nutrients: { kcal: 5, protein: null },
        source: { kind: 'custom', hydration: true },
      }),
      quantity: { amount: 500, unit: 'ml' },
    })
    const waterById = entry({
      id: 'water-3',
      d: DATE,
      snapshot: food({
        id: 'opengym-water',
        name: 'Water',
        reference: { amount: 100, unit: 'ml' },
        nutrients: { kcal: 0, protein: null },
      }),
      quantity: { amount: 300, unit: 'ml' },
    })

    await seedScope(engine, {
      namespace,
      goals: [goal],
      entries: [oatsEntry, chickenEntry, otherDayEntry, waterByKind, waterBySource, waterById],
    })

    const { openBackend, calls } = makeBackendTracker(engine)
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    // Rest day: uses goal.targets (2200 kcal, 150 protein)
    const restSummary = await readHomeNutritionSummary({
      date: DATE,
      isGuestMode: true,
      isTrainingDay: false,
      openBackend,
    })

    expect(restSummary).toEqual({
      hasData: true,
      hasGoal: true,
      overlapping: false,
      goalMode: 'bulk',
      consumedKcal: 710,
      targetKcal: 2200,
      remainingKcal: 1490,
      consumedProtein: 75,
      targetProtein: 150,
      remainingProtein: 75,
      entryCount: 2,
      isTrainingDay: false,
    })

    // Training day: trainingTargets.kcal (2600) overrides 2200, while null trainingTargets.protein keeps 150
    const trainingSummary = await readHomeNutritionSummary({
      date: DATE,
      isGuestMode: true,
      isTrainingDay: true,
      openBackend,
    })

    expect(trainingSummary).toEqual({
      hasData: true,
      hasGoal: true,
      overlapping: false,
      goalMode: 'bulk',
      consumedKcal: 710,
      targetKcal: 2600,
      remainingKcal: 1890,
      consumedProtein: 75,
      targetProtein: 150,
      remainingProtein: 75,
      entryCount: 2,
      isTrainingDay: true,
    })

    expect(calls.publish).toBe(0)
    expect(calls.open).toBe(4) // 2 reads x (identity + data)
    expect(calls.close).toBe(4)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test('handles overlapping goals safely without claiming an active goal or false targets', async () => {
    const engine = transactionalIdb()
    const namespace = { profileId: 'user-overlap', serverOrigin: 'https://gym.test' }
    await seedScope(engine, {
      namespace,
      goals: [
        { schemaVersion: 1, id: 'g1', start: '2026-10-01', mode: 'cut', targets: { kcal: 1800, protein: 160 } },
        { schemaVersion: 1, id: 'g2', start: '2026-10-05', end: '2026-10-15', mode: 'bulk', targets: { kcal: 2800, protein: 160 } },
      ],
      entries: [
        entry({
          id: 'e1',
          d: DATE,
          quantity: { amount: 100, unit: 'g' }, // 380 kcal, 13 protein
        }),
      ],
    })

    const { openBackend, calls } = makeBackendTracker(engine)
    const summary = await readHomeNutritionSummary({
      date: DATE,
      user: { id: 'user-overlap' },
      serverUrl: 'https://gym.test:443/openGym',
      isTrainingDay: true,
      openBackend,
    })

    expect(summary).toEqual({
      hasData: true,
      hasGoal: false,
      overlapping: true,
      goalMode: null,
      consumedKcal: 380,
      targetKcal: null,
      remainingKcal: null,
      consumedProtein: 13,
      targetProtein: null,
      remainingProtein: null,
      entryCount: 1,
      isTrainingDay: true,
    })
    expect(calls.publish).toBe(0)
    expect(calls.open).toBe(1)
    expect(calls.close).toBe(1)
  })
})
