import { check, contentHash, exactKeys, jsonClone, sameNamespace, verifiedDocument, HASH_PATTERN, COLLECTIONS, isObject, isText } from './persistence-contract.js'
import { readHead, recoverCommit } from './persistence-commit.js'
import { encodePartition } from './serialization.js'

export const RECEIPT_FORMAT = 'opengym-nutrition-server-receipt'
export const publicationRequest = plan => ({ expectedHead: plan.expectedHead, manifest: plan.manifest, head: plan.head })
export const domainContent = domain => ({ ...domain, sync: { edits: domain.sync.edits, tombstones: domain.sync.tombstones } })
export const same = (a, b) => JSON.stringify(jsonClone(a)) === JSON.stringify(jsonClone(b))
export function scoped(value, scope) {
  check(sameNamespace(value.namespace, scope.namespace) && value.generation === scope.generation, 'sync', 'scope_mismatch')
}

export function preserveConflictArchives(before, after) {
  const archives = new Map(after.flatMap(p => Object.entries(p.extensions?.nutritionSyncConflicts?.records ?? {})))
  for (const part of before) for (const [hash, record] of Object.entries(part.extensions?.nutritionSyncConflicts?.records ?? {}))
    check(archives.has(hash) && same(archives.get(hash), record), 'remote', 'server_conflict_history_missing')
}

export async function validateConflictArchives(domains) {
  for (const part of domains) {
    if (!Object.hasOwn(part.extensions ?? {}, 'nutritionSyncConflicts')) continue
    const archive = part.extensions.nutritionSyncConflicts
    exactKeys(archive, ['version', 'records'], 'extensions.nutritionSyncConflicts')
    check(archive.version === 1, 'extensions.nutritionSyncConflicts', 'unsupported_conflict_archive')
    check(isObject(archive.records), 'extensions.nutritionSyncConflicts', 'invalid_conflict_archive')
    for (const [hash, variant] of Object.entries(archive.records)) {
      check(HASH_PATTERN.test(hash) && await contentHash(variant) === hash, 'extensions', 'conflict_archive_checksum_mismatch')
      exactKeys(variant, ['collection', 'id', 'record', 'marker'], 'conflict')
      check(COLLECTIONS.includes(variant.collection) && isText(variant.id) && isObject(variant.record) &&
        (variant.collection === 'nutritionSettings' ? variant.id === '$' : variant.id === variant.record.id), 'conflict', 'invalid_conflict_archive')
      const journal = variant.collection === 'foodEntries'
      // Reuse exactly the business/marker rules instead of maintaining a weaker archive
      // validator. Archived snapshots are inline independent values, not live references.
      await encodePartition({ namespace: part.namespace, generation: part.generation,
        id: journal ? 'journal-2000-01-conflict-validation' : 'library-conflict-validation', kind: journal ? 'journal' : 'library',
        records: { [variant.collection]: variant.collection === 'nutritionSettings' ? variant.record : [variant.record] },
        sync: { revision: 0, writeId: null, edits: variant.marker === null ? [] : [variant.marker], tombstones: [] } })
    }
  }
}

