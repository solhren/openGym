import { check, canonicalJson, jsonClone } from './persistence-contract.js'
import { createNutritionCommands, newNutritionId } from './ui-service.js'
import { createNutritionSync } from './sync.js'
import { createNutritionBackup } from './backup.js'

/** One account-bound lifetime, independent of route mounting. Only successful durable
 * publication changes the view revision. Late work cannot notify a replacement session. */
export function createNutritionUISession({ store, session, getSession, transport, online, newId = newNutritionId }) {
  session = jsonClone(session)
  let closed = false, tail = Promise.resolve(), syncAttempt = 0, timer = null, synchronizing = null
  const listeners = new Set()
  let state = { revision: 0, busy: false, pending: 0, conflicts: 0, syncStatus: session.serverOrigin === null ? 'local' : 'pending', error: null }
  const guard = () => check(!closed && canonicalJson(session) === canonicalJson(getSession()), 'session', 'ui_session_changed')
  const emit = patch => { if (!closed) { state = { ...state, ...patch }; listeners.forEach(fn => fn()) } }
  const sync = session.serverOrigin === null ? null : createNutritionSync({ store, getSession, transport, online, newId })
  const commands = createNutritionCommands({ store, guard, newId })
  const backup = createNutritionBackup({ store, getSession, sync })
  const inspect = async () => {
    guard(); const meta = await store.inspect(); guard()
    emit({ pending: meta.manifest?.pendingOperations.length ?? 0,
      ...(meta.status === 'recovery-required' ? { error: { issues: [{ code: 'recovery_required' }] } } : {}) })
    return meta
  }
  const schedule = () => { if (sync && !closed) { clearTimeout(timer); timer = setTimeout(() => api.synchronize().catch(() => {}), 800) } }
  const change = fn => {
    const task = tail.catch(() => {}).then(async () => {
      guard(); emit({ busy: true, error: null })
      try {
        const result = await fn(); guard()
        emit({ revision: state.revision + 1, syncStatus: sync ? 'pending' : 'local' })
        // Failure to read status after a successful publication cannot turn the already
        // durable save into a failed action (which would invite duplicate creation).
        try { await inspect(); schedule() }
        catch (error) { emit({ error, syncStatus: sync ? 'blocked' : 'local' }) }
        return result
      } catch (error) { emit({ error }); throw error }
      finally { emit({ busy: false }) }
    })
    tail = task; return task
  }
  const read = async fn => { guard(); const result = await fn(); guard(); return result }
  const api = {
    store,
    assertCurrent: guard,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    getSnapshot: () => state,
    inspect,
    day: date => read(() => store.readDay(date)),
    library: () => read(() => store.readLibrary()),
    period: period => read(() => store.readPeriod(period)),
    save: (collection, value, base = null) => change(() => commands.save(collection, value, base)),
    remove: (collection, base) => change(() => commands.remove(collection, base)),
    batch: input => change(() => commands.batch(input)),
    synchronize() {
      guard()
      if (!sync) { emit({ syncStatus: 'local' }); return Promise.resolve({ status: 'local' }) }
      if (synchronizing) return synchronizing
      if (state.busy) return Promise.resolve({ status: 'deferred' })
      const attempt = ++syncAttempt
      emit({ syncStatus: 'syncing', error: null })
      synchronizing = (async () => {
        try {
          const result = await sync.run(); guard()
          if (attempt !== syncAttempt) return result
          await inspect(); guard()
          // A concurrent local publication may have landed during the final server pull.
          const conflicts = state.conflicts + result.conflicts
          emit({ revision: state.revision + 1, conflicts, syncStatus: result.status === 'synced' && state.pending > 0 ? 'pending' : result.status === 'synced' && conflicts > 0 ? 'conflict' : result.status,
            error: result.error ?? null })
          if (state.pending && result.status === 'synced') schedule()
          return result
        } catch (error) { emit({ error, syncStatus: 'blocked' }); throw error }
        finally { synchronizing = null }
      })()
      return synchronizing
    },
    export: options => read(() => backup.export(options)),
    preview: (file, options) => read(() => backup.preview(file, options)),
    restore: preview => change(() => { syncAttempt++; sync?.cancel(); return backup.restore(preview) }),
    recovery: () => read(() => backup.recoveryStatus()),
    async conflicts() {
      const data = await read(() => store.readForRestore({ maxBytes: 32 * 1024 * 1024 }))
      const seen = new Map()
      for (const part of data.domains) for (const [hash, variant] of Object.entries(part.extensions?.nutritionSyncConflicts?.records ?? {})) seen.set(hash, variant)
      return [...seen].map(([hash, value]) => ({ hash, ...value }))
    },
    async refresh() { await inspect(); guard(); emit({ revision: state.revision + 1 }); return api.synchronize() },
    close() { if (!closed) { closed = true; clearTimeout(timer); syncAttempt++; sync?.stop(); listeners.clear(); store.close() } },
  }
  return api
}
