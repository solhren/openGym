import { NutritionValidationError } from './contracts.js'
import { isNutritionDate } from './validate.js'
import { DOMAIN_VERSION, boundedJson, check, contentHash, exactKeys, jsonClone, readDocument, sealDocument,
  validateScope, verifiedDocument } from './persistence-contract.js'
import { readManifest, createDatasetValidator } from './persistence-commit.js'
import { decodePartition, estimateHydratedPartitionBytes } from './serialization.js'
import { documentKey, isDocumentKey, MAX_READ_DOCUMENTS, readLocalRoot, validateLocalQueue } from './local-contract.js'
import { publicationRequest, validateConflictArchives } from './sync-contract.js'

const INDEX_FORMAT = 'opengym-nutrition-local-date-index'
const unsupported = error => error?.issues?.some(issue => ['unsupported_storage_version', 'unsupported_domain_version',
  'unsupported_version', 'committed_migration_required'].includes(issue.code))
const sameScope = (value, scope) => {
  check(value.namespace.serverOrigin === scope.namespace.serverOrigin && value.namespace.profileId === scope.namespace.profileId,
    'namespace', 'namespace_mismatch')
  check(value.generation === scope.generation, 'generation', 'generation_mismatch')
}
const journalRefs = manifest => manifest.partitions.filter(ref => ref.id.startsWith('journal-'))

function coverage(domain, ref) {
  let start = null, end = null
  for (const row of domain.records.foodEntries ?? []) {
    if (start === null || row.d < start) start = row.d
    if (end === null || row.d > end) end = row.d
  }
  return { ...ref, start, end }
}

export async function makeDateIndex(scope, manifest, domains) {
  const byId = new Map(domains.map(domain => [domain.id, domain]))
  return sealDocument({ format: INDEX_FORMAT, storageVersion: 1, domainVersion: DOMAIN_VERSION,
    ...scope, manifestDigest: manifest.integrity.digest,
    coverage: journalRefs(manifest).map(ref => coverage(byId.get(ref.id), ref)) })
}

async function dateIndex(text, meta) {
  const index = await verifiedDocument(text, INDEX_FORMAT)
  exactKeys(index, ['format', 'storageVersion', 'domainVersion', 'namespace', 'generation', 'manifestDigest', 'coverage', 'integrity'], '$')
  validateScope(index); sameScope(index, meta.root)
  check(index.manifestDigest === meta.manifest.integrity.digest, 'index', 'stale_date_index')
  const refs = journalRefs(meta.manifest)
  check(Array.isArray(index.coverage) && index.coverage.length === refs.length, 'index', 'invalid_date_index')
  index.coverage.forEach((row, i) => {
    exactKeys(row, ['id', 'digest', 'revision', 'writeId', 'start', 'end'], 'index.coverage')
    check(['id', 'digest', 'revision', 'writeId'].every(key => row[key] === refs[i][key]), 'index', 'invalid_date_index')
    check(row.start === null ? row.end === null : isNutritionDate(row.start) && isNutritionDate(row.end) && row.start <= row.end,
      'index', 'invalid_date_index')
  })
  return index
}

/** Local hints/cache never authorize mutation or GC. Every returned partition is decoded by
 * the shared v1 validator; full verification ignores the cache and scans the outbox too. */
