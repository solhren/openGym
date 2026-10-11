import assert from 'node:assert/strict'
import { test, vi } from 'vitest'
import { backupFixture, revised } from './backup.test-util.js'
import { journal, hasCode } from './persistence.test-util.js'
import { entry } from './fixtures.test-util.js'
import { exportNutritionBackup } from './backup.js'

async function source() { const f = await backupFixture(); await f.commit(journal({ records: { foodEntries: [entry({ id: 'imported' })] } })); return (await f.service().export()).blob }
const rows = state => state.domains.flatMap(p => p.records.foodEntries ?? [])
for (const phase of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) test(`first native restore interrupted after durable phase ${phase} replays safely`, async () => {
  const blob = await source(), f = await backupFixture('fs'), service = f.service(), opts = { restoreId: 'restart-first', mode: 'empty' }
  const preview = await service.preview(blob, opts)
  f.control.phases = 0; f.control.failAt = phase
  const outcome = await service.restore(preview).then(value => ({ value }), error => ({ error }))
  f.control.failAt = null; await f.reopen()
  const before = await f.store.read()
  if (rows(before).length) assert.equal(rows(before)[0].id, 'imported')
  else if (before.head) assert.equal((await f.service().recoveryStatus()).restores[0].status, 'prepared')
  else assert.equal(before.status, 'recovery-required')
  const reopened = f.service(), resumed = await reopened.preview(blob, opts)
  await reopened.restore(resumed)
  assert.equal(rows(await f.store.read())[0].id, 'imported')
  assert.equal((await f.store.read()).pendingOperations.length, 1)
  if (outcome.value) assert.equal(outcome.value.status, 'restored')
})
for (const phase of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) test(`native merge interrupted at phase ${phase} preserves old queue and resumes`, async () => {
  const blob = await source(), f = await backupFixture('fs'); await f.commit(); const frozen = await f.store.beginPending()
  const service = f.service(), opts = { restoreId: 'restart-existing' }, preview = await service.preview(blob, opts)
  f.control.phases = 0; f.control.failAt = phase
  await service.restore(preview).catch(error => assert.ok(error.issues?.some(i => i.code === 'storage_io_failed')))
  f.control.failAt = null; await f.reopen()
  assert.deepEqual(await f.store.beginPending(), frozen)
  const resumed = f.service(); await resumed.restore(await resumed.preview(blob, opts))
  assert.equal(rows(await f.store.read()).length, 2); assert.deepEqual(await f.store.beginPending(), frozen)
  await f.store.collect(); await f.reopen(); assert.equal(rows(await f.store.read()).length, 2)
})

test('IDB quota failure aborts the whole transaction and leaves pending operations reachable', async () => {
  const blob = await source(), f = await backupFixture(); await f.commit(); const frozen = await f.store.beginPending(), before = await f.store.read()
  const service = f.service(), preview = await service.preview(blob, { restoreId: 'idb-quota' })
  f.control.failAt = f.control.operations + 2
  await assert.rejects(service.restore(preview), hasCode('quota_exceeded')); f.control.failAt = null; await f.reopen()
  assert.deepEqual((await f.store.read()).head, before.head); assert.deepEqual(await f.store.beginPending(), frozen)
  const reopened = f.service(); await reopened.restore(await reopened.preview(blob, { restoreId: 'idb-quota' }))
  assert.equal(rows(await f.store.read()).length, 2)
})

test('export racing a local publication fails and exposes no mixed archive', async () => {
  const f = await backupFixture(); await f.commit()
  const original = f.store.exportPartitions.bind(f.store)
  const spy = vi.spyOn(f.store, 'exportPartitions').mockImplementation(options => original({ ...options, visit: async (...args) => {
    await options.visit(...args); const next = revised(journal()); next.records.foodEntries[0].quantity.amount = 99; await f.commit(next, 'during-export')
  } }))
  await assert.rejects(f.service().export(), error => error.issues?.some(i => ['read_invalidated', 'stale_root'].includes(i.code))); spy.mockRestore()
  assert.equal(rows(await f.store.read())[0].quantity.amount, 99)
})

