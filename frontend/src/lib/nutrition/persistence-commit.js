import { NutritionValidationError } from './contracts.js'
import {
  STORAGE_VERSION, DOMAIN_VERSION, HASH_PATTERN, NutritionPersistenceError, check, isText,
  isCounter, exactKeys, jsonClone, sealDocument, verifiedDocument, validateScope, validateStamp,
  validateRevision, validateNamespace, sameNamespace, partitionKind,
} from './persistence-contract.js'
import { migratePartition, decodePartition } from './serialization.js'

export const MANIFEST_FORMAT = 'opengym-nutrition-manifest'
export const HEAD_FORMAT = 'opengym-nutrition-head'
const descriptorOf = partition => ({ id: partition.id, digest: partition.integrity.digest,
  revision: partition.sync.revision, writeId: partition.sync.writeId })

function validateDescriptors(descriptors, path) {
  check(Array.isArray(descriptors), path, 'array_required')
  const ids = new Set()
  descriptors.forEach((ref, i) => {
    const p = `${path}[${i}]`
    exactKeys(ref, ['id', 'digest', 'revision', 'writeId'], p)
    partitionKind(ref.id)
    check(typeof ref.digest === 'string' && HASH_PATTERN.test(ref.digest), `${p}.digest`, 'invalid_digest')
    validateRevision(ref, p)
    check(!ids.has(ref.id), `${p}.id`, 'duplicate_partition_id'); ids.add(ref.id)
  })
}

export async function readManifest(value) {
  const manifest = await verifiedDocument(value, MANIFEST_FORMAT)
  exactKeys(manifest, ['format', 'storageVersion', 'domainVersion', 'namespace', 'generation', 'commitId',
    'parentCommitId', 'sequence', 'partitions', 'pendingOperations', 'integrity'], '$')
  validateScope(manifest)
  check(isText(manifest.commitId), 'commitId', 'text_required')
  check(isCounter(manifest.sequence), 'sequence', 'safe_integer_required')
  check(manifest.sequence === 0 ? manifest.parentCommitId === null : isText(manifest.parentCommitId), 'parentCommitId', 'invalid_parent')
  check(manifest.commitId !== manifest.parentCommitId, 'parentCommitId', 'self_parent')
  validateDescriptors(manifest.partitions, 'partitions')
  check(Array.isArray(manifest.pendingOperations), 'pendingOperations', 'array_required')
  const ids = new Set()
  manifest.pendingOperations.forEach((op, i) => {
    const p = `pendingOperations[${i}]`
    exactKeys(op, ['id', 'stamp', 'partitions', 'removedPartitionIds'], p)
    check(isText(op.id) && !ids.has(op.id), `${p}.id`, 'invalid_operation_id'); ids.add(op.id)
    validateStamp(op.stamp, `${p}.stamp`)
    validateDescriptors(op.partitions, `${p}.partitions`)
    check(Array.isArray(op.removedPartitionIds), `${p}.removedPartitionIds`, 'array_required')
    const removed = new Set()
    op.removedPartitionIds.forEach(id => {
      partitionKind(id)
      check(!removed.has(id) && !op.partitions.some(ref => ref.id === id), p, 'conflicting_partition_operation')
      removed.add(id)
    })
  })
  return manifest
}

export async function readHead(value) {
  const head = await verifiedDocument(value, HEAD_FORMAT)
  exactKeys(head, ['format', 'storageVersion', 'domainVersion', 'namespace', 'generation', 'commitId', 'manifestDigest', 'integrity'], '$')
  validateScope(head)
  check(isText(head.commitId), 'commitId', 'text_required')
  check(typeof head.manifestDigest === 'string' && HASH_PATTERN.test(head.manifestDigest), 'manifestDigest', 'invalid_digest')
  return head
}

async function headOf(manifest) {
  return sealDocument({ format: HEAD_FORMAT, storageVersion: STORAGE_VERSION, domainVersion: DOMAIN_VERSION,
    namespace: manifest.namespace, generation: manifest.generation, commitId: manifest.commitId,
    manifestDigest: manifest.integrity.digest })
}
function sameScope(value, namespace, generation) {
  check(sameNamespace(value.namespace, namespace), 'namespace', 'namespace_mismatch')
  check(value.generation === generation, 'generation', 'generation_mismatch')
}