export function nutritionLocalReader({ backend, scope, assertOpen, cache = {} }) {
  const limits = jsonClone(cache)
  exactKeys(limits, ['maxBytes', 'maxEntries'], 'cache', [])
  const maxBytes = limits.maxBytes ?? 8 * 1024 * 1024, maxEntries = limits.maxEntries ?? 8
  for (const value of [maxBytes, maxEntries]) check(Number.isSafeInteger(value) && value >= 0, 'cache', 'invalid_cache_limit')
  const cached = new Map()
  let bytes = 0, epoch = 0, roots = null, ignoreIndex = false
  const invalidate = (restored = false) => { epoch++; cached.clear(); bytes = 0; roots = null; ignoreIndex ||= restored }
  const alive = token => { assertOpen(); check(token === epoch, 'read', 'read_invalidated') }
  const guard = meta => ({ expectedRoot: meta.snapshot.root, expectedPrevious: meta.snapshot.previous })
  const objectsOf = rows => {
    check(Array.isArray(rows), 'storage.objects', 'array_required')
    const map = new Map()
    for (const row of rows) {
      exactKeys(row, ['key', 'text'], 'storage.objects')
      check(isDocumentKey(row.key) && typeof row.text === 'string' && !map.has(row.key), 'storage.objects', 'invalid_document_key')
      map.set(row.key, row.text)
    }
    return map
  }
  const metadata = async () => {
    assertOpen()
    const initial = epoch, snapshot = await backend.headers(); alive(initial)
    exactKeys(snapshot, ['root', 'previous', 'objects', 'hasDocuments', 'index'], 'storage')
    check(typeof snapshot.hasDocuments === 'boolean', 'storage.hasDocuments', 'boolean_required')
    check(snapshot.index === null || typeof snapshot.index === 'string', 'storage.index', 'text_required')
    const identity = JSON.stringify([snapshot.root, snapshot.previous])
    if (roots !== identity) { invalidate(); roots = identity }
    const token = epoch, objects = objectsOf(snapshot.objects)
    if (snapshot.root === null && snapshot.previous === null) return { empty: true, snapshot, token,
      degraded: snapshot.hasDocuments, issues: snapshot.hasDocuments ? [{ path: 'storage', code: 'unpublished_documents' }] : [] }
    const issues = []
    for (const text of [snapshot.root, snapshot.previous]) {
      if (text === null) continue
      try {
        const root = await readLocalRoot(text, scope)
        const raw = objects.get(documentKey('m', root.head.manifestDigest))
        check(raw !== undefined, 'manifest', 'missing_manifest')
        const manifest = await readManifest(raw); sameScope(manifest, scope)
        check(manifest.integrity.digest === root.head.manifestDigest && manifest.commitId === root.head.commitId,
          'manifest', 'head_manifest_mismatch')
        validateLocalQueue(root, manifest); alive(token)
        return { empty: false, snapshot, token, root, manifest, head: root.head, degraded: text !== snapshot.root, issues }
      } catch (error) {
        if (!(error instanceof NutritionValidationError) || unsupported(error) || error.issues.some(i => i.code === 'read_invalidated' || i.code === 'storage_closed')) throw error
        issues.push(...error.issues)
      }
    }
    check(false, 'storage', 'no_complete_commit')
  }
  const fetch = async (meta, keys) => {
    alive(meta.token)
    const result = await backend.readDocuments({ ...guard(meta), keys }); alive(meta.token)
    exactKeys(result, ['objects'], 'storage')
    const objects = objectsOf(result.objects)
    check([...objects.keys()].every(key => keys.includes(key)), 'storage', 'unexpected_document')
    for (const key of keys) check(objects.has(key), 'partitions', 'missing_partition')
    return objects
  }
  const decode = async (text, ref, maxHydratedBytes) => {
    const raw = readDocument(text)
    check(raw.storageVersion === 1, 'partition', raw.storageVersion === 0 ? 'committed_migration_required' : 'unsupported_storage_version')
    const domain = await decodePartition(raw, { maxHydratedBytes })
    await validateConflictArchives([domain])
    sameScope(domain, scope)
    check(raw.id === ref.id && raw.integrity.digest === ref.digest, 'partition', 'partition_reference_mismatch')
    check(raw.sync.revision === ref.revision && raw.sync.writeId === ref.writeId, 'partition', 'revision_mismatch')
    return domain
  }
  const remember = (key, domain) => {
    // Account for expanded snapshots, text/objects and conservative allocation overhead.
    // This is a cache budget, not a claim about the browser's exact heap representation.
    const size = new TextEncoder().encode(JSON.stringify(domain)).length * 4
    if (!maxEntries || size > maxBytes) return
    if (cached.has(key)) { bytes -= cached.get(key).size; cached.delete(key) }
    while (cached.size >= maxEntries || bytes + size > maxBytes) {
      const oldest = cached.keys().next().value; bytes -= cached.get(oldest).size; cached.delete(oldest)
    }
    cached.set(key, { domain, size }); bytes += size
  }
  const scan = async (meta, visit = null, maxBytes = Infinity) => {
    const validation = createDatasetValidator(), ranges = [], refs = new Map()
    let deliveryManifest = null
    if (meta.root.delivery) {
      const delivery = meta.root.delivery, key = documentKey('m', delivery.head.manifestDigest)
      deliveryManifest = await readManifest((await fetch(meta, [key])).get(key))
      sameScope(deliveryManifest, scope)
      check(deliveryManifest.integrity.digest === delivery.head.manifestDigest && deliveryManifest.commitId === delivery.head.commitId &&
        deliveryManifest.pendingOperations.length === 0 && deliveryManifest.parentCommitId === (delivery.expectedHead?.commitId ?? null) &&
        (delivery.expectedHead !== null || deliveryManifest.sequence === 0), 'delivery', 'head_manifest_mismatch')
      check(delivery.uploads.every(digest => deliveryManifest.partitions.some(ref => ref.digest === digest)), 'delivery.uploads', 'missing_partition')
      check(await contentHash(publicationRequest({ ...delivery, manifest: deliveryManifest })) === delivery.requestDigest,
        'delivery', 'delivery_request_mismatch')
      const operation = meta.manifest.pendingOperations.find(op => op.id === delivery.operationId)
      check(await contentHash(operation) === delivery.operationDigest, 'delivery', 'delivery_operation_mismatch')
    }
    const deliveryValidation = createDatasetValidator(), delivered = new Set(deliveryManifest?.partitions.map(ref => ref.digest) ?? [])
    let records = 0, totalBytes = 0, hydratedBytes = 0
    for (const ref of [...meta.manifest.partitions, ...meta.manifest.pendingOperations.flatMap(op => op.partitions), ...(deliveryManifest?.partitions ?? [])]) {
      const key = documentKey('p', ref.digest), previous = refs.get(key)
      check(!previous || JSON.stringify(previous) === JSON.stringify(ref), 'partitions', 'revision_mismatch')
      refs.set(key, ref)
    }
    const current = new Set(meta.manifest.partitions.map(ref => ref.digest))
    const list = [...refs.entries()]
    for (let i = 0; i < list.length; i += MAX_READ_DOCUMENTS) {
      const batch = list.slice(i, i + MAX_READ_DOCUMENTS), objects = await fetch(meta, batch.map(([key]) => key))
      for (const [key, ref] of batch) {
        totalBytes += new TextEncoder().encode(objects.get(key)).length
        check(totalBytes <= maxBytes, 'backup', 'backup_too_large')
        if (maxBytes !== Infinity) {
          hydratedBytes += estimateHydratedPartitionBytes(readDocument(objects.get(key)))
          check(hydratedBytes <= 96 * 1024 * 1024, 'backup', 'backup_hydration_limit')
        }
        const domain = await decode(objects.get(key), ref, maxBytes === Infinity ? undefined : 96 * 1024 * 1024); alive(meta.token)
        if (delivered.has(ref.digest)) deliveryValidation.add(domain)
        if (current.has(ref.digest)) {
          validation.add(domain)
          records += domain.records.foodEntries?.length ?? 0
          if (domain.kind === 'journal') ranges.push(coverage(domain, ref))
        }
        if (visit) { await visit(domain, { current: current.has(ref.digest), text: objects.get(key) }); alive(meta.token) }
      }
    }
    validation.finish()
    deliveryValidation.finish()
    await fetch(meta, [])
    return { ranges, records, documents: list.length, totalBytes }
  }
  const buildIndex = async meta => {
    const verified = await scan(meta)
    // Order coverage exactly as the manifest, including misplaced/legacy dates.
    const map = new Map(verified.ranges.map(row => [row.id, row]))
    const index = await sealDocument({ format: INDEX_FORMAT, storageVersion: 1, domainVersion: DOMAIN_VERSION,
      ...scope, manifestDigest: meta.manifest.integrity.digest, coverage: journalRefs(meta.manifest).map(ref => map.get(ref.id)) })
    alive(meta.token)
    let indexIssue = null
    if (!meta.degraded) {
      try { await backend.saveIndex({ ...guard(meta), index: boundedJson(index) }); alive(meta.token); ignoreIndex = false }
      catch (error) {
        if (error?.issues?.some(i => ['stale_root', 'read_invalidated', 'storage_closed'].includes(i.code))) throw error
        indexIssue = error.issues ?? [{ path: 'index', code: 'index_unavailable' }]
      }
    }
    return { index, ...verified, indexIssue }
  }
  const status = meta => meta.empty ? meta.degraded ? 'recovery-required' : 'empty' : meta.degraded ? 'recovery-required' : 'partially-verified'
  return {
    metadata,
    async captureRestore(maxBytes) {
      check(Number.isSafeInteger(maxBytes) && maxBytes > 0, 'backup', 'invalid_export_options')
      const meta = await metadata()
      if (meta.empty) return { empty: true, degraded: meta.degraded }
      check(!meta.degraded, 'backup', 'recovery_required')
      const objects = new Map(meta.snapshot.objects.map(row => [row.key, row.text]))
      if (meta.root.delivery) {
        const key = documentKey('m', meta.root.delivery.head.manifestDigest)
        objects.set(key, (await fetch(meta, [key])).get(key))
      }
      await scan(meta, async (_, flags) => {
        const raw = readDocument(flags.text)
        objects.set(documentKey('p', raw.integrity.digest), flags.text)
      }, maxBytes)
      return { root: meta.snapshot.root, previous: meta.snapshot.previous,
        objects: [...objects].map(([key, text]) => ({ key, text })) }
    },
    /** Bounded hydration with paired-root CAS on every batch and after the last callback.
     * A failed export must discard its partial sink; no partial archive is authoritative. */
    async exportPartitions({ visit, maxBytes, guard = () => {} }) {
      check(typeof visit === 'function' && Number.isSafeInteger(maxBytes) && maxBytes > 0, 'backup', 'invalid_export_options')
      guard()
      const meta = await metadata()
      check(!meta.degraded, 'backup', 'recovery_required')
      if (meta.empty) { guard(); return { documents: 0, records: 0, totalBytes: 0 } }
      const result = await scan(meta, async (...args) => { guard(); await visit(...args); guard() }, maxBytes)
      guard()
      return result
    },
    invalidate: () => invalidate(true),
    changed: () => invalidate(),
    acceptIndex: () => { ignoreIndex = false },
    cacheStatus: () => ({ entries: cached.size, bytes, maxBytes, maxEntries }),
    async inspect() {
      const meta = await metadata()
      return { status: status(meta), head: meta.head ?? null, manifest: meta.manifest ?? null, issues: meta.issues }
    },
    async verify() {
      try {
        const meta = await metadata()
        if (meta.empty) { check(!meta.degraded, 'storage', 'recovery_required'); return { status: 'empty', documents: 0, records: 0 } }
        const result = await buildIndex(meta)
        return { status: meta.degraded ? 'recovery-required' : 'current', head: meta.head,
          documents: result.documents, records: result.records, indexIssue: result.indexIssue, issues: meta.issues }
      } catch (error) {
        // A known damaged source must not be hidden by an earlier successful cached read.
        invalidate(true)
        throw error
      }
    },
    async period(input) {
      const request = jsonClone(input)
      exactKeys(request, ['start', 'end'], 'period')
      check(isNutritionDate(request.start) && isNutritionDate(request.end) && request.start <= request.end, 'period', 'invalid_period')
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const meta = await metadata()
          if (meta.empty) return { status: status(meta), head: null, entries: [], issues: meta.issues, verification: 'headers' }
          let index = null
          if (!ignoreIndex && !meta.degraded && meta.snapshot.index !== null) {
            try { index = await dateIndex(meta.snapshot.index, meta) }
            catch (error) { if (!(error instanceof NutritionValidationError)) throw error }
            alive(meta.token)
          }
          if (index === null) index = (await buildIndex(meta)).index
          const refs = index.coverage.filter(row => row.start !== null && row.start <= request.end && row.end >= request.start)
          const entries = [], validation = createDatasetValidator()
          for (const ref of refs) {
            const key = documentKey('p', ref.digest)
            let row = cached.get(key)
            if (row) { cached.delete(key); cached.set(key, row) }
            else {
              const objects = await fetch(meta, [key]), domain = await decode(objects.get(key), ref); alive(meta.token)
              remember(key, domain); row = { domain }
            }
            const domain = row.domain
            check(domain.id === ref.id && domain.sync.revision === ref.revision && domain.sync.writeId === ref.writeId, 'partition', 'revision_mismatch')
            const dates = coverage(domain, ref)
            check(dates.start === ref.start && dates.end === ref.end, 'index', 'date_index_mismatch')
            validation.add(domain)
            entries.push(...jsonClone((domain.records.foodEntries ?? []).filter(row => row.d >= request.start && row.d <= request.end)))
          }
          validation.finish(); await fetch(meta, [])
          entries.sort((a, b) => a.d < b.d ? -1 : a.d > b.d ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
          return { status: status(meta), head: meta.head, entries, issues: meta.issues, verification: 'selected-partitions' }
        } catch (error) {
          if (attempt === 2 || !error?.issues?.some(i => i.code === 'stale_root' || i.code === 'read_invalidated')) throw error
        }
      }
    },
  }
}
