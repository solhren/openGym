import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { memoryUsage, resourceUsage } from 'node:process'
import { createNutritionLocalStore } from './local-store.js'
import { nutritionIdbBackend } from './local-store-idb.js'
import { nutritionFsBackend } from './local-store-fs.js'
import { boundedJson, MAX_DOCUMENT_BYTES } from './persistence-contract.js'
import { encodePartition } from './serialization.js'
import { entry, recipe } from './fixtures.test-util.js'
import { createRecipeSnapshot } from './recipe.js'
import { namespace, journal, library, sync, stamp, hasCode, reseal } from './persistence.test-util.js'
import { transactionalIdb, diskBridge } from './local-storage.test-util.js'

const cleanups = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
const settings = { namespace, generation: 'generation-1', deviceId: 'device-a' }
const part = (revision = 0, overrides = {}) => encodePartition(journal({ sync: sync(revision), ...overrides }))
async function fixture(kind) {
  let backend, control, createBackend
  if (kind === 'idb') {
    const memory = transactionalIdb(); control = memory.control
    createBackend = () => nutritionIdbBackend({ idb: memory.idb })
  } else {
    const disk = await diskBridge(); cleanups.push(disk.cleanup); control = disk.control
    createBackend = () => nutritionFsBackend({ loadPlugin: async () => disk.plugin })
  }
  backend = createBackend()
  const store = await createNutritionLocalStore({ ...settings, backend })
  cleanups.push(() => store.close())
  const reopen = async overrides => {
    const next = await createNutritionLocalStore({ ...settings, ...overrides, backend: createBackend() })
    cleanups.push(() => next.close()); return next
  }
  return { store, backend, control, reopen }
}