/** Pure planning only. Physical publication must compare expectedHead, persist all immutable
 * partition versions and the manifest, then replace the head LAST under one writer/CAS. */
export async function prepareCommit(input) {
  const captured = jsonClone(input)
  exactKeys(captured, ['namespace', 'generation', 'commitId', 'baseManifest', 'partitions', 'removePartitionIds', 'pendingOperations'], '$',
    ['namespace', 'generation', 'commitId', 'baseManifest', 'partitions'])
  const { namespace, generation, commitId } = captured
  validateScope({ namespace, generation, domainVersion: DOMAIN_VERSION })
  check(isText(commitId), 'commitId', 'text_required')
  const base = captured.baseManifest === null ? null : await readManifest(captured.baseManifest)
  if (base) {
    sameScope(base, namespace, generation)
    check(base.commitId !== commitId, 'commitId', 'reused_commit_id')
    check(base.sequence < Number.MAX_SAFE_INTEGER, 'sequence', 'counter_overflow')
  }
  check(Array.isArray(captured.partitions), 'partitions', 'array_required')
  const writes = [], changed = new Set(), refs = new Map((base?.partitions ?? []).map(ref => [ref.id, ref]))
  for (const value of captured.partitions) {
    const partition = await migratePartition(value)
    sameScope(partition, namespace, generation)
    check(!changed.has(partition.id), 'partitions', 'duplicate_partition_id'); changed.add(partition.id)
    const previous = refs.get(partition.id)
    if (previous) {
      check(partition.sync.revision > previous.revision, `partitions.${partition.id}`, 'nonadvancing_revision')
      check(partition.sync.writeId !== previous.writeId, `partitions.${partition.id}`, 'reused_write_id')
    }
    refs.set(partition.id, descriptorOf(partition)); writes.push(partition)
  }
  const removed = Object.hasOwn(captured, 'removePartitionIds') ? captured.removePartitionIds : []
  check(Array.isArray(removed), 'removePartitionIds', 'array_required')
  const seen = new Set()
  for (const id of removed) {
    partitionKind(id)
    check(!seen.has(id) && !changed.has(id) && refs.has(id), 'removePartitionIds', 'invalid_partition_removal')
    seen.add(id); refs.delete(id)
  }
  const manifest = await sealDocument({ format: MANIFEST_FORMAT, storageVersion: STORAGE_VERSION, domainVersion: DOMAIN_VERSION,
    namespace, generation, commitId, parentCommitId: base?.commitId ?? null, sequence: base ? base.sequence + 1 : 0,
    partitions: Array.from(refs.values()).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    pendingOperations: Object.hasOwn(captured, 'pendingOperations') ? captured.pendingOperations : base?.pendingOperations ?? [] })
  await readManifest(manifest)
  return { expectedHead: base ? await headOf(base) : null, manifest, head: await headOf(manifest), writes }
}

function validateDataset(domains) {
  const live = new Set(), deleted = new Set()
  for (const domain of domains) {
    for (const [collection, rows] of Object.entries(domain.records)) {
      const ids = collection === 'nutritionSettings' ? ['$'] : rows.map(row => row.id)
      for (const id of ids) {
        const key = JSON.stringify([collection, id])
        check(!live.has(key), `records.${collection}.${id}`, 'duplicate_dataset_id'); live.add(key)
      }
    }
    for (const marker of domain.sync.tombstones) {
      const key = JSON.stringify([marker.collection, marker.id])
      check(!deleted.has(key), 'sync.tombstones', 'duplicate_dataset_tombstone'); deleted.add(key)
    }
  }
  for (const key of deleted) check(!live.has(key), 'sync.tombstones', 'dataset_live_tombstone_conflict')
}

/** Only heads already published by an adapter are candidates. Orphan manifests/prepared
 * blobs cannot win. A fallback selects a whole commit, never a mixture of partition versions. */
