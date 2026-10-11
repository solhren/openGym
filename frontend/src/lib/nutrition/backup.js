import { zipStore, readZip, looksLikeZip } from '../zip.js'
import { referencedFiles } from '../media-refs.js'
import { encodePartition } from './serialization.js'
import { boundedJson, canonicalJson, check, byteLength, exactKeys, validateNamespace } from './persistence-contract.js'
import { BACKUP_FORMAT, BACKUP_MANIFEST, BACKUP_SCOPE, MAX_BACKUP_BYTES, MAX_BACKUP_DOCUMENTS,
  backupDocumentName, contentHash, jsonClone, parseBackupJson, recordCounts, RECEIPTS, PREPARATIONS, MAX_RESTORE_BYTES,
  safeBackupValue, sealDocument, validateBackupManifest, validateBackupPartitions } from './backup-contract.js'
import { prepareNutritionRestore, readRestoreReceipt, restoreBaselineDigest } from './backup-restore.js'

const blobOf = text => new Blob([text], { type: 'application/json' })
const guarded = async (promise, guard) => { try { return await promise } finally { guard() } }

/** A new versioned envelope in the existing uncompressed ZIP container. Legacy readers
 * deliberately reject it: importing only its workouts would falsely imply global success. */
export async function exportNutritionBackup({ store, getWorkouts, getWorkoutRevision, guard = () => {} }) {
  guard()
  const readWorkoutRevision = () => {
    check(typeof getWorkoutRevision === 'function', 'backup', 'workout_revision_reader_required')
    const version = safeBackupValue(getWorkoutRevision(), 1024)
    exactKeys(version, ['namespace', 'revision'], 'workouts.revision'); validateNamespace(version.namespace)
    check(typeof version.revision === 'string' && version.revision.length > 0 || Number.isSafeInteger(version.revision) && version.revision >= 0,
      'workouts', 'invalid_workout_revision')
    if (store) check(canonicalJson(version.namespace) === canonicalJson(store.scope.namespace), 'backup', 'workout_scope_mismatch')
    return canonicalJson(version)
  }
  const workoutRevision = getWorkouts ? readWorkoutRevision() : null
  const workoutSource = getWorkouts ? canonicalJson(safeBackupValue(getWorkouts())) : null
  if (getWorkouts) check(readWorkoutRevision() === workoutRevision, 'backup', 'workouts_changed_during_export')
  const workouts = workoutSource === null ? null : (await import('../backup-workouts.js')).portableWorkoutState(parseBackupJson(workoutSource))
  const entries = new Map(), documents = new Map(), current = new Set(), retained = new Set()
  const counts = recordCounts([])
  let total = 0
  const add = (digest, text, kind) => {
    parseBackupJson(text, kind === 'nutrition' ? 512 * 1024 : MAX_BACKUP_BYTES)
    if (documents.has(digest)) return
    total += byteLength(text); check(total <= MAX_BACKUP_BYTES, 'backup', 'backup_too_large')
    const doc = { digest, bytes: byteLength(text), kind }
    check(documents.size < MAX_BACKUP_DOCUMENTS, 'backup', 'backup_document_limit')
    documents.set(digest, doc); entries.set(backupDocumentName(doc), blobOf(text))
  }
  let nutrition = null
  if (store) {
    await store.exportPartitions({ maxBytes: MAX_BACKUP_BYTES, guard, visit: async (value, flags) => {
      const domain = { ...value, ...BACKUP_SCOPE, sync: { revision: 0, writeId: null, edits: value.sync.edits, tombstones: value.sync.tombstones } }
      if (domain.extensions && [RECEIPTS, PREPARATIONS].some(key => Object.hasOwn(domain.extensions, key))) {
        domain.extensions = { ...domain.extensions }; delete domain.extensions[RECEIPTS]; delete domain.extensions[PREPARATIONS]
        if (!Object.keys(domain.extensions).length) delete domain.extensions
      }
      if (['library-backup-restores', 'library-backup-preparations'].includes(domain.id) && !Object.keys(domain.records).length &&
        !domain.extensions && !domain.sync.edits.length && !domain.sync.tombstones.length) return
      const part = await encodePartition(domain), digest = part.integrity.digest
      add(digest, boundedJson(part), 'nutrition')
      ;(flags.current ? current : retained).add(digest)
      if (flags.current) for (const [collection, count] of Object.entries(recordCounts([domain]))) counts[collection] += count
    } })
    nutrition = { version: 1, current: [...current].sort(), retained: [...retained].filter(d => !current.has(d)).sort(), counts }
  }
  let workoutSection = null
  if (workouts) {
    const text = canonicalJson(workouts), digest = await contentHash(workouts)
    add(digest, text, 'workouts'); workoutSection = { version: 1, digest, mediaIncluded: false }
  }
  check(nutrition !== null || workoutSection !== null, 'backup', 'empty_backup_request')
  const manifest = await sealDocument({ format: BACKUP_FORMAT, storageVersion: 1, domainVersion: 1, schemaVersion: 1,
    sections: { nutrition, workouts: workoutSection }, documents: [...documents.values()].sort((a, b) => a.digest.localeCompare(b.digest)) })
  await validateBackupManifest(manifest)
  entries.set(BACKUP_MANIFEST, blobOf(boundedJson(manifest)))
  // A nonreused workout write token proves no ABA write during Nutrition capture. Thus there exists
  // a common logical snapshot, without pretending their independent stores share a tx.
  guard()
  if (getWorkouts) check(readWorkoutRevision() === workoutRevision && canonicalJson(safeBackupValue(getWorkouts())) === workoutSource,
    'backup', 'workouts_changed_during_export')
  const blob = await zipStore([...entries].sort(([a], [b]) => a.localeCompare(b)).map(([name, blob]) => ({ name, blob })),
    { now: new Date('2000-01-01T00:00:00') })
  guard()
  return { blob, manifest, digest: manifest.integrity.digest, bytes: blob.size,
    warnings: workouts && referencedFiles(workouts).length ? ['workout-media-not-included'] : [] }
}