for (const kind of ['idb', 'fs']) describe(`Nutrition local storage (${kind})`, () => {
  test('closing during asynchronous validation prevents a late read from exposing the old account', async () => {
    const f = await fixture(kind)
    await f.store.commit({ commitId: 'original-account', partitions: [await part()] })
    const digest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle)
    let entered, resume
    const started = new Promise(resolve => { entered = resolve }), paused = new Promise(resolve => { resume = resolve })
    const spy = vi.spyOn(globalThis.crypto.subtle, 'digest').mockImplementationOnce(async (...args) => {
      entered(); await paused; return digest(...args)
    })
    try {
      const result = f.store.read()
      const rejected = assert.rejects(result, hasCode('storage_closed'))
      await started
      f.store.close()
      const other = await createNutritionLocalStore({ ...settings, namespace: { ...namespace, profileId: 'other' }, backend: f.backend })
      cleanups.push(() => other.close())
      assert.equal((await other.read()).status, 'empty')
      resume(); await rejected
      assert.equal((await other.read()).status, 'empty')
    } finally { resume(); spy.mockRestore() }
  })

  test('closing a pending backend open cannot resurrect or replace a subsequent connection', async () => {
    const f = await fixture(kind)
    f.store.close()
    const interrupted = f.backend.open('a'.repeat(64))
    f.backend.close()
    const subsequent = f.backend.open('b'.repeat(64))
    const results = await Promise.allSettled([interrupted, subsequent])
    assert.equal(results[0].status, 'rejected')
    hasCode('storage_io_failed')(results[0].reason)
    assert.equal(results[1].status, 'fulfilled')
    assert.equal((await f.backend.snapshot()).root, null)
    await f.backend.publish({ expectedRoot: null, root: '{}', writes: [] })
    if (kind === 'idb') assert.equal(f.control.databases.get(`opengym-nutrition-${'b'.repeat(64)}`).stores.get('roots').get('root'), '{}')
    else assert.equal(await readFile(join(f.control.base, 'b'.repeat(64), 'root.json'), 'utf8'), '{}')
    f.backend.close()
  })

  test('one active backend cannot be rebound to another account', async () => {
    const f = await fixture(kind)
    await assert.rejects(createNutritionLocalStore({ ...settings, namespace: { ...namespace, profileId: 'other' },
      backend: f.backend }), hasCode('storage_already_open'))
    await f.store.commit({ commitId: 'original-account', partitions: [await part()] })
    assert.equal((await f.store.read()).head.commitId, 'original-account')
  })

  test('a closed store cannot act on a backend subsequently opened for another account', async () => {
    const f = await fixture(kind)
    await f.store.commit({ commitId: 'original-account', partitions: [await part()] })
    const frozen = await f.store.beginPending(), encoded = await part(1)
    f.store.close()
    const other = await createNutritionLocalStore({ ...settings, namespace: { ...namespace, profileId: 'other' }, backend: f.backend })
    cleanups.push(() => other.close())
    for (const action of [() => f.store.read(), () => f.store.commit({ commitId: 'wrong-account', partitions: [encoded] }),
      () => f.store.beginPending(), () => f.store.collect(), () => f.store.storageStatus(),
      () => f.store.acknowledge({ operationId: frozen.operation.id, operationDigest: frozen.operationDigest })]) {
      await assert.rejects(action(), hasCode('storage_closed'))
    }
    f.store.close() // repeated close must not close the new owner's connection
    assert.equal((await other.read()).status, 'empty')
    assert.deepEqual(await (await f.reopen()).beginPending(), frozen)
  })

  test('closing during preparation cancels a commit before rebinding the backend', async () => {
    const f = await fixture(kind)
    const original = f.backend.snapshot.bind(f.backend)
    let other, once = true
    f.backend.snapshot = async () => {
      const captured = await original()
      if (once) {
        once = false; f.store.close()
        other = await createNutritionLocalStore({ ...settings, namespace: { ...namespace, profileId: 'other' }, backend: f.backend })
        cleanups.push(() => other.close())
      }
      return captured
    }
    await assert.rejects(f.store.commit({ commitId: 'interrupted-account-change', partitions: [await part()] }), hasCode('storage_closed'))
    assert.equal((await other.read()).status, 'empty')
    assert.equal((await (await f.reopen()).read()).status, 'empty')
  })

  test('coalescing cannot lower deletion stamps needed by long-offline peers', async () => {
    const f = await fixture(kind)
    const tombstones = [{ collection: 'foodEntries', id: 'entry-1', stamp: stamp(50) }]
    await f.store.commit({ commitId: 'deleted', partitions: [await part(1, { records: { foodEntries: [] }, sync: { ...sync(1), tombstones } })] })
    const before = await f.backend.snapshot()
    for (const marker of [stamp(49), { ...stamp(50), deviceId: 'another-device' }]) {
      await assert.rejects(f.store.commit({ commitId: 'weaker-deletion', partitions: [await part(2, {
        records: { foodEntries: [] }, sync: { ...sync(2), tombstones: [{ ...tombstones[0], stamp: marker }] } })] }), hasCode('regressing_sync_stamp'))
    }
    assert.deepEqual(await f.backend.snapshot(), before)
    await f.store.commit({ commitId: 'retained-deletion', partitions: [await part(2, { records: { foodEntries: [] }, sync: { ...sync(2), tombstones } })] })
    await f.store.collect()
    assert.deepEqual((await (await f.reopen()).read()).domains[0].sync.tombstones, tombstones)
  })

  test('coalescing retains record and field markers until an explicit later deletion', async () => {
    const f = await fixture(kind)
    const edits = [{ collection: 'foodEntries', id: 'entry-1', stamp: stamp(20), fields: { quantity: stamp(100) } }]
    await f.store.commit({ commitId: 'edited', partitions: [await part(1, { sync: { ...sync(1), edits } })] })
    const before = await f.backend.snapshot()
    for (const next of [[], [{ ...edits[0], fields: {} }], [{ ...edits[0], fields: { quantity: stamp(99) } }]]) {
      await assert.rejects(f.store.commit({ commitId: 'lost-edit', partitions: [await part(2, { sync: { ...sync(2), edits: next } })] }),
        hasCode(next.length === 0 || !Object.hasOwn(next[0].fields, 'quantity') ? 'untracked_edit_marker_removal' : 'regressing_sync_stamp'))
    }
    const deletion = counter => part(2, { records: { foodEntries: [] }, sync: { ...sync(2),
      tombstones: [{ collection: 'foodEntries', id: 'entry-1', stamp: stamp(counter) }] } })
    await assert.rejects(f.store.commit({ commitId: 'old-deletion', partitions: [await deletion(99)] }), hasCode('regressing_sync_stamp'))
    assert.deepEqual(await f.backend.snapshot(), before)
    await f.store.commit({ commitId: 'later-deletion', partitions: [await deletion(101)] })
    await f.store.collect()
    assert.equal((await (await f.reopen()).read()).domains[0].sync.tombstones[0].stamp.counter, 101)
  })

  test('persists complete business data and queue across closing and reopening', async () => {
    const f = await fixture(kind)
    assert.equal((await f.store.read()).status, 'empty')
    const encoded = await part()
    await f.store.commit({ commitId: 'first', partitions: [encoded] })
    f.store.close()
    const next = await f.reopen()
    const state = await next.read()
    assert.deepEqual(state.domains, [journal()])
    assert.equal(state.pendingOperations.length, 1)
    assert.equal(state.pendingOperations[0].partitions[0].digest, encoded.integrity.digest)
  })

  test('coalesces only unsent checkpoints and retains all historical records and metadata', async () => {
    const { store } = await fixture(kind)
    const rows = []
    for (let i = 0; i < 8; i++) {
      rows.push(entry({ id: `entry-${i}` }))
      await store.commit({ commitId: `change-${i}`, partitions: [await part(i, { records: { foodEntries: rows } })] })
    }
    const state = await store.read()
    assert.equal(state.pendingOperations.length, 1)
    assert.deepEqual(state.domains[0].records.foodEntries, rows)
    assert.equal(state.pendingOperations[0].partitions[0].digest, state.manifest.partitions[0].digest)
  })

  test('never expires an in-flight bundle; restart and subsequent edits preserve exact bytes', async () => {
    const f = await fixture(kind)
    await f.store.commit({ commitId: 'first', partitions: [await part()] })
    const leased = await f.store.beginPending()
    for (let i = 1; i <= 4; i++) await f.store.commit({ commitId: `edit-${i}`,
      partitions: [await part(i, { records: { foodEntries: [entry({ quantity: { amount: 100 + i, unit: 'g' } })] } })] })
    await f.store.collect()
    const next = await f.reopen()
    assert.deepEqual(await next.beginPending(), leased)
    assert.equal((await next.read()).pendingOperations.length, 2)
    assert.equal((await next.read()).domains[0].records.foodEntries[0].quantity.amount, 104)
  })

  test('requires an exact receipt and preserves later unsent changes after acknowledgment', async () => {
    const { store } = await fixture(kind)
    await store.commit({ commitId: 'first', partitions: [await part()] })
    const flight = await store.beginPending()
    await store.commit({ commitId: 'second', partitions: [await part(1)] })
    await assert.rejects(store.acknowledge({ operationId: flight.operation.id, operationDigest: '0'.repeat(64) }), hasCode('receipt_mismatch'))
    await store.acknowledge({ operationId: flight.operation.id, operationDigest: flight.operationDigest })
    const repeated = await store.acknowledge({ operationId: flight.operation.id, operationDigest: flight.operationDigest })
    assert.equal(repeated.repeated, true)
    const next = await store.beginPending()
    assert.notEqual(next.operation.id, flight.operation.id)
    assert.equal(next.partitions[0].sync.revision, 1)
    await assert.rejects(store.acknowledge({ operationId: flight.operation.id, operationDigest: flight.operationDigest }), hasCode('not_in_flight'))
  })

  test('isolates identical partition IDs across accounts, servers and generations', async () => {
    const f = await fixture(kind)
    await f.store.commit({ commitId: 'first', partitions: [await part()] })
    for (const override of [{ namespace: { ...namespace, profileId: '../other' } },
      { namespace: { ...namespace, serverOrigin: 'https://example.org' } }, { generation: 'next-generation' }]) {
      const other = await f.reopen(override)
      assert.equal((await other.read()).status, 'empty')
      assert.notEqual(other.scopeId, f.store.scopeId)
      await assert.rejects(other.commit({ commitId: 'wrong-scope', partitions: [await part()] }),
        hasCode(override.generation ? 'generation_mismatch' : 'namespace_mismatch'))
    }
    assert.equal((await f.store.read()).domains.length, 1)
  })

  test('competing connections publish one whole multi-partition commit, losing writer rebases', async () => {
    const f = await fixture(kind), other = await f.reopen()
    const a = { commitId: 'a', partitions: [await part(), await encodePartition(library())] }
    const b = { commitId: 'b', partitions: [await part(1)] }
    const results = await Promise.allSettled([f.store.commit(a), other.commit(b)])
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    const rejected = results.find(result => result.status === 'rejected')
    assert.ok(rejected.reason.issues.some(issue => ['stale_root', 'nonadvancing_revision'].includes(issue.code)))
    const state = await other.read()
    assert.equal(state.domains.length, state.head.commitId === 'a' ? 2 : 1)
    await other.commit({ commitId: 'rebased', partitions: [await part(2)] })
    assert.equal((await f.store.read()).head.commitId, 'rebased')
  })

  test('repeated exact commits are idempotent and reused commit IDs are rejected', async () => {
    const { store } = await fixture(kind)
    const request = { commitId: 'first', partitions: [await part()] }
    const before = await store.commit(request), again = await store.commit(request)
    assert.deepEqual(again.head, before.head)
    assert.equal(again.repeated, true)
    await assert.rejects(store.commit({ ...request, partitions: [] }), hasCode('reused_commit_id'))
    assert.equal((await store.read()).pendingOperations.length, 1)
  })

  test('rejects disappearing records/tombstones and permits explicit deletion markers', async () => {
    const { store } = await fixture(kind)
    await store.commit({ commitId: 'first', partitions: [await part()] })
    await assert.rejects(store.commit({ commitId: 'lost-history', partitions: [await part(1, { records: { foodEntries: [] } })] }), hasCode('untracked_record_removal'))
    const tombstones = [{ collection: 'foodEntries', id: 'entry-1', stamp: stamp(2) }]
    await store.commit({ commitId: 'explicit-deletion', partitions: [await part(1, { records: { foodEntries: [] }, sync: { ...sync(1), tombstones } })] })
    await assert.rejects(store.commit({ commitId: 'lost-marker', partitions: [await part(2, { records: { foodEntries: [] } })] }), hasCode('untracked_tombstone_removal'))
    await assert.rejects(store.commit({ commitId: 'removed-shard', partitions: [], removePartitionIds: [journal().id] }), hasCode('untracked_tombstone_removal'))
    await store.collect()
    assert.deepEqual((await store.read()).domains[0].sync.tombstones, tombstones)
  })

  test('moves records atomically between shards; checkpoint includes writes and removal', async () => {
    const { store } = await fixture(kind)
    await store.commit({ commitId: 'first', partitions: [await part()] })
    const moved = await part(1, { id: 'journal-2026-10-new-shard' })
    await store.commit({ commitId: 'move', partitions: [moved], removePartitionIds: [journal().id] })
    const state = await store.read()
    assert.equal(state.domains.length, 1)
    assert.deepEqual(state.domains[0].records.foodEntries, journal().records.foodEntries)
    assert.deepEqual(state.pendingOperations[0].removedPartitionIds, [journal().id])
    assert.deepEqual(state.pendingOperations[0].partitions, state.manifest.partitions)
  })

  test('GC retains current, fallback and pending references but removes unreachable versions', async () => {
    const f = await fixture(kind)
    await f.store.commit({ commitId: 'first', partitions: [await part()] })
    await f.store.beginPending()
    for (let i = 1; i <= 5; i++) await f.store.commit({ commitId: `edit-${i}`, partitions: [await part(i)] })
    const before = await f.backend.snapshot()
    assert.ok((await f.store.collect()).deleted > 0)
    const after = await f.backend.snapshot()
    assert.ok(after.objects.length < before.objects.length)
    assert.equal(after.objects.filter(row => row.key.startsWith('p-')).length, 3)
    assert.equal(after.objects.filter(row => row.key.startsWith('m-')).length, 2)
    assert.equal((await f.store.beginPending()).partitions[0].sync.revision, 0)
    assert.equal((await f.store.read()).domains[0].sync.revision, 5)
  })

  test('a corrupted frozen partition blocks recovery and cleanup even when current history is intact', async () => {
    const f = await fixture(kind)
    await f.store.commit({ commitId: 'first', partitions: [await part()] })
    const frozen = await f.store.beginPending()
    await f.store.commit({ commitId: 'second', partitions: [await part(1)] })
    const key = `p-${frozen.operation.partitions[0].digest}`
    if (kind === 'idb') f.control.databases.values().next().value.stores.get('documents').set(key, '{truncated')
    else await writeFile(join(f.control.base, f.store.scopeId, key + '.json'), '{truncated')
    const before = await f.backend.snapshot()
    for (const action of [() => f.store.read(), () => f.store.collect(), () => f.store.beginPending(),
      () => f.store.acknowledge({ operationId: frozen.operation.id, operationDigest: frozen.operationDigest })]) {
      await assert.rejects(action(), hasCode('no_complete_commit'))
    }
    assert.deepEqual(await f.backend.snapshot(), before)
    await assert.rejects(f.reopen(), hasCode('no_complete_commit'))
  })

  test('corrupt current publication recovers read-only and blocks writes/GC/queue changes', async () => {
    const f = await fixture(kind)
    await f.store.commit({ commitId: 'first', partitions: [await part()] })
    await f.store.commit({ commitId: 'second', partitions: [await part(1)] })
    if (kind === 'idb') f.control.databases.values().next().value.stores.get('roots').set('root', '{broken')
    else await writeFile(join(f.control.base, f.store.scopeId, 'root.json'), '{broken')
    const state = await f.store.read()
    assert.equal(state.status, 'recovery-required')
    assert.equal(state.head.commitId, 'first')
    for (const action of [() => f.store.collect(), () => f.store.beginPending(),
      () => f.store.commit({ commitId: 'overwrite', partitions: [] })]) {
      // commit checks recovery before planning; an empty write is enough for this guard.
      await assert.rejects(action(), hasCode('recovery_required'))
    }
  })

  test('unknown future format refuses rollback to an old publication', async () => {
    const f = await fixture(kind)
    await f.store.commit({ commitId: 'first', partitions: [await part()] })
    await f.store.commit({ commitId: 'second', partitions: [await part(1)] })
    const snapshot = await f.backend.snapshot(), future = JSON.parse(snapshot.root)
    future.storageVersion = 99
    const text = boundedJson(reseal(future))
    if (kind === 'idb') f.control.databases.values().next().value.stores.get('roots').set('root', text)
    else await writeFile(join(f.control.base, f.store.scopeId, 'root.json'), text)
    await assert.rejects(f.store.read(), hasCode('unsupported_storage_version'))
    await assert.rejects(f.store.collect(), hasCode('unsupported_storage_version'))
  })
})

