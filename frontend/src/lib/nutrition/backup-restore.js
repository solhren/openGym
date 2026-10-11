import { canonicalJson, check, contentHash, exactKeys, jsonClone, COLLECTIONS } from './persistence-contract.js'
import { encodePartition, decodePartition } from './serialization.js'
import { mergeNutritionDomains } from './sync-merge.js'
import { validateConflictArchives } from './sync-contract.js'
import { BACKUP_METADATA, unionBackupMetadata } from './backup-history.js'
import { keyOf, RECEIPTS, PREPARATIONS, safeBackupValue } from './backup-contract.js'
import { restorationArchive } from './backup-archive.js'

const same = (a, b) => canonicalJson(a) === canonicalJson(b)
const index = domains => {
  const records = new Map(), deleted = new Set()
  for (const part of domains) {
    const edits = new Map(part.sync.edits.map(m => [keyOf(m.collection, m.id), m]))
    for (const [collection, rows] of Object.entries(part.records)) for (const row of collection === 'nutritionSettings' ? [rows] : rows) {
      const id = collection === 'nutritionSettings' ? '$' : row.id, key = keyOf(collection, id)
      check(!records.has(key), 'restore', 'duplicate_dataset_id')
      records.set(key, { collection, id, record: row, part, marker: edits.get(key) ?? null })
    }
    for (const m of part.sync.tombstones) deleted.add(keyOf(m.collection, m.id))
  }
  return { records, deleted }
}

export function readRestoreReceipt(domains, restoreKey, name = RECEIPTS) {
  const receipts = domains.flatMap(part => Object.entries(part.extensions?.[name]?.records ?? {})).filter(([key]) => key === restoreKey)
  check(receipts.every(([, row]) => same(row, receipts[0][1])), 'restore', 'backup_metadata_collision')
  return receipts[0]?.[1] ?? null
}
export async function restoreBaselineDigest(domains) {
  const normalized = jsonClone(domains).map(part => {
    part.sync = { edits: part.sync.edits, tombstones: part.sync.tombstones }
    if (part.extensions) { delete part.extensions[RECEIPTS]; delete part.extensions[PREPARATIONS]; if (!Object.keys(part.extensions).length) delete part.extensions }
    return part
  }).filter(part => !(['library-backup-restores', 'library-backup-preparations'].includes(part.id) &&
    !Object.keys(part.records).length && !part.extensions && !part.sync.edits.length && !part.sync.tombstones.length))
  normalized.sort((a, b) => a.id.localeCompare(b.id))
  return contentHash(normalized)
}

/** Prepare an immutable, CAS-bound local publication. Archive clocks are evidence only:
 * newly applied rows get target-device clocks, and imported deletions are informational. */
