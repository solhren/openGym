import { describe, it } from 'vitest'
import assert from 'node:assert/strict'
import { prepareCommit, recoverCommit, assertPublishable, readManifest, readHead } from './persistence-commit.js'
import { encodePartition } from './serialization.js'
import { journal, library, namespace, sync, stamp, reseal, hasCode } from './persistence.test-util.js'
import { entry, freeze } from './fixtures.test-util.js'

const prepare = (partitions, overrides = {}) => prepareCommit({ namespace, generation: 'generation-1', commitId: 'commit-1',
  baseManifest: null, partitions, ...overrides })
const recover = (heads, manifests, partitions, overrides = {}) => recoverCommit({ namespace, generation: 'generation-1', heads, manifests, partitions, ...overrides })
async function initial() {
  const parts = [await encodePartition(journal()), await encodePartition(library())]
  return { parts, plan: await prepare(parts) }
}
async function next(base, overrides = {}) {
  const parts = [await encodePartition(journal({ records: { foodEntries: [entry({ note: 'New journal' })] }, sync: sync(1) })),
    await encodePartition(library({ sync: sync(1), extensions: { imported: true } }))]
  const plan = await prepare(parts, { commitId: 'commit-2', baseManifest: base.plan.manifest, ...overrides })
  return { parts, plan }
}

