import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'vitest'
import { writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { createNutritionLocalStore } from './local-store.js'
import { nutritionIdbBackend } from './local-store-idb.js'
import { nutritionFsBackend } from './local-store-fs.js'
import { transactionalIdb, diskBridge } from './local-storage.test-util.js'
import { encodePartition } from './serialization.js'
import { entry } from './fixtures.test-util.js'
import { journal, library, namespace, sync, hasCode } from './persistence.test-util.js'
import { prepareCommit } from './persistence-commit.js'
import { boundedJson } from './persistence-contract.js'
import { makeLocalRoot, documentKey } from './local-contract.js'

const options = { namespace, generation: 'generation-1', deviceId: 'device-a' }, cleanups = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
const encoded = (month, rows, revision = 0) => encodePartition(journal({ id: `journal-${month}-device-a-0`,
  records: { foodEntries: rows }, sync: sync(revision) }))
async function fixture(kind, cache) {
  const engine = kind === 'idb' ? transactionalIdb() : await diskBridge()
  if (engine.cleanup) cleanups.push(engine.cleanup)
  const factory = () => kind === 'idb' ? nutritionIdbBackend({ idb: engine.idb }) : nutritionFsBackend({ loadPlugin: async () => engine.plugin })
  const backend = factory(), store = await createNutritionLocalStore({ ...options, backend, cache })
  cleanups.push(() => store.close())
  const reopen = async () => {
    const backend = factory()
    // Opening must not enumerate/read all document bodies through the old API.
    backend.snapshot = () => { throw new Error('eager snapshot is forbidden during opening/period reads') }
    const store = await createNutritionLocalStore({ ...options, backend, cache })
    cleanups.push(() => store.close()); return { backend, store }
  }
  const damage = async (key, text) => {
    if (kind === 'idb') {
      const database = engine.control.databases.get(`opengym-nutrition-${store.scopeId}`)
      const table = ['root', 'previous', 'index'].includes(key) ? 'roots' : 'documents'
      if (text === null) database.stores.get(table).delete(key)
      else database.stores.get(table).set(key, text)
    } else {
      const path = join(engine.control.base, store.scopeId, `${key}.json`)
      if (text === null) await unlink(path)
      else await writeFile(path, text)
    }
  }
  return { backend, store, engine, reopen, damage }
}

for (const kind of ['idb', 'fs']) describe(`progressive Nutrition reads (${kind})`, () => {
  test('library-only reads avoid eager/journal reads, validate snapshots and isolate the cache', async () => {
    const f = await fixture(kind)
    await f.store.commit({ commitId: 'ui-library', partitions: [await encodePartition(library()), await encoded('2026-10', [entry()])] })
    const next = await f.reopen(), original = next.backend.readDocuments.bind(next.backend), reads = []
    next.backend.readDocuments = input => { reads.push(...input.keys); return original(input) }
    const result = await next.store.readLibrary()
    assert.equal(reads.length, 1); assert.equal(result.domains.length, 1)
    result.domains[0].records.customFoods[0].name = 'tampered'
    assert.equal((await next.store.readLibrary()).domains[0].records.customFoods[0].name, 'Oats')
    assert.equal(reads.length, 1)
    const digest = (await f.store.inspect()).manifest.partitions.find(ref => ref.id.startsWith('library-')).digest
    await f.damage(documentKey('p', digest), '{}'); next.store.invalidateCache()
    await assert.rejects(next.store.readLibrary(), hasCode('unsupported_storage_version'))
  })
  test('complete verification detects duplicate identities across separately valid shards', async () => {
    const f = await fixture(kind)
    const corrupt = await prepareCommit({ namespace, generation: options.generation, commitId: 'invalid', baseManifest: null,
      partitions: [await encoded('2026-10', [entry()]), await encoded('2026-11', [entry()])] })
    const root = await makeLocalRoot(options, corrupt.head, 0, null, null, '0'.repeat(64))
    await f.backend.publish({ expectedRoot: null, root: boundedJson(root), writes: [
      ...corrupt.writes.map(part => ({ key: documentKey('p', part.integrity.digest), text: boundedJson(part) })),
      { key: documentKey('m', corrupt.manifest.integrity.digest), text: boundedJson(corrupt.manifest) }] })
    const next = await f.reopen()
    await assert.rejects(next.store.verify(), hasCode('duplicate_dataset_id'))
    await assert.rejects(next.store.readForRestore({ maxBytes: 32 * 1024 * 1024 }), hasCode('no_complete_commit'))
    await assert.rejects(next.store.readDay('2026-10-10'), hasCode('duplicate_dataset_id'))
  })

  test('restore captures validate backup metadata in a pending-only version before exposing writable data', async () => {
    const f = await fixture(kind)
    const pending = await encodePartition(journal({ extensions: { nutritionBackupRestores: { version: 99, records: {} } } }))
    const current = await encoded('2026-10', [entry()], 1)
    const operation = { id: 'frozen', stamp: { counter: 1, deviceId: 'device-a' },
      partitions: [{ id: pending.id, digest: pending.integrity.digest, revision: pending.sync.revision, writeId: pending.sync.writeId }], removedPartitionIds: [] }
    const plan = await prepareCommit({ namespace, generation: options.generation, commitId: 'invalid-pending-metadata',
      baseManifest: null, partitions: [current], pendingOperations: [operation] })
    const root = await makeLocalRoot(options, plan.head, 1, null, operation.id, '0'.repeat(64))
    await f.backend.publish({ expectedRoot: null, root: boundedJson(root), writes: [
      ...[current, pending].map(part => ({ key: documentKey('p', part.integrity.digest), text: boundedJson(part) })),
      { key: documentKey('m', plan.manifest.integrity.digest), text: boundedJson(plan.manifest) }] })
    await assert.rejects(f.store.verify(), hasCode('unsupported_backup_metadata'))
    // Local recovery wraps exhausted candidates as no_complete_commit, whereas the
    // streaming verifier exposes the exact unsupported metadata issue above.
    await assert.rejects(f.store.readForRestore({ maxBytes: 32 * 1024 * 1024 }), hasCode('no_complete_commit'))
    await assert.rejects(f.store.commit({ commitId: 'must-refuse', partitions: [], expectedHead: plan.head }, { maxBytes: 32 * 1024 * 1024 }), hasCode('no_complete_commit'))
    assert.equal((await f.store.inspect()).head.commitId, plan.head.commitId)
  })

  test('failed derived-index writes cannot roll back history or remove the persistent outbox', async () => {
    const f = await fixture(kind), original = f.backend.saveIndex.bind(f.backend)
    f.backend.saveIndex = async () => { throw new Error('derived index unavailable') }
    const result = await f.store.commit({ commitId: 'saved', partitions: [await encoded('2026-10', [entry()])] })
    assert.ok(result.indexIssue)
    assert.equal((await f.store.read()).pendingOperations.length, 1)
    assert.equal((await f.store.readDay('2026-10-10')).entries.length, 1)
    f.backend.saveIndex = original
    assert.equal((await f.store.verify()).status, 'current')
    assert.equal((await f.store.read()).head.commitId, 'saved')
  })

  test('invalid cache configuration closes no account and closed readers cannot be reused', async () => {
    const f = await fixture(kind)
    await assert.rejects(createNutritionLocalStore({ ...options, backend: f.backend, cache: { maxBytes: -1 } }), hasCode('invalid_cache_limit'))
    assert.equal((await f.store.inspect()).status, 'empty')
    f.store.close()
    for (const action of [() => f.store.inspect(), () => f.store.verify(), () => f.store.readDay('2026-10-10'),
      () => f.store.readMonth('2026-10'), () => f.store.readPeriod({ start: '2026-10-01', end: '2026-10-10' })]) {
      await assert.rejects(action(), hasCode('storage_closed'))
    }
    assert.throws(() => f.store.invalidateCache(), hasCode('storage_closed'))
  })

  test('opens from headers and reads exactly the required journal shards, including misplaced dates', async () => {
    const f = await fixture(kind)
    const a = entry(), b = entry({ id: 'oct-11', d: '2026-10-11' }), c = entry({ id: 'legacy', d: '2026-10-10' })
    await f.store.commit({ commitId: 'history', partitions: [await encoded('2026-10', [a, b]),
      await encoded('2020-02', [c]), await encoded('2026-11', [entry({ id: 'nov', d: '2026-11-01' })]), await encodePartition(library())] })
    const next = await f.reopen(), reads = []
    const original = next.backend.readDocuments.bind(next.backend)
    next.backend.readDocuments = input => { reads.push(...input.keys); return original(input) }
    assert.equal((await next.store.inspect()).status, 'partially-verified')
    assert.deepEqual((await next.store.readDay('2026-10-10')).entries, [a, c].sort((a, b) => a.id.localeCompare(b.id)))
    assert.equal(reads.length, 2)
    assert.equal((await next.store.readMonth('2026-10')).entries.length, 3)
    assert.equal(reads.length, 2) // cached domains, but an atomic root guard still runs
    const period = await next.store.readPeriod({ start: '2026-10-11', end: '2026-11-01' })
    assert.deepEqual(period.entries.map(row => row.id), ['oct-11', 'nov'])
    assert.equal(reads.length, 3)
    assert.equal(period.verification, 'selected-partitions')
  })

  test('bounds the LRU by entries/expanded bytes and never exposes mutable cached snapshots', async () => {
    const f = await fixture(kind, { maxEntries: 1, maxBytes: 100000 })
    await f.store.commit({ commitId: 'history', partitions: [await encoded('2026-10', [entry()]),
      await encoded('2026-11', [entry({ id: 'nov', d: '2026-11-01' })])] })
    const next = await f.reopen(), reads = []
    const original = next.backend.readDocuments.bind(next.backend)
    next.backend.readDocuments = input => { reads.push(...input.keys); return original(input) }
    const first = await next.store.readMonth('2026-10'); first.entries[0].snapshot.name = 'mutated'
    assert.equal((await next.store.readDay('2026-10-10')).entries[0].snapshot.name, 'Oats')
    assert.equal(reads.length, 1)
    await next.store.readMonth('2026-11'); await next.store.readMonth('2026-10')
    assert.equal(reads.length, 3)
    const status = next.store.cacheStatus()
    assert.equal(status.entries, 1); assert.ok(status.bytes <= status.maxBytes)
  })

  test('cache-disabled reads fetch again and malformed limits/periods are rejected', async () => {
    const f = await fixture(kind, { maxBytes: 0 })
    await f.store.commit({ commitId: 'history', partitions: [await encoded('2026-10', [entry()])] })
    const next = await f.reopen(), original = next.backend.readDocuments.bind(next.backend)
    let reads = 0
    next.backend.readDocuments = input => { reads += input.keys.length; return original(input) }
    await next.store.readDay('2026-10-10'); await next.store.readDay('2026-10-10')
    assert.equal(reads, 2); assert.equal(next.store.cacheStatus().bytes, 0)
    await assert.rejects(next.store.readDay('2026-02-30'), hasCode('invalid_period'))
    await assert.rejects(next.store.readMonth('2026-13'), hasCode('invalid_month'))
    await assert.rejects(next.store.readPeriod({ start: '2026-11-01', end: '2026-10-10' }), hasCode('invalid_period'))
    await assert.rejects(next.backend.readDocuments({ expectedRoot: null, expectedPrevious: null,
      keys: Array.from({ length: 5 }, (_, i) => `p-${String(i).repeat(64)}`) }), hasCode('invalid_read_batch'))
  })

  test('byte limits evict decoded domains and oversized domains bypass the cache', async () => {
    const f = await fixture(kind)
    await f.store.commit({ commitId: 'history', partitions: [await encoded('2026-10', [entry()]),
      await encoded('2026-11', [entry({ id: 'nov', d: '2026-11-01' })])] })
    await f.store.readMonth('2026-10')
    const singleSize = f.store.cacheStatus().bytes
    assert.ok(singleSize > 0)
    const bounded = await createNutritionLocalStore({ ...options, cache: { maxBytes: singleSize + 100, maxEntries: 8 },
      backend: kind === 'idb' ? nutritionIdbBackend({ idb: f.engine.idb }) : nutritionFsBackend({ loadPlugin: async () => f.engine.plugin }) })
    cleanups.push(() => bounded.close())
    await bounded.readMonth('2026-10'); await bounded.readMonth('2026-11')
    assert.equal(bounded.cacheStatus().entries, 1)
    assert.ok(bounded.cacheStatus().bytes <= singleSize + 100)
    const tiny = await createNutritionLocalStore({ ...options, cache: { maxBytes: 1 },
      backend: kind === 'idb' ? nutritionIdbBackend({ idb: f.engine.idb }) : nutritionFsBackend({ loadPlugin: async () => f.engine.plugin }) })
    cleanups.push(() => tiny.close())
    assert.equal((await tiny.readMonth('2026-10')).entries.length, 1)
    assert.equal(tiny.cacheStatus().entries, 0)
    assert.equal(tiny.cacheStatus().bytes, 0)
  })

  test('rebuilds missing/corrupt indexes, keeps v1 misplaced entries and preserves frozen operations', async () => {
    const f = await fixture(kind)
    await f.store.commit({ commitId: 'history', partitions: [await encoded('2020-01', [entry()])] })
    const frozen = await f.store.beginPending()
    for (const text of [null, '{broken']) {
      await f.damage('index', text)
      const next = await f.reopen()
      assert.equal((await next.store.readDay('2026-10-10')).entries.length, 1)
      assert.equal((await next.store.verify()).status, 'current')
    }
    assert.deepEqual(await f.store.beginPending(), frozen)
    assert.equal((await f.store.read()).pendingOperations.length, 1)
  })

  test('a write or restoration invalidates cached data; full verification always ignores the cache', async () => {
    const f = await fixture(kind)
    const first = await encoded('2026-10', [entry()])
    await f.store.commit({ commitId: 'first', partitions: [first] })
    const next = await f.reopen()
    await next.store.readDay('2026-10-10')
    await f.store.commit({ commitId: 'updated', partitions: [await encoded('2026-10', [entry({ quantity: { amount: 90, unit: 'g' } })], 1)] })
    assert.equal((await next.store.readDay('2026-10-10')).entries[0].quantity.amount, 90)
    const manifest = (await next.store.inspect()).manifest, key = `p-${manifest.partitions[0].digest}`
    await f.damage(key, '{corrupt')
    await assert.rejects(next.store.verify(), hasCode('invalid_json'))
    assert.equal(next.store.cacheStatus().entries, 0)
    await assert.rejects(next.store.readDay('2026-10-10'), hasCode('invalid_json'))
    next.store.invalidateCache() // restore entrypoint, even if a restore reused the same root
    assert.equal(next.store.cacheStatus().entries, 0)
    await assert.rejects(next.store.readDay('2026-10-10'), hasCode('invalid_json'))
    await assert.rejects(f.store.collect(), hasCode('recovery_required'))
  })

  test('never mixes periods from different publications when a writer intervenes between batches', async () => {
    const f = await fixture(kind)
    const rows = month => [entry({ id: month, d: `${month}-10` })]
    await f.store.commit({ commitId: 'first', partitions: [await encoded('2026-10', rows('2026-10')), await encoded('2026-11', rows('2026-11'))] })
    const next = await f.reopen(), original = next.backend.readDocuments.bind(next.backend)
    let changed = false
    next.backend.readDocuments = async input => {
      const result = await original(input)
      if (input.keys.length && !changed) {
        changed = true
        await f.store.commit({ commitId: 'second', partitions: [await encoded('2026-10', rows('2026-10').map(row => ({ ...row, meal: 'dinner' })), 1),
          await encoded('2026-11', rows('2026-11').map(row => ({ ...row, meal: 'dinner' })), 1)] })
        await f.store.collect()
      }
      return result
    }
    const result = await next.store.readPeriod({ start: '2026-10-01', end: '2026-11-30' })
    assert.equal(result.head.commitId, 'second'); assert.ok(result.entries.every(row => row.meal === 'dinner'))
  })

  test('headers/selected reads never authorize a write over a corrupt unvisited partition', async () => {
    const f = await fixture(kind)
    const second = await encoded('2026-11', [entry({ id: 'nov', d: '2026-11-01' })])
    await f.store.commit({ commitId: 'history', partitions: [await encoded('2026-10', [entry()]), second] })
    await f.damage(`p-${second.integrity.digest}`, '{broken')
    const before = await f.backend.snapshot(), next = await f.reopen()
    assert.equal((await next.store.readMonth('2026-10')).entries.length, 1)
    assert.equal((await next.store.inspect()).status, 'partially-verified')
    await assert.rejects(f.store.commit({ commitId: 'overwrite', partitions: [] }), hasCode('no_complete_commit'))
    await assert.rejects(f.store.collect(), hasCode('no_complete_commit'))
    assert.deepEqual(await f.backend.snapshot(), before)
  })

  test('closing during a copied batch cannot return data or discard a frozen operation', async () => {
    const f = await fixture(kind)
    await f.store.commit({ commitId: 'history', partitions: [await encoded('2026-10', [entry()])] })
    const frozen = await f.store.beginPending(), next = await f.reopen()
    const original = next.backend.readDocuments.bind(next.backend)
    next.backend.readDocuments = async input => {
      const copied = await original(input)
      next.store.close()
      return copied
    }
    await assert.rejects(next.store.readDay('2026-10-10'), hasCode('storage_closed'))
    const restored = await f.reopen()
    assert.equal((await restored.store.readDay('2026-10-10')).entries.length, 1)
    assert.deepEqual(await f.store.beginPending(), frozen)
  })

  if (kind === 'idb') test('an aborted selected-read transaction returns no success and preserves pending data', async () => {
    const f = await fixture(kind)
    await f.store.commit({ commitId: 'history', partitions: [await encoded('2026-10', [entry()])] })
    const frozen = await f.store.beginPending(), next = await f.reopen()
    const original = next.backend.readDocuments.bind(next.backend)
    next.backend.readDocuments = async input => {
      const connection = f.engine.control.connections.at(-1), transaction = connection.transaction.bind(connection)
      connection.transaction = (...args) => {
        const tx = transaction(...args)
        queueMicrotask(() => connection.forceClose())
        return tx
      }
      return original(input)
    }
    await assert.rejects(next.store.readDay('2026-10-10'), hasCode('storage_io_failed'))
    assert.equal(next.store.cacheStatus().entries, 0)
    assert.deepEqual(await f.store.beginPending(), frozen)
    const restored = await f.reopen()
    assert.equal((await restored.store.readMonth('2026-10')).entries.length, 1)
  })
})