/** Untrusted File/Blob inspection only. No writes, media import, auth or network calls. */
export async function readNutritionBackup(file, { guard = () => {} } = {}) {
  guard()
  check(file && Number.isSafeInteger(file.size) && file.size <= MAX_BACKUP_BYTES + 1024 * 1024, 'backup', 'backup_too_large')
  const zip = await looksLikeZip(file)
  if (!zip) {
    const state = parseBackupJson(await file.text())
    check(!Object.hasOwn(state ?? {}, 'format'), 'backup', 'unsupported_backup_format')
    const legacy = await (await import('../backup-media.js')).readBackupFile(blobOf(canonicalJson(state)))
    guard()
    return { legacy: true, digest: await contentHash(legacy.state), current: [], retained: [], workouts: legacy.state,
      files: [], warnings: ['legacy-workouts-only', 'workout-media-not-included'] }
  }
  const entries = await readZip(file), names = new Map()
  for (const entry of entries) {
    check(!names.has(entry.name), 'backup', 'duplicate_archive_entry'); names.set(entry.name, entry)
  }
  const entry = names.get(BACKUP_MANIFEST)
  if (!entry) {
    // Before the legacy reader, check its JSON's resource/prototype gates as well.
    const legacyJson = names.get('opengym-backup.json')
    check(legacyJson && legacyJson.size <= MAX_BACKUP_BYTES, 'backup', 'not-backup')
    parseBackupJson(await legacyJson.blob.text())
    const legacy = await (await import('../backup-media.js')).readBackupFile(file); guard()
    return { legacy: true, digest: await contentHash(legacy.state), current: [], retained: [], workouts: legacy.state,
      files: legacy.files, warnings: ['legacy-workouts-only'] }
  }
  check(entry.size <= 512 * 1024, 'backup', 'document_too_large')
  const manifestText = await entry.blob.text(), manifest = await validateBackupManifest(parseBackupJson(manifestText, 512 * 1024))
  check(manifestText === boundedJson(manifest), 'backup', 'noncanonical_backup_json')
  const expected = new Set([BACKUP_MANIFEST, ...manifest.documents.map(backupDocumentName)])
  check(expected.size === names.size && [...names.keys()].every(name => expected.has(name)), 'backup', 'unexpected_archive_entry')
  const load = async doc => {
    guard()
    const entry = names.get(backupDocumentName(doc))
    check(entry && entry.size === doc.bytes, 'documents', 'backup_size_mismatch')
    const text = await entry.blob.text(), parsed = parseBackupJson(text, doc.bytes)
    check(text === canonicalJson(parsed), 'documents', 'noncanonical_backup_json')
    guard(); return text
  }
  const { current, retained } = await validateBackupPartitions(manifest, load)
  let workouts = null
  if (manifest.sections.workouts) {
    const doc = manifest.documents.find(d => d.kind === 'workouts')
    workouts = (await import('../backup-workouts.js')).portableWorkoutState(parseBackupJson(await load(doc)), { strict: true })
    check(await contentHash(workouts) === doc.digest, 'workouts', 'checksum_mismatch')
  }
  guard()
  return { legacy: false, manifest, digest: manifest.integrity.digest, current, retained, workouts, files: [],
    warnings: workouts && referencedFiles(workouts).length ? ['workout-media-not-included'] : [] }
}