describe('nutrition multi-partition publication contract', () => {
  it('prepares and verifies a complete immutable commit without changing inputs', async () => {
    const { parts, plan } = await initial(), before = JSON.stringify(plan)
    const result = await assertPublishable(freeze(plan), { currentHead: null, partitions: freeze(parts) })
    assert.equal(result.status, 'current')
    assert.equal(result.domains.length, 2)
    assert.equal(plan.manifest.sequence, 0)
    assert.equal(plan.manifest.parentCommitId, null)
    assert.equal(plan.expectedHead, null)
    assert.equal(JSON.stringify(plan), before)
  })
  it('publishes a multi-partition update as one complete dataset', async () => {
    const base = await initial(), updated = await next(base)
    const result = await assertPublishable(updated.plan, { currentHead: base.plan.head, partitions: [...base.parts, ...updated.parts] })
    assert.equal(updated.plan.manifest.sequence, 1)
    assert.equal(updated.plan.manifest.parentCommitId, base.plan.manifest.commitId)
    assert.deepEqual(updated.plan.expectedHead, base.plan.head)
    assert.equal(result.domains.find(d => d.kind === 'journal').records.foodEntries[0].note, 'New journal')
    assert.equal(result.domains.find(d => d.kind === 'library').extensions.imported, true)
  })
  it('retains unchanged partition references in incremental commits', async () => {
    const base = await initial(), updated = await next(base)
    const plan = await prepare([updated.parts[0]], { commitId: 'commit-journal-only', baseManifest: base.plan.manifest })
    assert.equal(plan.writes.length, 1)
    assert.deepEqual(plan.manifest.partitions.find(p => p.id.startsWith('library-')), base.plan.manifest.partitions.find(p => p.id.startsWith('library-')))
    await assertPublishable(plan, { currentHead: base.plan.head, partitions: [...base.parts, updated.parts[0]] })
  })
  it('ignores prepared partitions and manifests if the new head was never published', async () => {
    const base = await initial(), updated = await next(base)
    const result = await recover([base.plan.head], [base.plan.manifest, updated.plan.manifest], [...base.parts, ...updated.parts])
    assert.equal(result.head.commitId, 'commit-1')
    assert.equal(result.domains.find(d => d.kind === 'journal').records.foodEntries[0].note, undefined)
  })
  for (const stage of ['before-blobs', 'one-blob', 'all-blobs', 'manifest', 'head-interrupted', 'head-published']) {
    it(`recovers one complete publication at interruption stage: ${stage}`, async () => {
      const base = await initial(), updated = await next(base)
      const writes = stage === 'before-blobs' ? [] : stage === 'one-blob' ? [updated.parts[0]] : updated.parts
      const manifests = ['before-blobs', 'one-blob', 'all-blobs'].includes(stage) ? [base.plan.manifest] : [base.plan.manifest, updated.plan.manifest]
      const heads = stage === 'head-interrupted' ? [{ ...updated.plan.head, integrity: { algorithm: 'sha256', digest: '0'.repeat(64) } }, base.plan.head] :
        stage === 'head-published' ? [updated.plan.head, base.plan.head] : [base.plan.head]
      const result = await recover(heads, manifests, [...base.parts, ...writes])
      const published = stage === 'head-published'
      assert.equal(result.head.commitId, published ? 'commit-2' : 'commit-1')
      assert.deepEqual(result.partitions.map(part => part.integrity.digest).sort(), (published ? updated.parts : base.parts).map(part => part.integrity.digest).sort())
      assert.equal(result.status, stage === 'head-interrupted' ? 'fallback' : 'current')
    })
  }
  it('does not adopt prepared data after interruption of the first publication', async () => {
    const base = await initial()
    await assert.rejects(recover([], [base.plan.manifest], base.parts), hasCode('no_complete_commit'))
  })
  it('falls back to the entire previous commit if publication was interrupted', async () => {
    const base = await initial(), updated = await next(base)
    const result = await recover([updated.plan.head, base.plan.head], [updated.plan.manifest, base.plan.manifest], [...base.parts, updated.parts[0]])
    assert.equal(result.status, 'fallback')
    assert.equal(result.head.commitId, 'commit-1')
    assert.ok(result.issues.some(i => i.code === 'missing_partition'))
    assert.equal(result.domains.find(d => d.kind === 'journal').records.foodEntries[0].note, undefined)
    assert.equal(result.domains.find(d => d.kind === 'library').extensions.imported, false)
  })
  it('falls back when the current head is malformed or corrupt', async () => {
    const base = await initial()
    const bad = { ...base.plan.head, commitId: 'corrupt' }
    const result = await recover([bad, base.plan.head], [base.plan.manifest], base.parts)
    assert.equal(result.status, 'fallback')
    assert.ok(result.issues.some(i => i.code === 'checksum_mismatch'))
  })
  it('falls back when the current manifest is missing', async () => {
    const base = await initial(), updated = await next(base)
    const result = await recover([updated.plan.head, base.plan.head], [base.plan.manifest], base.parts)
    assert.equal(result.status, 'fallback')
    assert.ok(result.issues.some(i => i.code === 'missing_manifest'))
  })
  it('does not interpret total loss as an empty nutrition history', async () => {
    const base = await initial()
    await assert.rejects(recover([base.plan.head], [base.plan.manifest], []), hasCode('no_complete_commit'))
    await assert.rejects(recover([], [], []), hasCode('no_complete_commit'))
  })
  it('allows an explicitly initialized empty dataset', async () => {
    const plan = await prepare([])
    const result = await recover([plan.head], [plan.manifest], [])
    assert.deepEqual(result.domains, [])
    assert.equal(result.status, 'current')
  })
  it('rejects premature publication of an incomplete multi-partition update', async () => {
    const base = await initial(), updated = await next(base)
    await assert.rejects(assertPublishable(updated.plan, { currentHead: base.plan.head, partitions: [...base.parts, updated.parts[0]] }), hasCode('missing_partition'))
  })
  it('rejects a stale head after another writer has published', async () => {
    const base = await initial(), updated = await next(base)
    await assert.rejects(assertPublishable(updated.plan, { currentHead: updated.plan.head, partitions: [...base.parts, ...updated.parts] }), hasCode('stale_head'))
    await assert.rejects(assertPublishable(base.plan, { currentHead: updated.plan.head, partitions: base.parts }), hasCode('stale_head'))
  })
  it('requires the losing sibling writer to replan after a competing publication', async () => {
    const base = await initial(), writerA = await next(base)
    const bPart = await encodePartition(library({ sync: { ...sync(1), writeId: 'writer-b' } }))
    const writerB = await prepare([bPart], { commitId: 'writer-b-commit', baseManifest: base.plan.manifest })
    const all = [...base.parts, ...writerA.parts, bPart]
    // Both checks succeed against the same snapshot: the adapter MUST make comparison and
    // publication atomic. Once A has won, B cannot publish its previously prepared plan.
    await assertPublishable(writerA.plan, { currentHead: base.plan.head, partitions: all })
    await assertPublishable(writerB, { currentHead: base.plan.head, partitions: all })
    await assert.rejects(assertPublishable(writerB, { currentHead: writerA.plan.head, partitions: all }), hasCode('stale_head'))
    const replanned = await prepare([await encodePartition(library({ sync: { ...sync(2), writeId: 'writer-b-next' } }))],
      { commitId: 'writer-b-replanned', baseManifest: writerA.plan.manifest })
    const result = await assertPublishable(replanned, { currentHead: writerA.plan.head, partitions: [...all, ...replanned.writes] })
    assert.equal(result.domains.find(d => d.kind === 'journal').records.foodEntries[0].note, 'New journal')
  })
  it('prepares deterministic retry bytes and recognizes a complete publication after a lost acknowledgement', async () => {
    const base = await initial(), updated = await next(base)
    const retry = await next(base)
    assert.deepEqual(retry.plan, updated.plan)
    await assert.rejects(assertPublishable(retry.plan, { currentHead: updated.plan.head, partitions: [...base.parts, ...updated.parts] }), hasCode('stale_head'))
    const recovered = await recover([updated.plan.head], [updated.plan.manifest], updated.parts)
    assert.deepEqual(recovered.head, retry.plan.head)
    assert.equal(recovered.manifest.sequence, 1)
    assert.equal(recovered.domains.find(d => d.kind === 'journal').records.foodEntries.length, 1)
  })
  it('rejects a publication plan with a substituted parent head', async () => {
    const base = await initial(), updated = await next(base)
    const tampered = { ...updated.plan, expectedHead: null }
    await assert.rejects(assertPublishable(tampered, { currentHead: null, partitions: updated.parts }), hasCode('unexpected_parent'))
  })
  it('rejects a publication plan combining a foreign head with otherwise valid data', async () => {
    const base = await initial(), updated = await next(base)
    const foreign = reseal({ ...base.plan.head, namespace: { serverOrigin: null, profileId: 'another-user' } })
    const tampered = { ...updated.plan, expectedHead: foreign }
    await assert.rejects(assertPublishable(tampered, { currentHead: foreign, partitions: updated.parts }), hasCode('namespace_mismatch'))
  })
  it('rejects partition and manifest corruption during recovery', async () => {
    const base = await initial(), corrupted = JSON.parse(JSON.stringify(base.parts))
    corrupted[0].records.foodEntries[0].value.note = 'Corrupted'
    await assert.rejects(recover([base.plan.head], [base.plan.manifest], corrupted), hasCode('checksum_mismatch'))
    const badManifest = { ...base.plan.manifest, sequence: 5 }
    await assert.rejects(recover([base.plan.head], [badManifest], base.parts), hasCode('checksum_mismatch'))
  })
  it('checks head and manifest identity even if checksums are valid', async () => {
    const base = await initial(), badHead = reseal({ ...base.plan.head, commitId: 'wrong-commit' })
    await assert.rejects(recover([badHead], [base.plan.manifest], base.parts), hasCode('head_manifest_mismatch'))
  })
  it('checks partition revisions against manifest descriptors', async () => {
    const base = await initial(), manifest = reseal({ ...base.plan.manifest,
      partitions: base.plan.manifest.partitions.map(p => ({ ...p, revision: 1, writeId: 'other-write' })) })
    const head = reseal({ ...base.plan.head, manifestDigest: manifest.integrity.digest })
    await assert.rejects(recover([head], [manifest], base.parts), hasCode('revision_mismatch'))
  })
  it('prevents account and server namespace mixing', async () => {
    const base = await initial()
    await assert.rejects(prepare(base.parts, { namespace: { serverOrigin: null, profileId: 'another-user' } }), hasCode('namespace_mismatch'))
    await assert.rejects(recover([base.plan.head], [base.plan.manifest], base.parts, { namespace: { serverOrigin: 'https://gym.example', profileId: namespace.profileId } }), hasCode('namespace_mismatch'))
  })
  it('never resurrects a previous generation after a reset', async () => {
    const base = await initial()
    await assert.rejects(prepare(base.parts, { generation: 'reset-2', baseManifest: base.plan.manifest }), hasCode('generation_mismatch'))
    await assert.rejects(recover([base.plan.head], [base.plan.manifest], base.parts, { generation: 'reset-2' }), hasCode('generation_mismatch'))
    const fresh = await prepare([], { generation: 'reset-2', commitId: 'reset-commit' })
    const result = await recover([fresh.head, base.plan.head], [fresh.manifest, base.plan.manifest], base.parts, { generation: 'reset-2' })
    assert.deepEqual(result.domains, [])
  })
  for (const [name, change, code] of [
    ['nonadvancing revision', p => { p.sync = sync() }, 'nonadvancing_revision'],
    ['reused write id', p => { p.sync = { ...sync(2), writeId: 'write-1' } }, 'reused_write_id'],
  ]) it(`rejects ${name}`, async () => {
    const base = await initial(), updated = await next(base)
    const domain = journal({ sync: sync(2) }); change(domain)
    await assert.rejects(prepare([await encodePartition(domain)], { commitId: 'commit-3', baseManifest: updated.plan.manifest }), hasCode(code))
  })
  it('rejects duplicate partition ids and reused commit ids', async () => {
    const base = await initial()
    await assert.rejects(prepare([base.parts[0], base.parts[0]]), hasCode('duplicate_partition_id'))
    await assert.rejects(prepare([], { baseManifest: base.plan.manifest }), hasCode('reused_commit_id'))
  })
  it('rejects a publication sequence overflow', async () => {
    const base = await initial(), exhausted = reseal({ ...base.plan.manifest, sequence: Number.MAX_SAFE_INTEGER, parentCommitId: 'older' })
    await assert.rejects(prepare([], { commitId: 'overflow-commit', baseManifest: exhausted }), hasCode('counter_overflow'))
  })
  it('rejects duplicate records across different partitions', async () => {
    const a = await encodePartition(journal()), b = await encodePartition(journal({ id: 'journal-2026-10-other-shard' }))
    const plan = await prepare([a, b])
    await assert.rejects(assertPublishable(plan, { currentHead: null, partitions: [a, b] }), hasCode('duplicate_dataset_id'))
  })
  it('rejects live records conflicting with a deletion in another partition', async () => {
    const a = await encodePartition(journal()), b = await encodePartition(journal({ id: 'journal-2026-10-other-shard', records: { foodEntries: [] },
      sync: { ...sync(), tombstones: [{ collection: 'foodEntries', id: 'entry-1', stamp: stamp() }] } }))
    const plan = await prepare([a, b])
    await assert.rejects(assertPublishable(plan, { currentHead: null, partitions: [a, b] }), hasCode('dataset_live_tombstone_conflict'))
  })
  it('rejects duplicate deletion ownership across partitions', async () => {
    const deleted = { ...sync(), tombstones: [{ collection: 'foodEntries', id: 'removed', stamp: stamp() }] }
    const a = await encodePartition(journal({ records: { foodEntries: [] }, sync: deleted }))
    const b = await encodePartition(journal({ id: 'journal-2026-10-other-shard', records: { foodEntries: [] }, sync: deleted }))
    const plan = await prepare([a, b])
    await assert.rejects(assertPublishable(plan, { currentHead: null, partitions: [a, b] }), hasCode('duplicate_dataset_tombstone'))
  })
  it('records explicit physical partition removal without deleting existing blobs', async () => {
    const base = await initial(), plan = await prepare([], { commitId: 'remove-library', baseManifest: base.plan.manifest,
      removePartitionIds: [base.parts[1].id] })
    const result = await assertPublishable(plan, { currentHead: base.plan.head, partitions: base.parts })
    assert.equal(result.domains.length, 1)
    assert.equal(base.parts.length, 2)
    await assert.rejects(prepare([], { commitId: 'invalid-remove', baseManifest: base.plan.manifest, removePartitionIds: ['library-missing'] }), hasCode('invalid_partition_removal'))
  })
  it('pins and retains queued immutable partition versions until explicit acknowledgement', async () => {
    const base = await initial(), op = { id: 'op-1', stamp: stamp(), partitions: base.plan.manifest.partitions, removedPartitionIds: [] }
    const queued = await prepare([], { commitId: 'queue-commit', baseManifest: base.plan.manifest, pendingOperations: [op] })
    const updated = await next({ ...base, plan: queued }, { commitId: 'after-offline-edit' })
    assert.deepEqual(updated.plan.manifest.pendingOperations, [op])
    const result = await assertPublishable(updated.plan, { currentHead: queued.head, partitions: [...base.parts, ...updated.parts] })
    assert.equal(result.pendingPartitions.length, 2)
    await assert.rejects(assertPublishable(updated.plan, { currentHead: queued.head, partitions: updated.parts }), hasCode('missing_partition'))
    const acked = await prepare([], { commitId: 'ack-commit', baseManifest: updated.plan.manifest, pendingOperations: [] })
    const afterAck = await assertPublishable(acked, { currentHead: updated.plan.head, partitions: updated.parts })
    assert.deepEqual(afterAck.pendingPartitions, [])
  })
  it('checks duplicate pending operation ids and unsupported versions', async () => {
    const base = await initial(), op = { id: 'op', stamp: stamp(), partitions: [], removedPartitionIds: [] }
    await assert.rejects(prepare([], { pendingOperations: [op, op] }), hasCode('invalid_operation_id'))
    await assert.rejects(readManifest(reseal({ ...base.plan.manifest, storageVersion: 2 })), hasCode('unsupported_storage_version'))
    await assert.rejects(readHead(reseal({ ...base.plan.head, domainVersion: 2 })), hasCode('unsupported_domain_version'))
  })
  for (const field of ['pendingOperations', 'removePartitionIds']) {
    it(`rejects explicit null instead of defaulting ${field}`, async () => {
      await assert.rejects(prepare([], { [field]: null }), hasCode('array_required'))
    })
  }
  for (const location of ['head-storage', 'head-domain', 'manifest-storage', 'manifest-domain', 'partition-storage', 'partition-domain', 'partition-legacy']) {
    it(`blocks recovery instead of rolling back an unsupported format at ${location}`, async () => {
      const base = await initial(), updated = await next(base)
      const field = location.endsWith('domain') ? 'domainVersion' : 'storageVersion'
      const version = location === 'partition-legacy' ? 0 : 2
      let head = updated.plan.head, manifest = updated.plan.manifest
      const parts = [...updated.parts]
      if (location.startsWith('head')) head = reseal({ ...head, [field]: version })
      else {
        if (location.startsWith('manifest')) manifest = reseal({ ...manifest, [field]: version })
        else {
          parts[0] = reseal({ ...parts[0], [field]: version })
          manifest = reseal({ ...manifest, partitions: manifest.partitions.map(ref => ref.id === parts[0].id ? { ...ref, digest: parts[0].integrity.digest } : ref) })
        }
        head = reseal({ ...head, manifestDigest: manifest.integrity.digest })
      }
      const code = location === 'partition-legacy' ? 'committed_migration_required' :
        field === 'domainVersion' ? 'unsupported_domain_version' : 'unsupported_storage_version'
      await assert.rejects(recover([head, base.plan.head], [manifest, base.plan.manifest], [...base.parts, ...parts]), hasCode(code))
    })
  }
  it('blocks recovery when a business record requires an unsupported domain version', async () => {
    const base = await initial(), updated = await next(base)
    const raw = JSON.parse(JSON.stringify(updated.parts[0]))
    raw.records.foodEntries[0].value.schemaVersion = 2
    const part = reseal(raw), manifest = reseal({ ...updated.plan.manifest,
      partitions: updated.plan.manifest.partitions.map(ref => ref.id === part.id ? { ...ref, digest: part.integrity.digest } : ref) })
    const head = reseal({ ...updated.plan.head, manifestDigest: manifest.integrity.digest })
    await assert.rejects(recover([head, base.plan.head], [manifest, base.plan.manifest], [...base.parts, part, updated.parts[1]]), hasCode('unsupported_version'))
  })
  it('refuses oversized pending metadata without dropping operations or changing the base', async () => {
    const base = await initial(), before = JSON.stringify(base.plan.manifest)
    const pendingOperations = Array.from({ length: 3000 }, (_, i) => ({ id: `offline-${i}`, stamp: stamp(i + 1),
      partitions: [base.plan.manifest.partitions[0]], removedPartitionIds: [] }))
    await assert.rejects(prepare([], { commitId: 'oversized-queue', baseManifest: base.plan.manifest, pendingOperations }), hasCode('document_too_large'))
    assert.equal(pendingOperations.length, 3000)
    assert.equal(JSON.stringify(base.plan.manifest), before)
  })
})
