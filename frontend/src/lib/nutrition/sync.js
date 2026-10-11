import { check, exactKeys, jsonClone } from './persistence-contract.js'
import { prepareCommit, readHead, readManifest, recoverCommit } from './persistence-commit.js'
import { decodePartition, encodePartition } from './serialization.js'
import { domainContent, preserveAcknowledgedValues, preserveConflictArchives, same, scoped, validateConflictArchives, validateNutritionReceipt } from './sync-contract.js'
import { mergeNutritionDomains } from './sync-merge.js'
import { preserveHistory } from '../../../../api/nutrition/core/history.js'

const active = new Map()
const issue = (error, code) => error?.issues?.some(i => i.code === code)
const nonce = () => {
  check(typeof globalThis.crypto?.getRandomValues === 'function', 'sync', 'secure_random_required')
  return [...globalThis.crypto.getRandomValues(new Uint8Array(16))].map(n => n.toString(16).padStart(2, '0')).join('')
}
const interrupted = () => Object.assign(new Error('nutrition session changed'), { code: 'nutrition-session-changed' })

/** Dedicated, explicitly started Nutrition coordinator. A session is {userId,serverOrigin,
 * epoch}; epoch must change on logout/login, including an ABA switch back to the same user.
 * transport uses the existing api(path,options) contract. No credentials are persisted.
 * Web Locks serialize tabs; durable outbox/plan CAS is authoritative without Web Locks. */