/** Account-bound service. The caller supplies its existing session epoch, including ABA
 * logout/login transitions. A preview is an opaque capability scoped to this service/session;
 * callers cannot mutate its private plan or manufacture an authorized replacement. */
export function createNutritionBackup({ store, getSession, sync = null, getWorkouts, getWorkoutRevision }) {
  check(store && typeof getSession === 'function', 'backup', 'session_binding_required')
  const plans = new WeakMap()
  const captureGuard = signal => {
    const captured = jsonClone(getSession()), scope = store.scope
    exactKeys(captured, ['userId', 'serverOrigin', 'epoch'], 'session')
    check(Number.isSafeInteger(captured.epoch) && captured.epoch >= 0 || typeof captured.epoch === 'string' && captured.epoch.length > 0,
      'session', 'session_epoch_required')
    const guard = () => {
      check(!signal?.aborted, 'backup', 'backup_cancelled')
      const current = getSession()
      check(canonicalJson(current) === canonicalJson(captured), 'backup', 'backup_session_changed')
      check(captured.userId === scope.namespace.profileId && captured.serverOrigin === scope.namespace.serverOrigin,
      'backup', 'backup_session_mismatch')
    }
    guard(); return guard
  }
  return {
    async export({ signal } = {}) { const guard = captureGuard(signal); return guarded(exportNutritionBackup({ store, getWorkouts, getWorkoutRevision, guard }), guard) },
    async preview(file, options = {}, { signal } = {}) {
      const guard = captureGuard(signal), request = safeBackupValue(options, 512 * 1024)
      exactKeys(request, ['mode', 'restoreId', 'choices', 'allowReplace', 'datasets'], 'restore', ['restoreId'])
      check(!Object.hasOwn(request, 'datasets') || ['nutrition', 'global'].includes(request.datasets), 'restore', 'invalid_restore_datasets')
      check(typeof request.restoreId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(request.restoreId), 'restore', 'invalid_restore_id')
      const archive = await guarded(readNutritionBackup(file, { guard }), guard)
      guard()
      if (!archive.manifest?.sections.nutrition) return { compatible: true, applicable: false, sections: { nutrition: false, workouts: true },
        counts: { workouts: archive.workouts.workouts.length, routines: archive.workouts.routines.length },
        warnings: archive.warnings, reason: 'workout-restoration-requires-existing-workout-flow', migrations: archive.legacy ? ['existing-workout-overlay'] : [] }
      const state = await guarded(store.readForRestore({ maxBytes: MAX_BACKUP_BYTES }), guard)
      check(byteLength(canonicalJson(state.domains)) <= MAX_RESTORE_BYTES, 'restore', 'backup_hydration_limit')
      const plan = await guarded(prepareNutritionRestore({ archive, state, scope: store.scope, deviceId: store.deviceId, ...request }), guard)
      const capacity = await guarded(store.storageStatus(), guard)
      const estimatedWriteBytes = (plan.partitions ?? []).concat(plan.preparationPartition ? [plan.preparationPartition] : []).reduce((n, p) => n + byteLength(boundedJson(p)), 0)
      const available = capacity.estimate && Number.isFinite(capacity.estimate.quota) && Number.isFinite(capacity.estimate.usage) ? capacity.estimate.quota - capacity.estimate.usage : null
      const global = !!archive.workouts && request.datasets !== 'nutrition'
      const preview = { compatible: true, applicable: plan.conflicts.length === 0 && !global,
        sections: { nutrition: true, workouts: !!archive.workouts }, mode: request.mode ?? 'merge', digest: archive.digest,
        workoutCounts: archive.workouts ? { workouts: archive.workouts.workouts.length, routines: archive.workouts.routines.length } : null,
        counts: archive.manifest.sections.nutrition.counts, retainedPartitions: archive.retained.length,
        conflicts: jsonClone(plan.conflicts), operations: jsonClone(plan.operations), repeated: plan.repeated ?? false, migrations: [],
        pendingOperations: state.pendingOperations.length,
        space: { estimatedWriteBytes, available, sufficient: available === null ? null : available >= estimatedWriteBytes * 2 + 1024 * 1024 },
        warnings: [...archive.warnings, ...(archive.workouts ? ['global-restore-requires-durable-workout-participant'] : []),
          ...(archive.retained.length ? ['retained-versions-imported-as-conflict-archives'] : []),
          ...(state.pendingOperations.length ? ['pending-operations-retained'] : []), 'server-only-data-will-be-preserved'] }
      if (preview.space.sufficient === false) preview.applicable = false
      plans.set(preview, { plan, guard, global, insufficientSpace: preview.space.sufficient === false })
      return preview
    },
    async restore(preview) {
      const prepared = plans.get(preview)
      check(!!prepared, 'restore', 'unknown_restore_preview')
      prepared.guard()
      check(!prepared.insufficientSpace, 'restore', 'backup_insufficient_space')
      check(!prepared.global, 'restore', 'global_restore_not_atomic')
      check(prepared.plan.conflicts.length === 0, 'restore', 'restore_conflicts_require_resolution')
      // Cancellation prevents this runner's late response from applying a stale pull. A POST
      // already sent may still finish: its frozen delivery is retained and replayed normally.
      sync?.cancel()
      const current = await guarded(store.readForRestore({ maxBytes: MAX_BACKUP_BYTES }), prepared.guard)
      const receipt = readRestoreReceipt(current.domains, prepared.plan.restoreKey)
      if (receipt) {
        check(receipt.requestDigest === prepared.plan.requestDigest, 'restore', 'reused_restore_id')
        return { status: 'restored', repeated: true, head: current.head }
      }
      check(canonicalJson(current.head) === canonicalJson(prepared.plan.expectedHead), 'restore', 'stale_restore_preview')
      let expectedHead = prepared.plan.expectedHead
      if (prepared.plan.preparationPartition) {
        const staged = await guarded(store.commit({ commitId: `restore-prepare-${prepared.plan.restoreKey}`, expectedHead,
          partitions: [prepared.plan.preparationPartition] }, { guard: prepared.guard, maxBytes: MAX_BACKUP_BYTES }), prepared.guard)
        expectedHead = staged.head
      }
      const result = await guarded(store.commit({ commitId: prepared.plan.commitId, expectedHead,
        partitions: prepared.plan.partitions }, { guard: prepared.guard, maxBytes: MAX_BACKUP_BYTES }), prepared.guard)
      prepared.guard(); store.invalidateCache()
      return { status: 'restored', repeated: !!result.repeated, head: result.head, pending: true }
    },
    async recoveryStatus() {
      const guard = captureGuard(), state = await guarded(store.readForRestore({ maxBytes: MAX_BACKUP_BYTES }), guard)
      const completed = new Map(state.domains.flatMap(p => Object.entries(p.extensions?.[RECEIPTS]?.records ?? {})))
      const prepared = new Map(state.domains.flatMap(p => Object.entries(p.extensions?.[PREPARATIONS]?.records ?? {})))
      const baseDigest = await guarded(restoreBaselineDigest(state.domains), guard)
      return { status: state.status, pendingOperations: state.pendingOperations.length,
        restores: [...prepared].map(([restoreKey, row]) => ({ restoreKey, requestDigest: row.requestDigest,
          status: completed.has(restoreKey) ? 'completed' : row.baseDigest === baseDigest ? 'prepared' : 'base-changed' })) }
    },
  }
}
