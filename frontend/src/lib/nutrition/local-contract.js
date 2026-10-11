import { DOMAIN_VERSION, HASH_PATTERN, check, exactKeys, isCounter, isText,
  jsonClone, readDocument, sealDocument, validateScope, verifiedDocument, NutritionPersistenceError } from './persistence-contract.js'
import { readHead } from './persistence-commit.js'
import { validateDelivery } from './sync-contract.js'

export const LOCAL_FORMAT = 'opengym-nutrition-local-root'
export const documentKey = (kind, digest) => `${kind}-${digest}`
export const isDocumentKey = key => typeof key === 'string' && /^[pm]-[a-f0-9]{64}$/.test(key)
export const MAX_READ_DOCUMENTS = 4

export function captureRead(input) {
  const value = jsonClone(input)
  exactKeys(value, ['expectedRoot', 'expectedPrevious', 'keys'], '$')
  for (const field of ['expectedRoot', 'expectedPrevious']) check(value[field] === null || typeof value[field] === 'string', field, 'text_required')
  check(Array.isArray(value.keys) && value.keys.length <= MAX_READ_DOCUMENTS &&
    value.keys.every(isDocumentKey) && new Set(value.keys).size === value.keys.length, 'keys', 'invalid_read_batch')
  return value
}
export function captureIndex(input) {
  const value = jsonClone(input)
  exactKeys(value, ['expectedRoot', 'expectedPrevious', 'index'], '$')
  captureRead({ expectedRoot: value.expectedRoot, expectedPrevious: value.expectedPrevious, keys: [] })
  check(typeof value.index === 'string', 'index', 'text_required')
  readDocument(value.index)
  return value
}

// Headers only use this to locate candidate manifests; the reader validates the complete
// root/head/manifest checksums and scopes before accepting any of these bytes.
export function manifestKey(text) {
  try {
    const digest = JSON.parse(text)?.head?.manifestDigest
    return typeof digest === 'string' && HASH_PATTERN.test(digest) ? documentKey('m', digest) : null
  } catch { return null }
}

// The local envelope is separate from the portable v1 head/manifest. The queue's payloads and
// references remain in that manifest; only delivery state and the durable local clock live here.
export async function readLocalRoot(value, scope) {
  const root = await verifiedDocument(value, LOCAL_FORMAT)
  exactKeys(root, ['format', 'storageVersion', 'domainVersion', 'namespace', 'generation', 'head',
    'counter', 'unsentId', 'inFlightId', 'requestDigest', 'integrity', 'delivery'], '$',
    ['format', 'storageVersion', 'domainVersion', 'namespace', 'generation', 'head', 'counter', 'unsentId', 'inFlightId', 'requestDigest', 'integrity'])
  validateScope(root)
  check(JSON.stringify(root.namespace) === JSON.stringify(jsonClone(scope.namespace)), 'namespace', 'namespace_mismatch')
  check(root.generation === scope.generation, 'generation', 'generation_mismatch')
  const head = await readHead(root.head)
  check(JSON.stringify(head.namespace) === JSON.stringify(root.namespace) && head.generation === root.generation,
    'head', 'scope_mismatch')
  check(isCounter(root.counter), 'counter', 'safe_integer_required')
  for (const key of ['unsentId', 'inFlightId']) check(root[key] === null || isText(root[key]), key, 'invalid_operation_id')
  check(root.unsentId === null || root.unsentId !== root.inFlightId, 'unsentId', 'duplicate_operation_id')
  check(typeof root.requestDigest === 'string' && HASH_PATTERN.test(root.requestDigest), 'requestDigest', 'invalid_digest')
  if (Object.hasOwn(root, 'delivery')) {
    await validateDelivery(root.delivery, scope)
    check(root.delivery.operationId === root.inFlightId, 'delivery', 'delivery_operation_mismatch')
  }
  return root
}

export async function makeLocalRoot(scope, head, counter, unsentId, inFlightId, requestDigest, delivery = null) {
  return sealDocument({ format: LOCAL_FORMAT, storageVersion: 1, domainVersion: DOMAIN_VERSION,
    namespace: scope.namespace, generation: scope.generation, head, counter, unsentId, inFlightId, requestDigest,
    ...(delivery ? { delivery } : {}) })
}

export function validateLocalQueue(root, manifest) {
  const ids = [root.unsentId, root.inFlightId].filter(id => id !== null)
  check(ids.length === manifest.pendingOperations.length &&
    ids.every(id => manifest.pendingOperations.some(op => op.id === id)), 'outbox', 'queue_state_mismatch')
  check(manifest.pendingOperations.every(op => op.stamp.counter <= root.counter), 'counter', 'queue_clock_mismatch')
  if (root.unsentId !== null) {
    const op = manifest.pendingOperations.find(op => op.id === root.unsentId)
    check(op.partitions.every(ref => manifest.partitions.some(current =>
      JSON.stringify(current) === JSON.stringify(ref))), 'outbox', 'unsent_not_current')
    check(op.removedPartitionIds.every(id => !manifest.partitions.some(ref => ref.id === id)), 'outbox', 'removed_partition_live')
  }
}

export function storageError(error) {
  if (error instanceof NutritionPersistenceError) return error
  const code = error?.code === 'STALE_ROOT' ? 'stale_root' :
    error?.name === 'QuotaExceededError' || error?.code === 'ENOSPC' || error?.code === 'QUOTA' ? 'quota_exceeded' :
    error?.code === 'INTEGRITY_CONFLICT' ? 'immutable_object_conflict' :
    error?.code === 'UNSUPPORTED_DURABILITY' ? 'unsupported_durability' : 'storage_io_failed'
  const result = new NutritionPersistenceError([{ path: 'storage', code }])
  result.cause = error
  return result
}

export function capturePublication(input) {
  const value = jsonClone(input)
  exactKeys(value, ['expectedRoot', 'root', 'writes'], '$')
  check(value.expectedRoot === null || typeof value.expectedRoot === 'string', 'expectedRoot', 'text_required')
  check(typeof value.root === 'string', 'root', 'text_required')
  check(Array.isArray(value.writes), 'writes', 'array_required')
  for (const row of value.writes) exactKeys(row, ['key', 'text'], 'writes')
  // Physical bounds apply to UTF-8 bytes, including envelopes, on both backends.
  for (const text of [value.root, ...value.writes.map(row => row.text)]) {
    check(typeof text === 'string', '$', 'text_required')
    readDocument(text)
  }
  const keys = new Set()
  value.writes.forEach(row => {
    exactKeys(row, ['key', 'text'], 'writes')
    check(isDocumentKey(row.key) && !keys.has(row.key), 'writes.key', 'invalid_document_key')
    keys.add(row.key)
  })
  return value
}
