import { useEffect, useState, useSyncExternalStore } from 'react'
import { useStore } from '../../store/useStore.js'
import { api } from '../api.js'
import { createNutritionLocalStore } from './local-store.js'
import { createNutritionUISession } from './ui-session.js'
import { nutritionInstallationIdentity } from './ui-identity.js'
import { check } from './persistence-contract.js'
import { MOBILE } from '../mobile.js'
import { appBase } from '../app-base.js'

const stateKey = state => JSON.stringify([state.user?.id ?? null, state.sync.server, state.isGuest()])
let current = null, opening = null, epoch = 0, key = null, previousUser = null
const getSession = () => current?.session ?? null
const stopCurrent = () => { epoch++; current?.api.close(); current = null; opening = null }
const unsubscribe = useStore.subscribe((next, previous) => {
  if (stateKey(next) !== stateKey(previous) || next.user !== previous.user) { stopCurrent(); key = null }
})

/** Lazy singleton: navigating away does not stop a durable pending delivery. Account changes
 * invalidate it immediately. Online/focus events refresh through Nutrition's own coordinator. */
async function open() {
  const state = useStore.getState(), nextKey = stateKey(state)
  if (key !== nextKey || previousUser !== state.user) { stopCurrent(); key = nextKey; previousUser = state.user }
  if (current) return current.api
  if (opening) return opening
  const attempt = epoch
  opening = (async () => {
    check(!!state.user || state.isGuest(), 'session', 'auth_required')
    const identity = await nutritionInstallationIdentity()
    check(attempt === epoch, 'session', 'ui_session_changed')
    const session = { userId: state.user ? state.user.id : `local-${identity.profileId}`,
      serverOrigin: state.user ? new URL(state.sync.server).origin : null, epoch: attempt }
    const store = await createNutritionLocalStore({ namespace: { profileId: session.userId, serverOrigin: session.serverOrigin },
      generation: 'generation-1', deviceId: identity.deviceId })
    if (attempt !== epoch) { store.close(); throw new Error('nutrition-session-changed') }
    try {
      if (state.user) {
        const base = new URL(state.sync.server)
        if (!MOBILE) base.pathname = appBase()
        const meta = await store.inspect()
        await nutritionInstallationIdentity({ binding: { scope: store.scope, apiBase: base.origin + base.pathname,
          hasExistingData: meta.head !== null || meta.status === 'recovery-required' } })
      }
      check(attempt === epoch, 'session', 'ui_session_changed')
    } catch (error) { store.close(); throw error }
    const service = createNutritionUISession({ store, session, getSession, transport: api })
    current = { session, api: service }
    await service.inspect()
    return service
  })().catch(error => { if (attempt === epoch) { current?.api.close(); current = null; opening = null } throw error })
  return opening
}
const refresh = () => current?.api.refresh().catch(() => {})
globalThis.window?.addEventListener('online', refresh)
globalThis.window?.addEventListener('focus', refresh)
import.meta.hot?.dispose(() => {
  unsubscribe(); stopCurrent()
  globalThis.window?.removeEventListener('online', refresh)
  globalThis.window?.removeEventListener('focus', refresh)
})
const empty = { revision: 0, busy: false, pending: 0, syncStatus: 'loading', error: null }
const noSubscribe = () => () => {}
export function useNutrition() {
  const scope = useStore(stateKey), user = useStore(s => s.user)
  const [opened, setOpened] = useState(null)
  useEffect(() => {
    let active = true; setOpened(null)
    open().then(service => {
      if (active) { setOpened({ service, scope, user }); service.synchronize().catch(() => {}) }
    }, error => { if (active) setOpened({ error, scope, user }) })
    return () => { active = false }
  }, [scope, user])
  // Discard the old account even in the render before the effect's cleanup runs.
  const owned = opened?.scope === scope && opened?.user === user ? opened : null
  const service = owned?.service ?? null
  const status = useSyncExternalStore(service?.subscribe ?? noSubscribe, service?.getSnapshot ?? (() => empty))
  return { service, status, error: owned?.error ?? null }
}
