// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, afterEach, test, expect, vi } from 'vitest'
import { useNutrition } from './use-nutrition.jsx'
import { useStore } from '../../store/useStore.js'
import { nutritionIdbBackend } from './local-store-idb.js'
import { transactionalIdb } from './local-storage.test-util.js'
import { entry } from './fixtures.test-util.js'
const context = vi.hoisted(() => ({ engine: null, service: null, opened: [], delay: null }))
vi.mock('./ui-identity.js', () => ({ nutritionInstallationIdentity: async () => ({ profileId: 'a'.repeat(32), deviceId: 'b'.repeat(32) }) }))
vi.mock('../api.js', () => ({ api: async () => { throw Object.assign(Error('unauthenticated fixture'), { status: 401 }) } }))
vi.mock('./local-store.js', async original => {
  const module = await original()
  return { ...module, createNutritionLocalStore: async options => {
    const store = await module.createNutritionLocalStore({ ...options, backend: nutritionIdbBackend({ idb: context.engine.idb }) })
    context.opened.push(store); if (context.delay) await context.delay; return store
  } }
})
globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root, host, old
beforeEach(() => {
  old = useStore.getState(); context.engine = transactionalIdb(); context.service = null; context.opened = []; context.delay = null
  localStorage.removeItem('gym_guest'); useStore.setState({ user: { id: 'account-a' }, sync: { ...old.sync, server: 'https://gym.test' } })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => { root.unmount(); useStore.setState({ user: old.user, sync: old.sync }) }); host.remove() })
function Harness() {
  const value = useNutrition(); context.service = value.service
  return <div>{value.service?.store.scope.namespace.profileId ?? 'opening'}</div>
}
const wait = async predicate => {
  for (let n = 0; n < 200 && !predicate(); n++) await act(async () => { await new Promise(r => setTimeout(r, 5)) })
  expect(predicate()).toBeTruthy()
}
test('switching accounts hides the old service immediately, closes it and retains its queued data on return', async () => {
  await act(async () => root.render(<Harness />)); await wait(() => host.textContent === 'account-a')
  const previous = context.service
  await act(async () => previous.save('foodEntries', entry()))
  await act(async () => useStore.setState({ user: { id: 'account-b' } }))
  expect(host.textContent).not.toBe('account-a'); await wait(() => host.textContent === 'account-b')
  expect((await context.service.day(entry().d)).entries).toEqual([])
  await expect(previous.day(entry().d)).rejects.toThrow()
  await act(async () => useStore.setState({ user: { id: 'account-a' } })); await wait(() => host.textContent === 'account-a')
  expect((await context.service.day(entry().d)).entries).toHaveLength(1); expect((await context.service.store.read()).pendingOperations).toHaveLength(1)
})
test('an asynchronous old open cannot replace the newer session', async () => {
  let release; context.delay = new Promise(resolve => { release = resolve })
  await act(async () => root.render(<Harness />)); await wait(() => context.opened.length === 1)
  await act(async () => useStore.setState({ user: { id: 'account-b' } })); await wait(() => context.opened.length === 2)
  context.delay = null; await act(async () => release()); await wait(() => host.textContent === 'account-b')
  await expect(context.opened[0].inspect()).rejects.toThrow()
})
test('guest data lives in a separate durable scope and is never silently adopted by sign-in', async () => {
  await act(async () => { useStore.setState({ user: null }); useStore.getState().setGuest(true); root.render(<Harness />) })
  await wait(() => host.textContent.startsWith('local-')); await act(async () => context.service.save('foodEntries', entry()))
  await act(async () => useStore.setState({ user: { id: 'account-a' } })); await wait(() => host.textContent === 'account-a')
  expect((await context.service.day(entry().d)).entries).toEqual([])
})