describe('atomic publication faults', () => {
  for (let phase = 1; phase <= 5; phase++) test(`IDB forced connection closure at write ${phase} aborts the entire publication`, async () => {
    const f = await fixture('idb')
    await f.store.commit({ commitId: 'first', partitions: [await part(), await encodePartition(library())] })
    const frozen = await f.store.beginPending(), before = await f.backend.snapshot()
    const interruptedAt = f.control.operations + phase
    f.control.afterMutation = connection => { if (f.control.operations === interruptedAt) connection.forceClose() }
    await assert.rejects(f.store.commit({ commitId: 'interrupted', partitions: [await part(1), await encodePartition(library({ sync: sync(1) }))] }),
      hasCode('storage_io_failed'))
    f.control.afterMutation = null
    const next = await f.reopen()
    assert.equal((await next.read()).head.commitId.startsWith('local-'), true) // beginPending was durably published
    assert.deepEqual(await next.beginPending(), frozen)
    const database = f.control.databases.values().next().value
    assert.equal(database.stores.get('roots').get('root'), before.root)
    assert.deepEqual([...database.stores.get('documents')], before.objects.map(row => [row.key, row.text]))
  })

  for (let phase = 1; phase <= 5; phase++) test(`IDB abort rolls back every store at write ${phase}`, async () => {
    const f = await fixture('idb')
    await f.store.commit({ commitId: 'first', partitions: [await part(), await encodePartition(library())] })
    const before = await f.backend.snapshot()
    f.control.failAt = f.control.operations + phase
    await assert.rejects(f.store.commit({ commitId: 'next', partitions: [await part(1), await encodePartition(library({ sync: sync(1) }))] }), hasCode('quota_exceeded'))
    assert.deepEqual(await f.backend.snapshot(), before)
    assert.equal((await (await f.reopen()).read()).head.commitId, 'first')
  })

  for (let phase = 1; phase <= 5; phase++) test(`native JSON interruption after phase ${phase} selects one complete publication`, async () => {
    const f = await fixture('fs')
    await f.store.commit({ commitId: 'first', partitions: [await part(), await encodePartition(library())] })
    const request = { commitId: 'next', partitions: [await part(1), await encodePartition(library({ sync: sync(1) }))] }
    f.control.failAt = f.control.phases + phase
    await assert.rejects(f.store.commit(request), hasCode('storage_io_failed'))
    const next = await f.reopen(), state = await next.read()
    assert.equal(state.head.commitId, phase < 5 ? 'first' : 'next')
    assert.ok(state.domains.every(domain => domain.sync.revision === (phase < 5 ? 0 : 1)))
    f.control.failAt = null
    await next.commit(request)
    assert.equal((await next.read()).head.commitId, 'next')
    await next.collect()
    assert.equal((await next.read()).pendingOperations.length, 1)
  })

  for (let phase = 1; phase <= 3; phase++) test(`interrupted first native publication ${phase} never adopts orphan files`, async () => {
    const f = await fixture('fs')
    const request = { commitId: 'first', partitions: [await part()] }
    f.control.failAt = phase
    await assert.rejects(f.store.commit(request), hasCode('storage_io_failed'))
    const next = await f.reopen()
    assert.equal((await next.read()).status, phase < 3 ? 'recovery-required' : 'current')
    f.control.failAt = null
    await next.commit(request)
    assert.equal((await next.read()).domains.length, 1)
  })

  for (const action of ['begin', 'ack']) for (let phase = 1; phase <= 3; phase++)
    test(`interruption during ${action} phase ${phase} preserves or re-delivers pending data`, async () => {
      const f = await fixture('fs')
      await f.store.commit({ commitId: 'first', partitions: [await part()] })
      const flight = action === 'ack' ? await f.store.beginPending() : null
      f.control.failAt = f.control.phases + phase
      await assert.rejects(action === 'begin' ? f.store.beginPending() : f.store.acknowledge({
        operationId: flight.operation.id, operationDigest: flight.operationDigest }), hasCode('storage_io_failed'))
      f.control.failAt = null
      const next = await f.reopen()
      const redelivered = await next.beginPending()
      if (action === 'ack' && phase === 3) assert.equal(redelivered, null)
      else {
        assert.equal(redelivered.partitions[0].records.foodEntries[0].value.id, 'entry-1')
        if (flight) assert.deepEqual(redelivered, flight)
      }
      assert.equal((await next.read()).domains[0].records.foodEntries.length, 1)
    })

  test('a publication between GC planning and deletion invalidates the entire cleanup', async () => {
    const f = await fixture('fs'), other = await f.reopen()
    for (let i = 0; i < 3; i++) await f.store.commit({ commitId: `edit-${i}`, partitions: [await part(i)] })
    f.control.beforeCollect = async () => other.commit({ commitId: 'concurrent', partitions: [await part(3)] })
    await assert.rejects(f.store.collect(), hasCode('stale_root'))
    assert.equal((await f.store.read()).head.commitId, 'concurrent')
    f.control.beforeCollect = null
    await f.store.collect()
  })

  test('missing both roots does not allow reinitialization over previously published documents', async () => {
    const f = await fixture('idb')
    await f.store.commit({ commitId: 'first', partitions: [await part()] })
    await f.store.commit({ commitId: 'second', partitions: [await part(1)] })
    f.control.databases.values().next().value.stores.get('roots').clear()
    assert.equal((await f.store.read()).status, 'recovery-required')
    const before = await f.backend.snapshot()
    await assert.rejects(f.store.commit({ commitId: 'empty-reset', partitions: [] }), hasCode('recovery_required'))
    await assert.rejects(f.store.collect(), hasCode('recovery_required'))
    assert.deepEqual(await f.backend.snapshot(), before)
  })

  test('an interrupted initial write requires a replay preserving all staged documents', async () => {
    const f = await fixture('fs')
    const request = { commitId: 'first', partitions: [await part()] }
    f.control.failAt = 1
    await assert.rejects(f.store.commit(request), hasCode('storage_io_failed'))
    f.control.failAt = null
    const before = await f.backend.snapshot()
    await assert.rejects(f.store.commit({ commitId: 'different', partitions: [] }), hasCode('recovery_required'))
    assert.deepEqual(await f.backend.snapshot(), before)
    await f.store.commit(request)
    assert.equal((await f.store.read()).head.commitId, 'first')
  })

  test('a reader keeps a consistent byte snapshot while another connection publishes and collects', async () => {
    const f = await fixture('idb'), other = await f.reopen()
    await f.store.commit({ commitId: 'first', partitions: [await part()] })
    const original = f.backend.snapshot.bind(f.backend)
    f.backend.snapshot = async () => {
      const captured = await original()
      await other.commit({ commitId: 'second', partitions: [await part(1)] })
      await other.commit({ commitId: 'third', partitions: [await part(2)] })
      await other.collect()
      return captured
    }
    assert.equal((await f.store.read()).head.commitId, 'first')
    f.backend.snapshot = original
    assert.equal((await f.store.read()).head.commitId, 'third')
  })

  test('the document limit counts UTF-8 bytes before a physical write', async () => {
    const f = await fixture('idb')
    const root = JSON.stringify('é'.repeat(MAX_DOCUMENT_BYTES / 2))
    await assert.rejects(f.backend.publish({ expectedRoot: null, root, writes: [] }), hasCode('document_too_large'))
    assert.equal((await f.backend.snapshot()).root, null)
  })

  test('unavailable IDB and native bridge fail visibly without a volatile fallback', async () => {
    await assert.rejects(createNutritionLocalStore({ ...settings, backend: nutritionIdbBackend({ idb: null }) }), hasCode('storage_unavailable'))
    await assert.rejects(createNutritionLocalStore({ ...settings, backend: nutritionFsBackend({ loadPlugin: async () => { throw new Error('unavailable') } }) }), hasCode('storage_io_failed'))
  })

  test('IDB engines ignoring strict durability refuse writes rather than lowering guarantees', async () => {
    const f = await fixture('idb')
    f.control.durability = 'relaxed'
    await assert.rejects(f.store.commit({ commitId: 'first', partitions: [await part()] }), hasCode('unsupported_durability'))
    assert.equal((await f.store.read()).status, 'empty')
  })

  test('the durable clock advances past record and field stamps and survives reopening', async () => {
    const f = await fixture('idb')
    const edits = [{ collection: 'foodEntries', id: 'entry-1', stamp: stamp(20), fields: { quantity: stamp(100) } }]
    await f.store.commit({ commitId: 'stamped', partitions: [await part(1, { sync: { ...sync(1), edits } })] })
    assert.equal((await f.store.read()).counter, 101)
    assert.equal((await (await f.reopen()).read()).pendingOperations[0].stamp.counter, 101)
    await f.store.beginPending()
    assert.equal((await f.store.read()).counter, 102)
  })

  test('counter exhaustion refuses publication without changing durable data', async () => {
    const f = await fixture('idb')
    const edits = [{ collection: 'foodEntries', id: 'entry-1', stamp: stamp(Number.MAX_SAFE_INTEGER) }]
    await assert.rejects(f.store.commit({ commitId: 'overflow', partitions: [await part(1, { sync: { ...sync(1), edits } })] }), hasCode('counter_overflow'))
    assert.equal((await f.store.read()).status, 'empty')
  })

  test('native capacity does not report the unrelated WebView origin quota', async () => {
    const f = await fixture('fs')
    assert.deepEqual(await f.store.storageStatus({ storage: { estimate() { throw new Error('wrong quota') } } }),
      { backend: 'private-json', persistent: true, estimate: null })
  })

  test('corrupted snapshot references cannot be published or change the queue', async () => {
    const f = await fixture('idb')
    await f.store.commit({ commitId: 'first', partitions: [await part()] })
    const before = await f.backend.snapshot(), corrupted = await part(1)
    corrupted.records.foodEntries[0].snapshotRef = '0'.repeat(64)
    await assert.rejects(f.store.commit({ commitId: 'invalid', partitions: [reseal(corrupted)] }), hasCode('missing_snapshot'))
    assert.deepEqual(await f.backend.snapshot(), before)
  })

  test('physical immutable objects refuse replacement under an existing key', async () => {
    const f = await fixture('idb')
    await f.store.commit({ commitId: 'first', partitions: [await part()] })
    const before = await f.backend.snapshot(), row = before.objects[0]
    await assert.rejects(f.backend.publish({ expectedRoot: before.root, root: boundedJson(reseal({ ...JSON.parse(before.root), counter: 2 })),
      writes: [{ key: row.key, text: '{}' }] }), hasCode('immutable_object_conflict'))
    assert.deepEqual(await f.backend.snapshot(), before)
  })
})