// A clean outbox does not authorize accepting an older restored value with the same
// clock. A changed value must advance its marker, or explicitly retain the old record.
export function preserveAcknowledgedValues(before, after) {
  const index = domains => {
    const rows = new Map()
    for (const part of domains) for (const [collection, values] of Object.entries(part.records)) {
      for (const value of collection === 'nutritionSettings' ? [values] : values) {
        const id = collection === 'nutritionSettings' ? '$' : value.id
        rows.set(JSON.stringify([collection, id]), { collection, id, value,
          marker: part.sync.edits.find(m => m.collection === collection && m.id === id) })
      }
    }
    return rows
  }
  const next = index(after), archived = after.flatMap(p => Object.values(p.extensions?.nutritionSyncConflicts?.records ?? {}))
  for (const [key, row] of index(before)) {
    const other = next.get(key)
    if (!other || same(row.value, other.value) || archived.some(a => a.collection === row.collection && a.id === row.id && same(a.record, row.value))) continue
    check(!!row.marker && !!other.marker, 'remote', 'server_untracked_modification')
    for (const field of new Set([...Object.keys(row.value), ...Object.keys(other.value)])) {
      const present = Object.hasOwn(row.value, field), nextPresent = Object.hasOwn(other.value, field)
      if (present === nextPresent && (!present || same(row.value[field], other.value[field]))) continue
      const previous = row.marker.fields?.[field] ?? row.marker.stamp, stamp = other.marker.fields?.[field] ?? other.marker.stamp
      check(stamp.counter > previous.counter, 'remote', 'server_untracked_modification')
    }
  }
}

export async function validateDelivery(delivery, scope) {
  exactKeys(delivery, ['operationId', 'operationDigest', 'expectedHead', 'head', 'requestDigest', 'uploads'], 'delivery')
  check(typeof delivery.operationId === 'string' && delivery.operationId.trim(), 'delivery', 'invalid_operation_id')
  for (const key of ['operationDigest', 'requestDigest'])
    check(typeof delivery[key] === 'string' && HASH_PATTERN.test(delivery[key]), `delivery.${key}`, 'invalid_digest')
  scoped(await readHead(delivery.head), scope)
  if (delivery.expectedHead !== null) scoped(await readHead(delivery.expectedHead), scope)
  check(Array.isArray(delivery.uploads) && delivery.uploads.every(digest => typeof digest === 'string' && HASH_PATTERN.test(digest)) &&
    new Set(delivery.uploads).size === delivery.uploads.length, 'delivery.uploads', 'invalid_digest')
}

export async function resolveDelivery(delivery, scope, manifest, partitions, operation) {
  await validateDelivery(delivery, scope)
  check(operation?.id === delivery.operationId && await contentHash(operation) === delivery.operationDigest, 'delivery', 'delivery_operation_mismatch')
  const graph = await recoverCommit({ ...scope, heads: [delivery.head], manifests: [manifest], partitions })
  await validateConflictArchives(graph.domains)
  check(graph.manifest.pendingOperations.length === 0, 'delivery', 'server_outbox_not_empty')
  check(delivery.uploads.every(digest => graph.partitions.some(p => p.integrity.digest === digest)), 'delivery.uploads', 'missing_partition')
  check(graph.manifest.parentCommitId === (delivery.expectedHead?.commitId ?? null) &&
    (delivery.expectedHead !== null || graph.manifest.sequence === 0), 'delivery', 'unexpected_parent')
  const request = publicationRequest({ ...delivery, manifest: graph.manifest })
  check(await contentHash(request) === delivery.requestDigest, 'delivery', 'delivery_request_mismatch')
  return { ...delivery, request, partitions: graph.partitions }
}

export async function validateNutritionReceipt(input, delivery, scope) {
  const response = jsonClone(input)
  exactKeys(response, ['head', 'receipt', 'repeated'], 'response')
  check(typeof response.repeated === 'boolean', 'response.repeated', 'boolean_required')
  const receipt = await verifiedDocument(response.receipt, RECEIPT_FORMAT)
  exactKeys(receipt, ['format', 'storageVersion', 'domainVersion', 'namespace', 'generation', 'commitId', 'requestDigest', 'head', 'integrity'], 'receipt')
  check(receipt.domainVersion === 1, 'receipt', 'unsupported_domain_version'); scoped(receipt, scope)
  scoped(await readHead(response.head), scope); scoped(await readHead(receipt.head), scope)
  check(same(response.head, delivery.head) && same(receipt.head, delivery.head) &&
    receipt.commitId === delivery.head.commitId && receipt.requestDigest === delivery.requestDigest, 'receipt', 'receipt_mismatch')
  return receipt
}