export function createNutritionSync({ store, getSession, transport, locks = globalThis.navigator?.locks,
  online = () => globalThis.navigator?.onLine !== false, maxPasses = 12, newId = nonce } = {}) {
  check(store && typeof store.syncState === 'function' && typeof getSession === 'function' && typeof transport === 'function', 'sync', 'invalid_sync_dependencies')
  check(Number.isSafeInteger(maxPasses) && maxPasses > 0 && maxPasses <= 100, 'sync', 'invalid_pass_limit')
  const scope = store.scope, query = `generation=${encodeURIComponent(scope.generation)}`
  let running = null, stopped = false, epoch = 0, cancelCurrent = null
  const sessionKey = () => {
    const session = getSession()
    if (!session) return null
    const captured = jsonClone(session)
    exactKeys(captured, ['userId', 'serverOrigin', 'epoch'], 'session')
    check(typeof captured.epoch === 'string' || Number.isSafeInteger(captured.epoch), 'session.epoch', 'invalid_session_epoch')
    return captured
  }
  const cancel = () => { epoch++; cancelCurrent?.(); cancelCurrent = null }
  const perform = async () => {
    let pending = true, publications = 0, conflicts = 0
    const report = (status, extra = {}) => ({ status, pending, publications, conflicts, ...extra })
    let unlisten = () => {}
    try {
      const session = sessionKey(), attempt = epoch
      if (stopped || !session) return report('auth-required')
      check(session.userId === scope.namespace.profileId && session.serverOrigin === scope.namespace.serverOrigin &&
        scope.namespace.serverOrigin !== null, 'session', 'scope_mismatch')
      const cancellation = new Promise((_, reject) => { cancelCurrent = () => reject(interrupted()) })
      // The signal is useful to injected transports; cancellation is also raced because some
      // native/network implementations ignore abort or return a late response anyway.
      const controller = new AbortController()
      const guard = () => {
        if (stopped || attempt !== epoch || !same(session, sessionKey())) { controller.abort(); throw interrupted() }
      }
      const wait = async promise => { guard(); const result = await Promise.race([promise, cancellation]); guard(); return result }
      unlisten = () => { controller.abort(); if (attempt === epoch) cancelCurrent = null }
      const request = async (path, options = {}) => {
        guard()
        return wait(transport(path, { cache: 'no-store', ...options, signal: controller.signal }))
      }
      if (!online()) return report('offline')
      // A browser cookie can have changed in another tab before its app state catches up.
      // Verify the authenticated uid; every subsequent document and receipt also checks scope.
      const me = jsonClone(await request('/api/me'))
      check(me.user?.id === scope.namespace.profileId, 'session', 'authenticated_owner_mismatch')
      const remoteGraph = async local => {
        const response = jsonClone(await request(`/api/nutrition/head?${query}`))
        exactKeys(response, ['status', 'head', 'manifest', 'namespace', 'generation', 'issues'], 'server')
        scoped(response, scope)
        check(response.status !== 'recovery-required', 'server', 'server_recovery_required')
        if (response.status === 'uninitialized') {
          check(response.head === null && response.manifest === null, 'server', 'invalid_empty_head')
          return { head: null, manifest: null, domains: [], partitions: [] }
        }
        check(['partially-verified', 'current'].includes(response.status), 'server', 'invalid_server_status')
        const head = await readHead(response.head), manifest = await readManifest(response.manifest)
        scoped(head, scope); scoped(manifest, scope)
        check(manifest.commitId === head.commitId && manifest.integrity.digest === head.manifestDigest, 'server', 'head_manifest_mismatch')
        check(manifest.pendingOperations.length === 0, 'server', 'server_outbox_not_empty')
        const available = new Map([...local.partitions, ...local.pendingPartitions].map(p => [p.integrity.digest, p]))
        // A local revision can be ahead solely because its publication clock is independent.
        // Rebuild the previously imported portable bytes from the non-authoritative hint,
        // and reuse them ONLY if their hash equals the authenticated manifest descriptor.
        for (const domain of local.domains) {
          const hint = domain.sync.remote, ref = manifest.partitions.find(p => p.id === domain.id)
          if (!hint || !ref || hint.revision !== ref.revision || hint.writeId !== ref.writeId || available.has(ref.digest)) continue
          const { remote: ignored, ...sync } = domain.sync
          const candidate = await wait(encodePartition({ ...domain, sync: { ...sync, ...hint } }))
          if (candidate.integrity.digest === ref.digest) available.set(ref.digest, candidate)
        }
        const partitions = [], seen = new Set()
        // Sequential partition downloads keep requests bounded and respect API rate limits.
        for (const ref of [...manifest.partitions, ...manifest.pendingOperations.flatMap(op => op.partitions)]) {
          if (seen.has(ref.digest)) continue
          const part = available.get(ref.digest) ?? await request(`/api/nutrition/partitions/${ref.digest}?${query}&manifest=${head.manifestDigest}`)
          partitions.push(part); seen.add(ref.digest)
        }
        const graph = await recoverCommit({ ...scope, heads: [head], manifests: [manifest], partitions })
        await validateConflictArchives(graph.domains)
        return graph
      }
      for (let pass = 0; pass < maxPasses; pass++) {
        guard()
        try {
          const state = await wait(store.syncState())
          check(state.status !== 'recovery-required', 'storage', 'recovery_required')
          let delivery = state.delivery
          if (!delivery) {
            const frozen = await wait(store.beginPending())
            if (!frozen) {
              pending = false
              const remote = await remoteGraph(state)
              if (!remote.head) {
                // An empty server after previously acknowledged local data is a restoration
                // or lost server store, not permission to erase that device's history.
                check(state.domains.length === 0, 'server', 'server_history_missing')
                return report('synced')
              }
              await wait(store.importRemote({ expectedLocalHead: state.head, commitId: `nutrition-pull-${newId()}`,
                head: remote.head, manifest: remote.manifest, partitions: [...remote.partitions, ...remote.pendingPartitions] }, { guard }))
              return report('synced')
            }
            pending = true
            const local = await wait(store.syncState()), remote = await remoteGraph(local)
            // An incomplete server restoration must not look like an empty/new account.
            // Clean partitions contain acknowledged history; dirty checkpoint partitions
            // are handled by the merge, including all their records and pinned snapshots.
            const dirty = new Set(local.manifest.pendingOperations.flatMap(op => [...op.partitions.map(p => p.id), ...op.removedPartitionIds]))
            const clean = local.domains.filter(p => !dirty.has(p.id))
            preserveHistory(clean, remote.domains)
            preserveAcknowledgedValues(clean, remote.domains)
            preserveConflictArchives(clean, remote.domains)
            const commitId = `nutrition-sync-${newId()}`
            const domains = await wait(Promise.all(frozen.partitions.map(decodePartition)))
            const merged = await wait(mergeNutritionDomains({ remote: remote.domains, local: domains,
              localStamp: frozen.operation.stamp, writeId: commitId }))
            conflicts += merged.conflicts
            const encoded = [], changed = []
            for (const domain of merged.domains) {
              const oldDomain = remote.domains.find(p => p.id === domain.id), oldPart = remote.partitions.find(p => p.id === domain.id)
              const part = oldDomain && same(domainContent(oldDomain), domainContent(domain)) ? oldPart : await wait(encodePartition(domain))
              encoded.push(part)
              if (!oldPart || oldPart.integrity.digest !== part.integrity.digest) changed.push(part)
            }
            const plan = await wait(prepareCommit({ ...scope, commitId, baseManifest: remote.manifest,
              partitions: changed, pendingOperations: [] }))
            // Pin the *complete* server graph. A restart retries without depending on the
            // server's current head or on any local partition changed meanwhile.
            plan.writes = encoded
            delivery = await wait(store.stageDelivery({ expectedLocalHead: local.head, operationId: frozen.operation.id,
              operationDigest: frozen.operationDigest, plan, uploads: changed.map(p => p.integrity.digest) }, { guard }))
          }
          for (const part of delivery.partitions.filter(p => delivery.uploads.includes(p.integrity.digest))) {
            const response = await request(`/api/nutrition/partitions/${part.integrity.digest}?${query}`,
              { method: 'PUT', body: JSON.stringify(part) })
            check(response.digest === part.integrity.digest && response.staged === true, 'server', 'invalid_staging_response')
          }
          let response
          try {
            response = await request(`/api/nutrition/publications?${query}`, { method: 'POST', body: JSON.stringify(delivery.request) })
          } catch (error) {
            if (error.status === 409 && error.data?.code === 'nutrition-stale-head') {
              guard()
              await wait(store.rejectDelivery(delivery.requestDigest, { guard }))
              continue // The frozen operation survives. Rebase on a fresh complete graph.
            }
            throw error // Unknown outcome/busy/401/503 must retain the exact durable request.
          }
          await wait(validateNutritionReceipt(response, delivery, scope))
          await wait(store.acknowledgeDelivery(response, { guard }))
          publications++
        } catch (error) {
          if (['stale_root', 'stale_delivery', 'pending_local_changes', 'not_in_flight'].some(code => issue(error, code))) continue
          throw error
        }
      }
      return report('pending', { reason: 'pass-limit' })
    } catch (error) {
      const status = error.code === 'nutrition-session-changed' ? 'session-changed' :
        error.status === 401 || error.status === 403 ? 'auth-required' : error.status === 404 && error.data?.code !== 'nutrition-missing' ? 'unsupported' :
          error.status === 429 || error.data?.code === 'nutrition-busy' || error.data?.code === 'nutrition-server-busy' ? 'deferred' :
            error.status == null && !error.issues ? 'offline' : 'blocked'
      return report(status, { error: { code: error.data?.code ?? error.code ?? 'nutrition-sync-failed',
        ...(error.status !== undefined ? { status: error.status } : {}), ...(error.issues ? { issues: error.issues } : {}),
        ...(error.data?.retryAfter ? { retryAfter: error.data.retryAfter } : {}) } })
    } finally { unlisten() }
  }
  return {
    run() {
      if (running) return running
      const requestedEpoch = epoch
      const cancelledResult = () => ({ status: 'session-changed', pending: true, publications: 0, conflicts: 0 })
      const execute = () => stopped || requestedEpoch !== epoch ? cancelledResult() : perform()
      // Same-process calls share a pass. Across tabs the optional Web Lock is only an
      // optimization: the durable first-plan CAS and exact replay handle its absence.
      const key = store.scopeId
      const previous = active.get(key) ?? Promise.resolve()
      running = previous.catch(() => {}).then(() => stopped || requestedEpoch !== epoch ? cancelledResult() :
        locks?.request ? locks.request(`opengym-nutrition-sync-${key}`, execute) : execute())
        .finally(() => { if (active.get(key) === running) active.delete(key); running = null })
      active.set(key, running)
      return running
    },
    cancel,
    stop() { stopped = true; cancel() },
  }
}

/** Lazy application adapter: same cookies, paired Bearer token, subpath and Access headers
 * as training sync. No timers, UI subscription or automatic synchronization is installed. */
export async function createAppNutritionSync({ store, ...options }) {
  const [{ useStore }, { api }] = await Promise.all([import('../../store/useStore.js'), import('../api.js')])
  let epoch = 0, lastUser = useStore.getState().user, lastServer = useStore.getState().sync.server
  const getSession = () => {
    const state = useStore.getState()
    if (state.user !== lastUser || state.sync.server !== lastServer) { epoch++; lastUser = state.user; lastServer = state.sync.server }
    return state.user && state.sync.server ? { userId: state.user.id, serverOrigin: new URL(state.sync.server).origin, epoch } : null
  }
  const sync = createNutritionSync({ ...options, store, getSession, transport: api })
  const unsubscribe = useStore.subscribe(() => {
    const previous = epoch; getSession()
    if (previous !== epoch) sync.cancel()
  })
  return { ...sync, stop() { unsubscribe(); sync.stop() } }
}