test('2,000 offline publications compact the queue without expiring the frozen first bundle', async () => {
  const f = await fixture('idb')
  await f.store.commit({ commitId: 'first', partitions: [await part()] })
  const frozen = await f.store.beginPending()
  for (let i = 1; i <= 2000; i++) {
    await f.store.commit({ commitId: `offline-${i}`, partitions: [await part(i, {
      records: { foodEntries: [entry({ quantity: { amount: i, unit: 'g' } })] } })] })
    if (i % 100 === 0) await f.store.collect()
  }
  const state = await (await f.reopen()).read()
  assert.equal(state.pendingOperations.length, 2)
  assert.equal(state.domains[0].records.foodEntries[0].quantity.amount, 2000)
  assert.deepEqual(await f.store.beginPending(), frozen)
  assert.ok(new TextEncoder().encode(boundedJson(state.manifest)).length < 4096)
  assert.equal((await f.backend.snapshot()).objects.length, 5)
}, 180000)

test('ten-year partitioned history and recurring recipes survive storage, queue and GC', async () => {
  const started = performance.now(), metrics = { baseline: memoryUsage() }
  const f = await fixture('fs')
  const snapshot = createRecipeSnapshot(recipe()), expected = [], partitions = []
  // 120 monthly shards, 10 entries/day, 30 days/month = 36,000 complete food entries.
  for (let i = 0; i < 120; i++) {
    const month = `${2017 + Math.floor(i / 12)}-${String(i % 12 + 1).padStart(2, '0')}`
    const rows = Array.from({ length: 300 }, (_, j) => entry({ id: `${month}-${j}`, d: `${month}-01`, snapshot,
      quantity: { amount: 0.5, unit: 'serving' } }))
    expected.push(...rows)
    partitions.push(await part(0, { id: `journal-${month}-device-a-0`, records: { foodEntries: rows } }))
  }
  metrics.encodingMs = performance.now() - started
  let clock = performance.now()
  await f.store.commit({ commitId: 'five-years', partitions: partitions.slice(0, 60) })
  metrics.fiveYearCommitMs = performance.now() - clock; clock = performance.now()
  assert.equal((await f.store.read()).domains.flatMap(domain => domain.records.foodEntries).length, 18000)
  metrics.fiveYearReadMs = performance.now() - clock; clock = performance.now()
  await f.store.commit({ commitId: 'ten-years', partitions: partitions.slice(60) })
  metrics.tenYearCommitMs = performance.now() - clock; clock = performance.now()
  await f.store.collect()
  metrics.collectionMs = performance.now() - clock; clock = performance.now()
  const next = await f.reopen()
  metrics.coldOpenMs = performance.now() - clock; clock = performance.now()
  const state = await next.read()
  metrics.tenYearReadMs = performance.now() - clock
  assert.deepEqual(state.domains.flatMap(domain => domain.records.foodEntries), expected)
  assert.equal(state.pendingOperations.length, 1)
  assert.equal(state.pendingOperations[0].partitions.length, 120)
  assert.ok(new TextEncoder().encode(boundedJson(state.manifest)).length < MAX_DOCUMENT_BYTES)
  const bytes = await f.backend.snapshot()
  assert.equal(bytes.objects.filter(row => row.key.startsWith('p-')).length, 120)
  for (const row of bytes.objects.filter(row => row.key.startsWith('p-'))) {
    assert.equal(Object.keys(JSON.parse(row.text).snapshots).length, 1)
  }
  metrics.documentBytes = bytes.objects.reduce((sum, row) => sum + new TextEncoder().encode(row.text).length, 0)
  metrics.manifestBytes = new TextEncoder().encode(boundedJson(state.manifest)).length
  metrics.largestDocumentBytes = Math.max(...bytes.objects.map(row => new TextEncoder().encode(row.text).length))
  metrics.end = memoryUsage(); metrics.processPeakRssKiB = resourceUsage().maxRSS
  console.info('Nutrition ten-year synthetic benchmark (includes test fixtures):', JSON.stringify(metrics))
}, 600000)
