import { NutritionValidationError, NUTRITION_SCHEMA_VERSION } from './contracts.js'
import { validateJsonValue, isNutritionDate } from './validate.js'
import { sha256Hex } from '../sha256.js'

export const STORAGE_VERSION = 1
export const DOMAIN_VERSION = NUTRITION_SCHEMA_VERSION
export const MAX_DOCUMENT_BYTES = 512 * 1024
export const COLLECTIONS = Object.freeze(['foodEntries', 'customFoods', 'savedFoods', 'recipes', 'mealTemplates', 'nutritionGoals', 'nutritionSettings'])
export const HASH_PATTERN = /^[a-f0-9]{64}$/

/** @typedef {{serverOrigin: string|null, profileId: string}} NutritionNamespace */
/** @typedef {{counter: number, deviceId: string}} NutritionEditStamp */
/** @typedef {{collection: string, id: string, stamp: NutritionEditStamp,
 * fields?: Object<string, NutritionEditStamp>}} NutritionEditMarker */
/** @typedef {{revision: number, writeId: string|null, edits: NutritionEditMarker[],
 * tombstones: NutritionEditMarker[], remote?: {revision: number, writeId: string|null}}} NutritionSyncMetadata */
/** @typedef {{id: string, kind: 'journal'|'library', namespace: NutritionNamespace,
 * generation: string, records: Object, sync: NutritionSyncMetadata, extensions?: Object}} NutritionDomainPartition */

export class NutritionPersistenceError extends NutritionValidationError {
  constructor(issues) { super(issues); this.name = 'NutritionPersistenceError' }
}

export function fail(path, code) { throw new NutritionPersistenceError([{ path, code }]) }
export function check(condition, path, code) { if (!condition) fail(path, code) }
export const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
export const isText = value => typeof value === 'string' && value.trim().length > 0
export const isCounter = value => Number.isSafeInteger(value) && value >= 0

// Descriptor-based validation precedes every read. Neither getters nor toJSON run.
export function canonicalJson(value) {
  const issues = validateJsonValue(value)
  if (issues.length) throw new NutritionPersistenceError(issues)
  const encode = (v, path) => {
    if (typeof v === 'number') check(!Object.is(v, -0), path, 'json_negative_zero')
    if (v === null || typeof v !== 'object') return JSON.stringify(v)
    const descriptors = Object.getOwnPropertyDescriptors(v)
    if (Array.isArray(v)) {
      return `[${Array.from({ length: descriptors.length.value }, (_, i) => encode(descriptors[i].value, `${path}[${i}]`)).join(',')}]`
    }
    return `{${Object.keys(descriptors).sort().map(key => `${JSON.stringify(key)}:${encode(descriptors[key].value, `${path}.${key}`)}`).join(',')}}`
  }
  try { return encode(value, '$') } catch (error) {
    if (error instanceof NutritionPersistenceError) throw error
    fail('$', 'json_encoding_failed')
  }
}

export function jsonClone(value) {
  const encoded = canonicalJson(value)
  try { return JSON.parse(encoded) } catch { fail('$', 'json_encoding_failed') }
}
export const byteLength = text => new TextEncoder().encode(text).byteLength
export function boundedJson(value) {
  const text = canonicalJson(value)
  check(byteLength(text) <= MAX_DOCUMENT_BYTES, '$', 'document_too_large')
  return text
}
export function readDocument(value) {
  if (typeof value !== 'string') return JSON.parse(boundedJson(value))
  check(byteLength(value) <= MAX_DOCUMENT_BYTES, '$', 'document_too_large')
  let parsed
  try { parsed = JSON.parse(value) } catch { fail('$', 'invalid_json') }
  return jsonClone(parsed)
}

export async function contentHash(value) {
  // Capture an immutable representation before the first asynchronous boundary.
  const bytes = new TextEncoder().encode(canonicalJson(value))
  let digest
  // Reuse openGym's identical SHA-256 implementation for HTTP LAN/guest contexts as well.
  try { digest = await sha256Hex(bytes) } catch { fail('$', 'sha256_failed') }
  check(typeof digest === 'string' && HASH_PATTERN.test(digest), '$', 'sha256_failed')
  return digest
}
export async function sealDocument(value) {
  const captured = jsonClone(value)
  check(isObject(captured), '$', 'object_required')
  check(!Object.hasOwn(captured, 'integrity'), 'integrity', 'unexpected_field')
  const sealed = { ...captured, integrity: { algorithm: 'sha256', digest: await contentHash(captured) } }
  boundedJson(sealed)
  return sealed
}
export async function verifiedDocument(value, format, versions = [STORAGE_VERSION]) {
  const doc = readDocument(value)
  check(isObject(doc), '$', 'object_required')
  check(doc.format === format, 'format', 'unexpected_format')
  check(versions.includes(doc.storageVersion), 'storageVersion', 'unsupported_storage_version')
  exactKeys(doc.integrity, ['algorithm', 'digest'], 'integrity')
  check(doc.integrity.algorithm === 'sha256' && typeof doc.integrity.digest === 'string' && HASH_PATTERN.test(doc.integrity.digest), 'integrity', 'invalid_integrity')
  const { integrity, ...payload } = doc
  check(await contentHash(payload) === integrity.digest, 'integrity.digest', 'checksum_mismatch')
  return doc
}
export function exactKeys(value, allowed, path, required = allowed) {
  check(isObject(value), path, 'object_required')
  for (const key of Object.keys(value)) check(allowed.includes(key), `${path}.${key}`, 'unexpected_field')
  for (const key of required) check(Object.hasOwn(value, key), `${path}.${key}`, 'required_field')
}
export function validateNamespace(value, path = 'namespace') {
  exactKeys(value, ['serverOrigin', 'profileId'], path)
  check(isText(value.profileId), `${path}.profileId`, 'text_required')
  if (value.serverOrigin !== null) {
    let origin
    try { const url = new URL(value.serverOrigin); if (['http:', 'https:'].includes(url.protocol)) origin = url.origin } catch { /* checked below */ }
    check(typeof value.serverOrigin === 'string' && origin === value.serverOrigin, `${path}.serverOrigin`, 'canonical_origin_required')
  }
}
export const sameNamespace = (a, b) => a.serverOrigin === b.serverOrigin && a.profileId === b.profileId
export function validateScope(value) {
  validateNamespace(value.namespace)
  check(isText(value.generation), 'generation', 'text_required')
  check(value.domainVersion === DOMAIN_VERSION, 'domainVersion', 'unsupported_domain_version')
}

const shardPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
export function journalPartitionId(month, shard) {
  check(typeof month === 'string' && /^\d{4}-\d{2}$/.test(month) && isNutritionDate(`${month}-01`), 'month', 'invalid_month')
  check(typeof shard === 'string' && shardPattern.test(shard), 'shard', 'invalid_shard')
  return `journal-${month}-${shard}`
}
export function libraryPartitionId(shard) {
  check(typeof shard === 'string' && shardPattern.test(shard), 'shard', 'invalid_shard')
  return `library-${shard}`
}
export function partitionKind(id) {
  check(typeof id === 'string', 'id', 'invalid_partition_id')
  if (id.startsWith('library-') && shardPattern.test(id.slice(8))) return 'library'
  const match = /^journal-(\d{4}-\d{2})-(.+)$/.exec(id)
  if (match && isNutritionDate(`${match[1]}-01`) && shardPattern.test(match[2])) return 'journal'
  fail('id', 'invalid_partition_id')
}

export function validateStamp(value, path) {
  exactKeys(value, ['counter', 'deviceId'], path)
  check(isCounter(value.counter) && value.counter > 0, `${path}.counter`, 'positive_safe_integer_required')
  check(isText(value.deviceId), `${path}.deviceId`, 'text_required')
}
export function validateRevision(value, path) {
  check(isCounter(value.revision), `${path}.revision`, 'safe_integer_required')
  check(value.revision === 0 ? value.writeId === null : isText(value.writeId), `${path}.writeId`, 'invalid_write_id')
}
export function validateSync(sync, records, kind) {
  exactKeys(sync, ['revision', 'writeId', 'edits', 'tombstones', 'remote'], 'sync', ['revision', 'writeId', 'edits', 'tombstones'])
  validateRevision(sync, 'sync')
  if (Object.hasOwn(sync, 'remote')) {
    exactKeys(sync.remote, ['revision', 'writeId'], 'sync.remote')
    validateRevision(sync.remote, 'sync.remote')
  }
  const live = new Set(), markers = new Set(), rowsByKey = new Map()
  for (const [collection, rows] of Object.entries(records)) {
    if (collection === 'nutritionSettings') {
      const key = JSON.stringify([collection, '$'])
      live.add(key); rowsByKey.set(key, rows); continue
    }
    check(Array.isArray(rows), `records.${collection}`, 'array_required')
    for (const row of rows) {
      check(isObject(row) && isText(row.id), `records.${collection}`, 'record_id_required')
      const key = JSON.stringify([collection, row.id])
      check(!live.has(key), `records.${collection}`, 'duplicate_id')
      live.add(key)
      rowsByKey.set(key, row)
    }
  }
  for (const list of ['edits', 'tombstones']) {
    check(Array.isArray(sync[list]), `sync.${list}`, 'array_required')
    sync[list].forEach((marker, i) => {
      const path = `sync.${list}[${i}]`
      exactKeys(marker, ['collection', 'id', 'stamp', 'fields'], path, ['collection', 'id', 'stamp'])
      check(COLLECTIONS.includes(marker.collection) && (kind === 'journal') === (marker.collection === 'foodEntries'), `${path}.collection`, 'invalid_collection')
      check(isText(marker.id) && (marker.collection !== 'nutritionSettings' || marker.id === '$'), `${path}.id`, 'invalid_record_id')
      validateStamp(marker.stamp, `${path}.stamp`)
      const key = JSON.stringify([marker.collection, marker.id])
      check(!markers.has(key), path, 'duplicate_sync_marker')
      markers.add(key)
      check(list === 'edits' ? live.has(key) : !live.has(key), path, list === 'edits' ? 'edit_without_record' : 'live_tombstone_conflict')
      if (Object.hasOwn(marker, 'fields')) {
        check(list === 'edits' && isObject(marker.fields), `${path}.fields`, 'invalid_field_stamps')
        for (const [field, stamp] of Object.entries(marker.fields)) {
          // Direct fields only. Snapshot and quantity are each one atomic merge value.
          check(isText(field) && Object.hasOwn(rowsByKey.get(key), field), `${path}.fields.${field}`, 'unknown_record_field')
          check(!['id', 'schemaVersion'].includes(field), `${path}.fields.${field}`, 'immutable_record_field')
          validateStamp(stamp, `${path}.fields.${field}`)
        }
      }
    })
  }
}