export async function recoverCommit(input) {
  const captured = jsonClone(input)
  exactKeys(captured, ['namespace', 'generation', 'heads', 'manifests', 'partitions'], '$')
  validateNamespace(captured.namespace)
  check(isText(captured.generation), 'generation', 'text_required')
  for (const key of ['heads', 'manifests', 'partitions']) check(Array.isArray(captured[key]), key, 'array_required')
  const issues = []
  for (let index = 0; index < captured.heads.length; index++) {
    try {
      const head = await readHead(captured.heads[index])
      sameScope(head, captured.namespace, captured.generation)
      const rawManifest = captured.manifests.find(m => m?.integrity?.digest === head.manifestDigest)
      check(!!rawManifest, 'manifest', 'missing_manifest')
      const manifest = await readManifest(rawManifest)
      sameScope(manifest, captured.namespace, captured.generation)
      check(manifest.commitId === head.commitId, 'commitId', 'head_manifest_mismatch')
      const partitions = [], pendingPartitions = [], domains = [], loaded = new Map()
      const load = async ref => {
        const key = JSON.stringify([ref.id, ref.digest])
        if (loaded.has(key)) {
          check(loaded.get(key).sync.revision === ref.revision && loaded.get(key).sync.writeId === ref.writeId, 'partitions', 'revision_mismatch')
          return loaded.get(key)
        }
        const raw = captured.partitions.find(p => p?.id === ref.id && p?.integrity?.digest === ref.digest)
        check(!!raw, `partitions.${ref.id}`, 'missing_partition')
        // Committed bytes must already use the manifest's format; migration needs a new commit.
        check(raw.storageVersion === STORAGE_VERSION, `partitions.${ref.id}`, raw.storageVersion === 0 ? 'committed_migration_required' : 'unsupported_storage_version')
        const part = await migratePartition(raw)
        sameScope(part, manifest.namespace, manifest.generation)
        check(part.sync.revision === ref.revision && part.sync.writeId === ref.writeId, `partitions.${ref.id}`, 'revision_mismatch')
        loaded.set(key, part)
        return part
      }
      for (const ref of manifest.partitions) {
        const part = await load(ref)
        partitions.push(part); domains.push(await decodePartition(part))
      }
      validateDataset(domains)
      for (const op of manifest.pendingOperations) for (const ref of op.partitions) {
        const part = await load(ref)
        if (!pendingPartitions.some(p => p.id === part.id && p.integrity.digest === part.integrity.digest)) pendingPartitions.push(part)
      }
      return { status: index === 0 ? 'current' : 'fallback', head, manifest, partitions, pendingPartitions, domains, issues }
    } catch (error) {
      if (!(error instanceof NutritionValidationError)) throw error
      const candidateIssues = error.issues.map(issue => ({ ...issue, path: `heads[${index}].${issue.path}` }))
      // A newer/legacy format is not missing or corrupt data. Falling back here could let an
      // older application publish over valid history it cannot read. Require an explicit upgrade.
      if (candidateIssues.some(issue => ['unsupported_storage_version', 'unsupported_domain_version', 'unsupported_version', 'committed_migration_required'].includes(issue.code))) {
        throw new NutritionPersistenceError([...issues, ...candidateIssues])
      }
      issues.push(...candidateIssues)
    }
  }
  throw new NutritionPersistenceError([...issues, { path: 'heads', code: 'no_complete_commit' }])
}

export async function assertPublishable(planInput, availableInput) {
  const plan = jsonClone(planInput), available = jsonClone(availableInput)
  exactKeys(plan, ['expectedHead', 'manifest', 'head', 'writes'], 'plan')
  exactKeys(available, ['currentHead', 'partitions'], 'available')
  const expected = plan.expectedHead === null ? null : await readHead(plan.expectedHead)
  const current = available.currentHead === null ? null : await readHead(available.currentHead)
  check(JSON.stringify(expected) === JSON.stringify(current), 'expectedHead', 'stale_head')
  const manifest = await readManifest(plan.manifest)
  if (expected) sameScope(expected, manifest.namespace, manifest.generation)
  check(expected ? manifest.parentCommitId === expected.commitId && manifest.sequence > 0 :
    manifest.parentCommitId === null && manifest.sequence === 0, 'manifest.parentCommitId', 'unexpected_parent')
  const result = await recoverCommit({ namespace: manifest.namespace, generation: manifest.generation,
    heads: [plan.head], manifests: [manifest], partitions: available.partitions })
  check(result.status === 'current', 'head', 'incomplete_commit')
  return result
}