test('global export refuses workouts changing during capture', async () => {
  const f = await backupFixture(); await f.commit(); let state = { workouts: [], routines: [] }
  const original = f.store.exportPartitions.bind(f.store), spy = vi.spyOn(f.store, 'exportPartitions').mockImplementation(async opts => {
    const out = await original(opts); state = { ...state, workouts: [{ id: 'concurrent' }] }; return out
  })
  await assert.rejects(exportNutritionBackup({ store: f.store, getWorkouts: () => state, getWorkoutRevision: () => ({ namespace: f.store.scope.namespace, revision: 'fixture-version' }) }), hasCode('workouts_changed_during_export')); spy.mockRestore()
})

test('logout during export and preview prevents returning old account data', async () => {
  const f = await backupFixture('idb', { namespace: { serverOrigin: 'https://gym.example', profileId: 'alice' } }); await f.commit()
  const original = f.store.exportPartitions.bind(f.store), spy = vi.spyOn(f.store, 'exportPartitions').mockImplementation(async opts => {
    const out = await original(opts); f.session.value = null; return out
  })
  await assert.rejects(f.service().export(), hasCode('backup_session_changed')); spy.mockRestore()
})

test('local commit expectedHead rejects a stale caller even when storage itself is healthy', async () => {
  const f = await backupFixture(); await f.commit(); const first = await f.store.read()
  await f.store.beginPending()
  const encoded = await import('./serialization.js').then(m => m.encodePartition(revised(journal())))
  await assert.rejects(f.store.commit({ commitId: 'stale', expectedHead: first.head, partitions: [encoded] }), hasCode('stale_root'))
})

test('resource-limited progressive export refuses excess before handing back an archive', async () => {
  const f = await backupFixture(); await f.commit(); await assert.rejects(f.store.exportPartitions({ maxBytes: 1, visit: async () => {} }), hasCode('backup_too_large'))
})

test('closing during a prepared restore cannot write into a subsequently opened account', async () => {
  const f = await backupFixture(), blob = await source(), service = f.service(), preview = await service.preview(blob, { restoreId: 'closed' })
  f.store.close(); await assert.rejects(service.restore(preview), hasCode('storage_closed'))
})

test('session transition suppresses previous-account error diagnostics from a failing read', async () => {
  const f = await backupFixture('idb', { namespace: { serverOrigin: 'https://gym.example', profileId: 'alice' } }), blob = await source()
  const spy = vi.spyOn(f.store, 'readForRestore').mockImplementation(async () => { f.session.value = null; throw Error('private previous account details') })
  await assert.rejects(f.service().preview(blob, { restoreId: 'diagnostics' }), hasCode('backup_session_changed')); spy.mockRestore()
})

test('a logout/login ABA epoch invalidates a prepared restoration', async () => {
  const f = await backupFixture(), blob = await source(), service = f.service(), preview = await service.preview(blob, { restoreId: 'guest-aba' })
  f.session.value = { ...f.session.value, epoch: 2 }
  await assert.rejects(service.restore(preview), hasCode('backup_session_changed')); assert.equal((await f.store.read()).status, 'empty')
})

test('a corrupt committed partition cannot be overwritten using a good backup', async () => {
  const f = await backupFixture(), blob = await source(); await f.commit()
  const database = f.control.databases.values().next().value, docs = database.stores.get('documents'), partKey = [...docs.keys()].find(k => k.startsWith('p-'))
  docs.set(partKey, '{}')
  await assert.rejects(f.service().preview(blob, { restoreId: 'corrupt' })); assert.equal(docs.get(partKey), '{}')
})

