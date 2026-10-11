import { NutritionValidationError } from './contracts.js'
import { DOMAIN_VERSION, HASH_PATTERN, boundedJson, check, contentHash, exactKeys, isText,
  jsonClone, readDocument, validateScope } from './persistence-contract.js'
import { assertPublishable, prepareCommit, readManifest, recoverCommit } from './persistence-commit.js'
import { documentKey, isDocumentKey, makeLocalRoot, readLocalRoot, validateLocalQueue } from './local-contract.js'
import { nutritionIdbBackend } from './local-store-idb.js'
import { nutritionFsBackend } from './local-store-fs.js'
import { nutritionLocalReader, makeDateIndex } from './local-reader.js'
import { isNutritionDate } from './validate.js'
import { preserveHistory } from '../../../../api/nutrition/core/history.js'

const refOf = part => ({ id: part.id, digest: part.integrity.digest, revision: part.sync.revision, writeId: part.sync.writeId })
const unsupported = error => error?.issues?.some(issue => ['unsupported_storage_version', 'unsupported_domain_version',
  'unsupported_version', 'committed_migration_required'].includes(issue.code))

async function resolveRoot(text, scope, objects) {
  const root = await readLocalRoot(text, scope)
  const manifestText = objects.get(documentKey('m', root.head.manifestDigest))
  check(manifestText !== undefined, 'manifest', 'missing_manifest')
  const manifest = await readManifest(manifestText)
  const refs = [...manifest.partitions, ...manifest.pendingOperations.flatMap(op => op.partitions)]
  const parts = new Map()
  for (const ref of refs) {
    const key = documentKey('p', ref.digest)
    if (parts.has(key)) continue
    const value = objects.get(key)
    check(value !== undefined, `partitions.${ref.id}`, 'missing_partition')
    // recoverCommit validates/hydrates every referenced document. Parse only here so we do
    // not validate a 10-year history a third time before invoking the shared protocol.
    parts.set(key, readDocument(value))
  }
  const recovery = await recoverCommit({ namespace: scope.namespace, generation: scope.generation,
    heads: [root.head], manifests: [manifest], partitions: [...parts.values()] })
  validateLocalQueue(root, recovery.manifest)
  return { ...recovery, root, text }
}

async function readSnapshot(snapshot, scope) {
  exactKeys(snapshot, ['root', 'previous', 'objects'], 'storage')
  check(Array.isArray(snapshot.objects), 'storage.objects', 'array_required')
  const objects = new Map()
  for (const row of snapshot.objects) {
    exactKeys(row, ['key', 'text'], 'storage.objects')
    check(isDocumentKey(row.key) && typeof row.text === 'string' && !objects.has(row.key), 'storage.objects', 'invalid_document_key')
    objects.set(row.key, row.text)
  }
  if (snapshot.root === null && snapshot.previous === null) return { empty: true, snapshot, objects,
    degraded: objects.size > 0, issues: objects.size > 0 ? [{ path: 'storage', code: 'unpublished_documents' }] : [] }
  const issues = []
  for (const text of [snapshot.root, snapshot.previous]) {
    if (text === null) continue
    try {
      const state = await resolveRoot(text, scope, objects)
      return { ...state, empty: false, degraded: text !== snapshot.root || issues.length > 0, issues, snapshot, objects }
    } catch (error) {
      if (!(error instanceof NutritionValidationError) || unsupported(error)) throw error
      issues.push(...error.issues)
    }
  }
  check(false, 'storage', 'no_complete_commit')
}

// Full partition checkpoints can replace NEVER handed-out operations. Their records/snapshots
// and tombstones are the authoritative state, not a list of UI actions. A handed-out bundle is
// immutable, pinned and re-delivered indefinitely until an exact durable receipt is supplied.
function compactUnsent(previous, writes, removed) {
  const refs = new Map((previous?.partitions ?? []).map(ref => [ref.id, ref]))
  const deleted = new Set(previous?.removedPartitionIds ?? [])
  for (const part of writes) { refs.set(part.id, refOf(part)); deleted.delete(part.id) }
  for (const id of removed) { refs.delete(id); deleted.add(id) }
  return { partitions: [...refs.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0), removedPartitionIds: [...deleted].sort() }
}

