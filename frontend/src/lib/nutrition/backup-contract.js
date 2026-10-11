import { boundedJson, byteLength, canonicalJson, check, contentHash, exactKeys, HASH_PATTERN,
  jsonClone, readDocument, sealDocument, verifiedDocument, COLLECTIONS } from './persistence-contract.js'
import { createDatasetValidator } from '../../../../api/nutrition/core/persistence-commit.js'
import { decodePartition, estimateHydratedPartitionBytes } from './serialization.js'
import { validateConflictArchives } from './sync-contract.js'

export const BACKUP_FORMAT = 'opengym-backup'
export const BACKUP_MANIFEST = 'opengym-backup-manifest.json'
export const MAX_BACKUP_BYTES = 32 * 1024 * 1024
export const MAX_RESTORE_BYTES = 96 * 1024 * 1024
export const MAX_BACKUP_DOCUMENTS = 1900
export const BACKUP_SCOPE = Object.freeze({ namespace: Object.freeze({ serverOrigin: null, profileId: 'backup' }), generation: 'backup-v1' })
export const RECEIPTS = 'nutritionBackupRestores'
export const PREPARATIONS = 'nutritionBackupRestorePreparations'
export const keyOf = (collection, id) => canonicalJson([collection, id])

/** Resource and prototype gates run before recursive business validation or serialization.
 * Unknown user JSON is preserved; executable descriptors and prototype-control keys are refused. */
export function safeBackupValue(value, maxBytes = MAX_RESTORE_BYTES) {
  const stack = [{ value, depth: 0 }], seen = new Set()
  let nodes = 0
  while (stack.length) {
    const { value: v, depth } = stack.pop()
    check(++nodes <= 1500000 && depth <= 64, 'backup', 'backup_complexity_limit')
    if (!v || typeof v !== 'object') continue
    check(!seen.has(v), 'backup', 'backup_repeated_reference'); seen.add(v)
    check(Array.isArray(v) ? Object.getPrototypeOf(v) === Array.prototype :
      [null, Object.prototype].includes(Object.getPrototypeOf(v)), 'backup', 'backup_plain_object_required')
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(v))) {
      check(!['__proto__', 'prototype', 'constructor'].includes(key), 'backup', 'backup_unsafe_key')
      check(Object.hasOwn(descriptor, 'value'), 'backup', 'backup_data_property_required')
      if (Array.isArray(v) && key === 'length') continue
      stack.push({ value: descriptor.value, depth: depth + 1 })
    }
  }
  const text = canonicalJson(value)
  check(byteLength(text) <= maxBytes, 'backup', 'backup_too_large')
  return JSON.parse(text)
}

export function parseBackupJson(text, maxBytes = MAX_BACKUP_BYTES) {
  check(typeof text === 'string' && byteLength(text) <= maxBytes, 'backup', 'backup_too_large')
  // Bound nesting before JSON.parse/recursive validators, ignoring delimiters inside strings.
  let depth = 0, quoted = false, escaped = false
  for (const c of text) {
    if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false }
    else if (c === '"') quoted = true
    else if (c === '{' || c === '[') { check(++depth <= 64, 'backup', 'backup_complexity_limit') }
    else if (c === '}' || c === ']') depth--
  }
  let value
  try { value = JSON.parse(text) } catch { check(false, 'backup', 'invalid_json') }
  return safeBackupValue(value, maxBytes)
}

export function recordCounts(domains) {
  const counts = Object.fromEntries(COLLECTIONS.map(key => [key, 0]))
  for (const part of domains) for (const [key, rows] of Object.entries(part.records)) counts[key] += key === 'nutritionSettings' ? 1 : rows.length
  return counts
}