export async function prepareNutritionRestore({ archive, state, scope, deviceId, restoreId, mode = 'merge', choices = {}, allowReplace = false }) {
  check(['empty', 'merge', 'replace'].includes(mode), 'restore', 'invalid_restore_mode')
  check(mode !== 'replace' || allowReplace === true, 'restore', 'replace_requires_explicit_intent')
  choices = safeBackupValue(choices, 512 * 1024)
  check(choices && !Array.isArray(choices) && typeof choices === 'object', 'restore', 'invalid_restore_choices')
  const requestDigest = await contentHash({ archive: archive.digest, mode, choices, allowReplace }), restoreKey = await contentHash({ restoreId })
  const commitId = `restore-${restoreKey}`, expectedHead = state.head
  const receipt = readRestoreReceipt(state.domains, restoreKey)
  if (receipt) {
    check(receipt.requestDigest === requestDigest, 'restore', 'reused_restore_id')
    return { restoreKey, requestDigest, commitId, expectedHead, repeated: true, conflicts: [], operations: { additions: 0, replacements: 0, deletions: 0 }, partitions: [] }
  }
  check(state.status !== 'recovery-required' || state.head === null && state.issues.every(i => i.code === 'unpublished_documents'), 'restore', 'recovery_required')
  const local = jsonClone(state.domains), target = index(local), source = index(archive.current)
  const preparation = readRestoreReceipt(local, restoreKey, PREPARATIONS)
  const baseDigest = await restoreBaselineDigest(local)
  if (preparation) {
    check(preparation.requestDigest === requestDigest, 'restore', 'reused_restore_id')
    check(preparation.baseDigest === baseDigest, 'restore', 'restore_prepared_base_changed')
  }
  const preparationOnly = preparation && state.pendingOperations.every(op => !op.removedPartitionIds.length &&
    op.partitions.every(ref => ref.id === 'library-backup-preparations'))
  if (mode === 'empty') check(target.records.size === 0 && target.deleted.size === 0 &&
    (state.pendingOperations.length === 0 || preparationOnly), 'restore', 'restore_requires_empty_storage')
  let counter = state.counter ?? 0
  if (target.records.size) counter = Math.max(counter, 1)
  for (const part of local) for (const marker of [...part.sync.edits, ...part.sync.tombstones])
    counter = Math.max(counter, marker.stamp.counter, ...Object.values(marker.fields ?? {}).map(s => s.counter))
  check(counter < Number.MAX_SAFE_INTEGER, 'restore', 'counter_overflow')
  const stamp = { counter: counter + 1, deviceId }, incoming = new Map(), conflicts = [], usedChoices = new Set()
  const operations = { additions: 0, replacements: 0, deletions: 0 }
  const partOf = original => {
    if (!incoming.has(original.id)) incoming.set(original.id, { id: original.id, kind: original.kind, ...scope,
      records: {}, sync: { revision: 0, writeId: null, edits: [], tombstones: [] } })
    const part = incoming.get(original.id)
    for (const collection of Object.keys(original.records)) if (collection !== 'nutritionSettings') part.records[collection] ??= []
    return part
  }
  const retain = restorationArchive({ scope, restoreKey, incoming, existing: local,
    reservedIds: new Set([...local, ...archive.current, ...archive.retained].map(p => p.id)) })
  const archiveRow = async (_, row) => retain(row)
  // Whole frozen/queued/delivery versions are preserved as complete inline variants, not as
  // transplanted device operations. Imported permanent deletes are retained informationally.
  for (const original of [...archive.current, ...archive.retained]) {
    const part = partOf(original)
    for (const [name, extension] of Object.entries(original.extensions ?? {})) {
      if (name === 'nutritionSyncConflicts') {
        for (const row of Object.values(extension.records)) await retain(row)
        continue
      }
      part.extensions ??= {}
      if (BACKUP_METADATA.includes(name)) {
        if (name === RECEIPTS || name === PREPARATIONS) continue
        part.extensions[name] = unionBackupMetadata(part.extensions[name], extension, name)
      } else {
        check(!Object.hasOwn(part.extensions, name) || same(part.extensions[name], extension), 'restore', 'extension_conflict')
        Object.defineProperty(part.extensions, name, { value: jsonClone(extension), enumerable: true, configurable: true, writable: true })
      }
    }
    for (const marker of original.sync.tombstones) {
      const value = { collection: marker.collection, id: marker.id, stamp: marker.stamp }
      part.extensions ??= {}; part.extensions.nutritionBackupTombstones ??= { version: 1, records: {} }
      part.extensions.nutritionBackupTombstones.records[await contentHash(value)] = jsonClone(value)
    }
    if (archive.retained.includes(original)) for (const row of index([original]).records.values()) await archiveRow(part, row)
  }
  const occupied = new Set([...target.records.keys(), ...target.deleted, ...source.records.keys()])
  for (const [key, row] of source.records) {
    const prior = target.records.get(key), tombstoned = target.deleted.has(key), choice = choices[key]
    if (Object.hasOwn(choices, key)) {
      usedChoices.add(key)
      check(choice && typeof choice === 'object', 'restore', 'invalid_restore_choice')
      exactKeys(choice, ['action', 'newId'], 'choice', ['action'])
      check(['keep-local', 'use-backup', 'copy-backup'].includes(choice.action), 'choice', 'invalid_restore_choice')
      check(choice.action === 'copy-backup' ? typeof choice.newId === 'string' && choice.newId.trim().length > 0 : !Object.hasOwn(choice, 'newId'), 'choice', 'invalid_restore_choice')
    }
    const divergent = tombstoned || prior && !same(prior.record, row.record)
    if (divergent && mode !== 'replace' && !choice) {
      conflicts.push({ key, collection: row.collection, id: row.id, kind: tombstoned ? 'permanently-deleted-id' : 'different-record',
        actions: tombstoned ? ['keep-local', ...(row.collection !== 'nutritionSettings' ? ['copy-backup'] : [])] : ['keep-local', 'use-backup', ...(row.collection !== 'nutritionSettings' ? ['copy-backup'] : [])] })
      continue
    }
    const part = partOf(row.part)
    if (choice?.action === 'keep-local') { await archiveRow(part, row); continue }
    if (tombstoned && choice?.action !== 'copy-backup') {
      conflicts.push({ key, collection: row.collection, id: row.id, kind: 'permanently-deleted-id', actions: ['keep-local', 'copy-backup'] }); continue
    }
    let record = row.record, id = row.id
    if (choice?.action === 'copy-backup') {
      check(row.collection !== 'nutritionSettings', 'restore', 'singleton_cannot_copy')
      id = choice.newId; const newKey = keyOf(row.collection, id)
      check(!occupied.has(newKey), 'restore', 'restore_id_collision'); occupied.add(newKey)
      record = { ...record, id }; operations.additions++
    } else if (prior && same(prior.record, record)) continue
    else if (prior) {
      // v1 has no general field-erasure operation. A new id faithfully copies that record;
      // merging a missing optional field must not falsely advertise exact replacement.
      if (Object.keys(prior.record).some(field => !Object.hasOwn(record, field))) {
        conflicts.push({ key, collection: row.collection, id, kind: 'field-erasure-requires-new-id', actions: ['keep-local', 'copy-backup'] }); continue
      }
      // Synthesize only the target's previously unmarked marker, never trust archive clocks.
      if (!prior.marker) { prior.marker = { collection: row.collection, id, stamp: { counter: counter || 1, deviceId } }; prior.part.sync.edits.push(prior.marker) }
      operations.replacements++
    } else operations.additions++
    if (row.collection === 'nutritionSettings') part.records[row.collection] = record
    else { part.records[row.collection] ??= []; part.records[row.collection].push(record) }
    const fields = prior?.marker?.fields ? Object.fromEntries(Object.keys(prior.marker.fields).map(field => [field, stamp])) : null
    part.sync.edits.push({ collection: row.collection, id, stamp, ...(fields ? { fields } : {}) })
  }
  check(Object.keys(choices).every(key => usedChoices.has(key)), 'choices', 'unused_restore_choice')
  if (conflicts.length) return { restoreKey, requestDigest, commitId, expectedHead, conflicts, operations, partitions: [] }
  if (mode === 'replace') for (const [key, row] of target.records) {
    if (source.records.has(key)) continue
    await archiveRow(partOf(row.part), row)
    const rows = row.part.records[row.collection]
    if (row.collection === 'nutritionSettings') delete row.part.records[row.collection]
    else row.part.records[row.collection] = rows.filter(record => record.id !== row.id)
    row.part.sync.edits = row.part.sync.edits.filter(m => keyOf(m.collection, m.id) !== key)
    row.part.sync.tombstones.push({ collection: row.collection, id: row.id, stamp }); operations.deletions++
  }
  const merged = await mergeNutritionDomains({ remote: local, local: [...incoming.values()], writeId: commitId })
  const receiptPart = merged.domains.find(p => p.id === 'library-backup-restores') ?? { id: 'library-backup-restores', kind: 'library', ...scope,
    records: {}, sync: { revision: 1, writeId: commitId, edits: [], tombstones: [] } }
  if (!merged.domains.includes(receiptPart)) merged.domains.push(receiptPart)
  receiptPart.extensions ??= {}; receiptPart.extensions[RECEIPTS] ??= { version: 1, records: {} }
  receiptPart.extensions[RECEIPTS].records[restoreKey] = { requestDigest }
  await validateConflictArchives(merged.domains)
  const partitions = []
  for (const part of merged.domains) {
    const old = state.domains.find(p => p.id === part.id)
    if (old && same({ ...old, sync: null }, { ...part, sync: null }) && same(old.sync.edits, part.sync.edits) && same(old.sync.tombstones, part.sync.tombstones)) continue
    const oldRevision = old?.sync.revision ?? 0
    check(oldRevision < Number.MAX_SAFE_INTEGER, 'restore', 'counter_overflow')
    part.sync.revision = oldRevision + 1; part.sync.writeId = commitId; delete part.sync.remote
    partitions.push(await encodePartition(part))
  }
  let preparationPartition = null
  if (!preparation) {
    const old = state.domains.find(p => p.id === 'library-backup-preparations')
    const part = old ? jsonClone(old) : { id: 'library-backup-preparations', kind: 'library', ...scope,
      records: {}, sync: { revision: 0, writeId: null, edits: [], tombstones: [] } }
    part.extensions ??= {}; part.extensions[PREPARATIONS] ??= { version: 1, records: {} }
    part.extensions[PREPARATIONS].records[restoreKey] = { requestDigest, baseDigest }
    check(part.sync.revision < Number.MAX_SAFE_INTEGER, 'restore', 'counter_overflow')
    part.sync.revision++; part.sync.writeId = `restore-prepare-${restoreKey}`; delete part.sync.remote
    preparationPartition = await encodePartition(part)
    const overlaps = partitions.findIndex(p => p.id === part.id)
    if (overlaps >= 0) {
      const final = await decodePartition(partitions[overlaps])
      final.extensions ??= {}; final.extensions[PREPARATIONS] = unionBackupMetadata(final.extensions[PREPARATIONS], part.extensions[PREPARATIONS], PREPARATIONS)
      check(part.sync.revision < Number.MAX_SAFE_INTEGER, 'restore', 'counter_overflow')
      final.sync.revision = part.sync.revision + 1
      partitions[overlaps] = await encodePartition(final)
    }
  }
  return { restoreKey, requestDigest, commitId, expectedHead, conflicts, operations, partitions, preparationPartition }
}