function nextCounter(state, writes) {
  let highest = state.root?.counter ?? 0
  for (const operation of state.manifest?.pendingOperations ?? []) highest = Math.max(highest, operation.stamp.counter)
  for (const partition of [...(state.partitions ?? []), ...writes]) {
    for (const marker of [...partition.sync.edits, ...partition.sync.tombstones]) {
      highest = Math.max(highest, marker.stamp.counter)
      for (const stamp of Object.values(marker.fields ?? {})) highest = Math.max(highest, stamp.counter)
    }
  }
  check(highest < Number.MAX_SAFE_INTEGER, 'counter', 'counter_overflow')
  return highest + 1
}

/** Explicitly scoped, standalone storage; nothing is added to the gym_state_v1 sync/UI.
 * commit accepts the existing encoded partition contract. Callers rebase on stale_root;
 * storage never guesses how to merge edits to records. All hashing happens before I/O CAS. */
export async function createNutritionLocalStore(options) {
  const scope = jsonClone({ namespace: options.namespace, generation: options.generation })
  validateScope({ ...scope, domainVersion: DOMAIN_VERSION })
  check(isText(options.deviceId), 'deviceId', 'text_required')
  const deviceId = options.deviceId
  const native = options.backend ? false : options.native ?? (await import('@capacitor/core')).Capacitor.isNativePlatform()
  const backend = options.backend ?? (native ? nutritionFsBackend(options.fs) : nutritionIdbBackend(options.idb))
  const scopeId = await contentHash(scope)
  let closed = false
  const assertOpen = () => check(!closed, 'storage', 'storage_closed')
  const reader = nutritionLocalReader({ backend, scope, assertOpen, cache: options.cache })
  await backend.open(scopeId)
  const load = async () => {
    assertOpen()
    const snapshot = await backend.snapshot()
    assertOpen()
    const state = await readSnapshot(snapshot, scope)
    assertOpen()
    return state
  }
  const writable = state => check(!state.degraded, 'storage', 'recovery_required')
  const publish = async (state, plan, root) => {
    const available = [...(state.partitions ?? []), ...(state.pendingPartitions ?? []), ...plan.writes]
    const checked = await assertPublishable(plan, { currentHead: state.empty ? null : state.head, partitions: available })
    preserveHistory(state.domains ?? [], checked.domains)
    validateLocalQueue(root, checked.manifest)
    const writes = plan.writes.map(part => ({ key: documentKey('p', part.integrity.digest), text: boundedJson(part) }))
    writes.push({ key: documentKey('m', plan.manifest.integrity.digest), text: boundedJson(plan.manifest) })
    if (state.empty && state.objects.size > 0) {
      // Missing roots might be an interrupted FIRST write, or lost publication evidence.
      // Only replay a plan retaining EVERY existing byte document verbatim. Never initialize
      // over an unrelated orphan set and later garbage-collect possibly published history.
      const replay = new Map(writes.map(row => [row.key, row.text]))
      check([...state.objects].every(([key, text]) => replay.get(key) === text), 'storage', 'recovery_required')
    }
    assertOpen()
    reader.changed()
    await backend.publish({ expectedRoot: state.snapshot.root, root: boundedJson(root), writes })
    // A derived index is dispensable. Its separate CAS cannot alter publication/outbox state.
    // If an interrupted write leaves an older index, its manifest digest makes it unusable.
    let indexIssue = null
    try {
      const index = await makeDateIndex(scope, checked.manifest, checked.domains)
      assertOpen()
      await backend.saveIndex({ expectedRoot: boundedJson(root), expectedPrevious: state.snapshot.root,
        index: boundedJson(index) })
      reader.acceptIndex()
    } catch (error) { indexIssue = error.issues ?? [{ path: 'index', code: 'index_unavailable' }] }
    return { head: plan.head, manifest: plan.manifest, ...(indexIssue ? { indexIssue } : {}) }
  }
  const queuePlan = async (state, pendingOperations, requestDigest, unsentId, inFlightId) => {
    const commitId = `local-${requestDigest}-${state.root.counter + 1}`
    const plan = await prepareCommit({ ...scope, commitId, baseManifest: state.manifest, partitions: [], pendingOperations })
    check(state.root.counter < Number.MAX_SAFE_INTEGER, 'counter', 'counter_overflow')
    const root = await makeLocalRoot(scope, plan.head, state.root.counter + 1, unsentId, inFlightId, requestDigest)
    await publish(state, plan, root)
    return plan
  }
  // Opening validates headers only; it never labels unvisited partitions as verified.
  // A fallback must still be a fully checked older publication before exposing it on open.
  try { const meta = await reader.metadata(); if (!meta.empty && meta.degraded) await load() }
  catch (error) { backend.close(); throw error }
  return {
    name: backend.name,
    scopeId,
    inspect() { return reader.inspect() },
    async readDay(date) { assertOpen(); return reader.period({ start: date, end: date }) },
    async readMonth(month) {
      assertOpen()
      check(typeof month === 'string' && /^\d{4}-\d{2}$/.test(month) && isNutritionDate(`${month}-01`), 'month', 'invalid_month')
      const start = `${month}-01`
      // UTC month length; avoid Date.UTC's special handling of years 0..99.
      const date = new Date(`${start}T00:00:00Z`); date.setUTCMonth(date.getUTCMonth() + 1); date.setUTCDate(0)
      return reader.period({ start, end: date.toISOString().slice(0, 10) })
    },
    async readPeriod(period) { assertOpen(); return reader.period(period) },
    verify() { return reader.verify() },
    invalidateCache() { assertOpen(); reader.invalidate() },
    cacheStatus() { assertOpen(); return reader.cacheStatus() },
    async read() {
      const state = await load()
      return state.empty ? { status: state.degraded ? 'recovery-required' : 'empty', head: null, manifest: null,
        domains: [], pendingOperations: [], issues: state.issues } :
        { status: state.degraded ? 'recovery-required' : 'current', head: state.head,
          manifest: state.manifest, domains: state.domains, pendingOperations: state.manifest.pendingOperations,
          inFlightId: state.root.inFlightId, unsentId: state.root.unsentId, counter: state.root.counter, issues: state.issues }
    },
    async commit(input) {
      assertOpen()
      const request = jsonClone(input)
      exactKeys(request, ['commitId', 'partitions', 'removePartitionIds'], '$', ['commitId', 'partitions'])
      check(isText(request.commitId), 'commitId', 'text_required')
      check(Array.isArray(request.partitions), 'partitions', 'array_required')
      const removed = Object.hasOwn(request, 'removePartitionIds') ? request.removePartitionIds : []
      check(Array.isArray(removed), 'removePartitionIds', 'array_required')
      const requestDigest = await contentHash({ type: 'commit', request })
      const state = await load()
      if (!state.empty) writable(state) // first-write replay is checked against every staged byte
      if (!state.empty && state.head.commitId === request.commitId) {
        check(state.root.requestDigest === requestDigest, 'commitId', 'reused_commit_id')
        return { head: state.head, manifest: state.manifest, repeated: true }
      }
      // Validation of writes occurs in prepareCommit BEFORE inspecting their descriptors.
      const preliminary = await prepareCommit({ ...scope, ...request, baseManifest: state.manifest ?? null })
      const counter = nextCounter(state, preliminary.writes)
      const previous = state.manifest?.pendingOperations.find(op => op.id === state.root.unsentId)
      const checkpoint = compactUnsent(previous, preliminary.writes, removed)
      const id = `checkpoint-${requestDigest}`
      const pending = (state.manifest?.pendingOperations ?? []).filter(op => op.id === state.root.inFlightId)
      pending.push({ id, stamp: { deviceId, counter }, ...checkpoint })
      const plan = await prepareCommit({ ...scope, ...request, baseManifest: state.manifest ?? null, pendingOperations: pending })
      const root = await makeLocalRoot(scope, plan.head, counter, id, state.root?.inFlightId ?? null, requestDigest)
      return publish(state, plan, root)
    },
    async beginPending() {
      const state = await load(); writable(state)
      if (state.empty) return null
      let id = state.root.inFlightId
      if (id === null && state.root.unsentId !== null) {
        id = state.root.unsentId
        const requestDigest = await contentHash({ type: 'begin', id })
        await queuePlan(state, state.manifest.pendingOperations, requestDigest, null, id)
      }
      if (id === null) return null
      const operation = state.manifest.pendingOperations.find(op => op.id === id)
      const refs = new Set(operation.partitions.map(ref => ref.digest))
      return { operation, operationDigest: await contentHash(operation),
        partitions: state.pendingPartitions.filter(part => refs.has(part.integrity.digest)) }
    },
    async acknowledge(input) {
      assertOpen()
      const receipt = jsonClone(input)
      exactKeys(receipt, ['operationId', 'operationDigest'], 'receipt')
      check(isText(receipt.operationId) && typeof receipt.operationDigest === 'string' && HASH_PATTERN.test(receipt.operationDigest),
        'receipt', 'invalid_receipt')
      const requestDigest = await contentHash({ type: 'ack', receipt })
      const state = await load(); writable(state)
      if (!state.empty && state.root.requestDigest === requestDigest) {
        return { head: state.head, manifest: state.manifest, repeated: true }
      }
      check(!state.empty && state.root.inFlightId === receipt.operationId, 'receipt', 'not_in_flight')
      const operation = state.manifest.pendingOperations.find(op => op.id === receipt.operationId)
      check(await contentHash(operation) === receipt.operationDigest, 'receipt', 'receipt_mismatch')
      return queuePlan(state, state.manifest.pendingOperations.filter(op => op.id !== receipt.operationId),
        requestDigest, state.root.unsentId, null)
    },
    async collect() {
      const state = await load(); writable(state)
      if (state.empty) return { deleted: 0 }
      const roots = [state]
      if (state.snapshot.previous !== null) {
        // A damaged fallback is evidence to preserve, not permission to prune.
        roots.push(await resolveRoot(state.snapshot.previous, scope, state.objects))
      }
      const pinned = new Set()
      for (const root of roots) {
        pinned.add(documentKey('m', root.manifest.integrity.digest))
        for (const ref of [...root.manifest.partitions, ...root.manifest.pendingOperations.flatMap(op => op.partitions)]) {
          pinned.add(documentKey('p', ref.digest))
        }
      }
      const keys = [...state.objects.keys()].filter(key => !pinned.has(key))
      // Both root comparisons and all deletes share the backend's transaction/OS lock.
      // Readers get their complete byte snapshot under that same isolation boundary.
      assertOpen()
      reader.changed()
      return backend.collect({ expectedRoot: state.snapshot.root, expectedPrevious: state.snapshot.previous, keys })
    },
    async storageStatus({ storage = globalThis.navigator?.storage, requestPersistence = false } = {}) {
      assertOpen()
      // WebView origin quotas do not measure the private native files directory.
      if (backend.name === 'private-json') return { backend: backend.name, persistent: true, estimate: null }
      let estimate = null, persistent = null
      if (storage?.estimate) estimate = await storage.estimate()
      if (requestPersistence && storage?.persist) persistent = await storage.persist()
      else if (storage?.persisted) persistent = await storage.persisted()
      return { backend: backend.name, persistent, estimate }
    },
    close() { if (!closed) { closed = true; reader.invalidate(); backend.close() } },
  }
}
