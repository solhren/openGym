import assert from 'node:assert/strict'
import { test } from 'vitest'
import { writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createNutritionLocalStore } from './local-store.js'
import { nutritionFsBackend } from './local-store-fs.js'
import { encodePartition } from './serialization.js'
import { journal, namespace, sync, hasCode } from './persistence.test-util.js'
import { diskBridge } from './local-storage.test-util.js'

for (const [nativeCode, expectedCode] of [['QUOTA', 'quota_exceeded'], ['IO_FAILED', 'storage_io_failed']]) {
  test(`native ${nativeCode} preserves committed files and the frozen offline payload`, async () => {
    const disk = await diskBridge()
    const backend = nutritionFsBackend({ loadPlugin: async () => disk.plugin })
    let store
    try {
      store = await createNutritionLocalStore({ namespace, generation: 'generation-1', deviceId: 'device-a', backend })
      await store.commit({ commitId: 'first', partitions: [await encodePartition(journal())] })
      const frozen = await store.beginPending(), before = await backend.snapshot()
      // Simulate the native OS refusing the next write (out of space / inaccessible directory).
      const original = disk.plugin.publish
      disk.plugin.publish = async () => { throw Object.assign(new Error('native write refused'), { code: nativeCode }) }
      await assert.rejects(store.commit({ commitId: 'second', partitions: [await encodePartition(journal({ sync: sync(1) }))] }), hasCode(expectedCode))
      assert.deepEqual(await backend.snapshot(), before)
      assert.deepEqual(await store.beginPending(), frozen)
      disk.plugin.publish = original
      await store.commit({ commitId: 'second', partitions: [await encodePartition(journal({ sync: sync(1) }))] })
      assert.equal((await store.read()).domains[0].sync.revision, 1)
      assert.deepEqual(await store.beginPending(), frozen)
    } finally { store?.close(); await disk.cleanup() }
  })
}

test('malformed native UTF-8 is refused even when lossy decoding would preserve a valid checksum', async () => {
  const disk = await diskBridge()
  const backend = nutritionFsBackend({ loadPlugin: async () => disk.plugin })
  let store
  try {
    store = await createNutritionLocalStore({ namespace, generation: 'generation-1', deviceId: 'device-a', backend })
    await store.commit({ commitId: 'replacement-\uFFFD', partitions: [await encodePartition(journal())] })
    const path = join(disk.control.base, store.scopeId, 'root.json'), original = await readFile(path)
    const damaged = Buffer.from(original)
    const offset = damaged.indexOf(Buffer.from('\uFFFD'))
    assert.ok(offset >= 0)
    damaged[offset] = 0xFF
    const shortened = Buffer.concat([damaged.subarray(0, offset + 1), damaged.subarray(offset + 3)])
    assert.equal(shortened.toString('utf8'), original.toString('utf8')) // same JSON/checksum under lossy decoding
    await writeFile(path, shortened)
    await assert.rejects(store.read(), hasCode('storage_io_failed'))
    await assert.rejects(store.collect(), hasCode('storage_io_failed'))
    assert.deepEqual(await readFile(path), shortened)
  } finally { store?.close(); await disk.cleanup() }
})

for (const action of ['commit', 'begin', 'ack']) {
  test(`native late lock/close failure during ${action} is reported and safely resolved by rereading`, async () => {
    const disk = await diskBridge()
    const backend = nutritionFsBackend({ loadPlugin: async () => disk.plugin })
    let store
    try {
      const options = { namespace, generation: 'generation-1', deviceId: 'device-a' }
      store = await createNutritionLocalStore({ ...options, backend })
      await store.commit({ commitId: 'first', partitions: [await encodePartition(journal())] })
      let frozen = null
      if (action !== 'begin') frozen = await store.beginPending()
      const receipt = frozen && { operationId: frozen.operation.id, operationDigest: frozen.operationDigest }
      const request = { commitId: 'second', partitions: [await encodePartition(journal({ sync: sync(1) }))] }
      const original = disk.plugin.publish
      disk.plugin.publish = async input => {
        await original(input)
        throw Object.assign(new Error('late native unlock/close failure'), { code: 'IO_FAILED' })
      }
      await assert.rejects(action === 'commit' ? store.commit(request) : action === 'begin' ? store.beginPending() : store.acknowledge(receipt),
        hasCode('storage_io_failed'))
      disk.plugin.publish = original
      store.close()
      store = await createNutritionLocalStore({ ...options, backend: nutritionFsBackend({ loadPlugin: async () => disk.plugin }) })
      if (action === 'commit') {
        assert.equal((await store.commit(request)).repeated, true)
        assert.deepEqual(await store.beginPending(), frozen)
        assert.equal((await store.read()).pendingOperations.length, 2)
      } else if (action === 'begin') {
        assert.ok((await store.read()).inFlightId)
        assert.deepEqual(await store.beginPending(), await store.beginPending())
      } else {
        assert.equal((await store.acknowledge(receipt)).repeated, true)
        assert.equal((await store.read()).pendingOperations.length, 0)
      }
      await store.collect()
      assert.equal((await store.read()).status, 'current')
    } finally { store?.close(); await disk.cleanup() }
  })
}