test('cancellation before export/validation has no storage effects', async () => {
  const f = await backupFixture(), blob = await source(), controller = new AbortController(); controller.abort()
  await assert.rejects(f.service().export({ signal: controller.signal }), hasCode('backup_cancelled'))
  await assert.rejects(f.service().preview(blob, { restoreId: 'abort' }, { signal: controller.signal }), hasCode('backup_cancelled'))
  assert.equal((await f.store.read()).status, 'empty')
})

test('restore ignores unreachable old documents rather than loading their whole byte history', async () => {
  const f = await backupFixture(); await f.commit()
  const db = f.control.databases.values().next().value, docs = db.stores.get('documents')
  docs.set('p-' + 'f'.repeat(64), 'invalid unreachable evidence')
  const state = await f.store.readForRestore({ maxBytes: 1024 * 1024 })
  assert.equal(state.domains[0].records.foodEntries[0].id, 'entry-1'); assert.equal(docs.get('p-' + 'f'.repeat(64)), 'invalid unreachable evidence')
  await assert.rejects(f.store.readForRestore({ maxBytes: 1 }), hasCode('backup_too_large'))
})

test('an interruption after durable preparation is discoverable and resumes after reopening', async () => {
  const f = await backupFixture('fs'), blob = await source(), service = f.service(), original = f.store.commit.bind(f.store)
  let calls = 0
  const spy = vi.spyOn(f.store, 'commit').mockImplementation((...args) => ++calls === 2 ? Promise.reject(Error('closed before final publication')) : original(...args))
  await assert.rejects(service.restore(await service.preview(blob, { restoreId: 'prepared', mode: 'empty' })))
  spy.mockRestore(); await f.reopen()
  assert.equal(rows(await f.store.read()).length, 0); assert.equal((await f.service().recoveryStatus()).restores[0].status, 'prepared')
  const resumed = f.service(); await resumed.restore(await resumed.preview(blob, { restoreId: 'prepared', mode: 'empty' }))
  assert.equal((await resumed.recoveryStatus()).restores[0].status, 'completed'); assert.equal(rows(await f.store.read()).length, 1)
})

test('a prepared restore refuses to reuse old choices after newer local data appear', async () => {
  const f = await backupFixture(), blob = await source(), service = f.service(), original = f.store.commit.bind(f.store)
  let calls = 0
  const spy = vi.spyOn(f.store, 'commit').mockImplementation((...args) => ++calls === 2 ? Promise.reject(Error('interrupted')) : original(...args))
  await assert.rejects(service.restore(await service.preview(blob, { restoreId: 'changed-preparation' }))); spy.mockRestore()
  await f.commit(journal(), 'new-local-data')
  assert.equal((await service.recoveryStatus()).restores[0].status, 'base-changed')
  await assert.rejects(service.preview(blob, { restoreId: 'changed-preparation' }), hasCode('restore_prepared_base_changed'))
})

test('a workout ABA write invalidates global export even when the final state is identical', async () => {
  const f = await backupFixture(); await f.commit(); const state = { workouts: [], routines: [] }; let revision = 0
  const original = f.store.exportPartitions.bind(f.store), spy = vi.spyOn(f.store, 'exportPartitions').mockImplementation(async options => {
    const result = await original(options); revision += 2; return result
  })
  await assert.rejects(exportNutritionBackup({ store: f.store, getWorkouts: () => state,
    getWorkoutRevision: () => ({ namespace: f.store.scope.namespace, revision }) }), hasCode('workouts_changed_during_export')); spy.mockRestore()
})

test('global export requires an owned nonrepeating workout revision reader', async () => {
  const f = await backupFixture(), state = { workouts: [], routines: [] }
  await assert.rejects(exportNutritionBackup({ store: f.store, getWorkouts: () => state }), hasCode('workout_revision_reader_required'))
  await assert.rejects(exportNutritionBackup({ store: f.store, getWorkouts: () => state,
    getWorkoutRevision: () => ({ namespace: { ...f.store.scope.namespace, profileId: 'other' }, revision: 'one' }) }), hasCode('workout_scope_mismatch'))
})