export async function validateBackupManifest(value) {
  value = safeBackupValue(value, 512 * 1024)
  const manifest = await verifiedDocument(value, BACKUP_FORMAT)
  exactKeys(manifest, ['format', 'storageVersion', 'domainVersion', 'schemaVersion', 'sections', 'documents', 'integrity'], 'backup')
  check(manifest.schemaVersion === 1 && manifest.domainVersion === 1, 'backup', 'unsupported_backup_version')
  exactKeys(manifest.sections, ['nutrition', 'workouts'], 'sections')
  check(manifest.sections.nutrition !== null || manifest.sections.workouts !== null, 'backup', 'empty_backup_request')
  const nutrition = manifest.sections.nutrition
  if (nutrition !== null) {
    exactKeys(nutrition, ['version', 'current', 'retained', 'counts'], 'nutrition')
    check(nutrition.version === 1, 'nutrition', 'unsupported_backup_version')
    for (const list of [nutrition.current, nutrition.retained]) check(Array.isArray(list) && list.every(d => typeof d === 'string' && HASH_PATTERN.test(d)) &&
      new Set(list).size === list.length, 'nutrition', 'invalid_backup_references')
    check(nutrition.current.every(d => !nutrition.retained.includes(d)), 'nutrition', 'duplicate_backup_reference')
    exactKeys(nutrition.counts, COLLECTIONS, 'counts')
    check(Object.values(nutrition.counts).every(n => Number.isSafeInteger(n) && n >= 0), 'counts', 'invalid_backup_count')
  }
  if (manifest.sections.workouts !== null) {
    exactKeys(manifest.sections.workouts, ['version', 'digest', 'mediaIncluded'], 'workouts')
    check(manifest.sections.workouts.version === 1 && typeof manifest.sections.workouts.digest === 'string' && HASH_PATTERN.test(manifest.sections.workouts.digest) && manifest.sections.workouts.mediaIncluded === false,
      'workouts', 'unsupported_backup_version')
  }
  check(Array.isArray(manifest.documents) && manifest.documents.length <= MAX_BACKUP_DOCUMENTS, 'documents', 'backup_document_limit')
  const wanted = new Set([...(nutrition?.current ?? []), ...(nutrition?.retained ?? []), ...(manifest.sections.workouts ? [manifest.sections.workouts.digest] : [])])
  const seen = new Set(); let bytes = 0
  for (const doc of manifest.documents) {
    exactKeys(doc, ['digest', 'bytes', 'kind'], 'documents')
    check(typeof doc.digest === 'string' && HASH_PATTERN.test(doc.digest) && wanted.has(doc.digest) && !seen.has(doc.digest), 'documents', 'invalid_backup_document')
    seen.add(doc.digest)
    check(Number.isSafeInteger(doc.bytes) && doc.bytes > 0 && doc.bytes <= (doc.kind === 'nutrition' ? 512 * 1024 : MAX_BACKUP_BYTES), 'documents', 'invalid_backup_size')
    check(['nutrition', 'workouts'].includes(doc.kind) && (doc.kind === 'workouts') === (doc.digest === manifest.sections.workouts?.digest), 'documents', 'invalid_backup_document')
    bytes += doc.bytes
  }
  check(seen.size === wanted.size, 'documents', 'missing_backup_document')
  check(bytes <= MAX_BACKUP_BYTES, 'documents', 'backup_too_large')
  return manifest
}

export const backupDocumentName = doc => `${doc.kind}/${doc.digest}.json`

/** Validate the entire graph, not just the archive envelope. Retained versions intentionally
 * overlap current entity ids, but each is a complete, validated historical partition. */
export async function validateBackupPartitions(manifest, load) {
  const current = [], retained = [], dataset = createDatasetValidator()
  let hydratedBytes = 0
  for (const doc of manifest.documents.filter(d => d.kind === 'nutrition')) {
    const text = await load(doc)
    check(byteLength(text) === doc.bytes, 'documents', 'backup_size_mismatch')
    const raw = readDocument(parseBackupJson(text, 512 * 1024))
    check(raw.storageVersion === 1 && raw.domainVersion === 1, 'documents', 'unsupported_backup_version')
    hydratedBytes += estimateHydratedPartitionBytes(raw)
    check(hydratedBytes <= MAX_RESTORE_BYTES, 'backup', 'backup_hydration_limit')
    const domain = await decodePartition(raw, { maxHydratedBytes: MAX_RESTORE_BYTES })
    check(raw.integrity.digest === doc.digest, 'documents', 'backup_digest_mismatch')
    check(canonicalJson(domain.namespace) === canonicalJson(BACKUP_SCOPE.namespace) && domain.generation === BACKUP_SCOPE.generation &&
      domain.sync.revision === 0 && domain.sync.writeId === null && !Object.hasOwn(domain.sync, 'remote') &&
      !Object.hasOwn(domain.extensions ?? {}, RECEIPTS) && !Object.hasOwn(domain.extensions ?? {}, PREPARATIONS), 'documents', 'backup_technical_state')
    await validateConflictArchives([domain])
    if (manifest.sections.nutrition.current.includes(doc.digest)) { dataset.add(domain); current.push(domain) }
    else retained.push(domain)
  }
  dataset.finish()
  check(new Set(current.map(p => p.id)).size === current.length, 'nutrition', 'duplicate_partition_id')
  if (manifest.sections.nutrition) check(canonicalJson(recordCounts(current)) === canonicalJson(manifest.sections.nutrition.counts), 'counts', 'backup_count_mismatch')
  return { current, retained }
}

export { boundedJson, contentHash, jsonClone, sealDocument }
