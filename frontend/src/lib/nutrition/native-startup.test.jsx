// @vitest-environment happy-dom
import React, { StrictMode, act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, afterEach, afterAll, test, expect, vi } from 'vitest'
import { readdir } from 'node:fs/promises'
import Nutrition from '../../views/Nutrition.jsx'
import { useNutrition } from './use-nutrition.jsx'
import { useStore } from '../../store/useStore.js'
import { setLang } from '../i18n.js'
import { setRemoteAuth } from '../api.js'
import { nutritionFsBackend } from './local-store-fs.js'
import { nutritionInstallationIdentity } from './ui-identity.js'
import { diskBridge } from './local-storage.test-util.js'
import { fixture, scope, entry } from '../../../../api/test/nutrition-fixtures.mjs'
import { Capacitor } from '@capacitor/core'

// Keep the real locked Capacitor runtime, including its Proxy and Promise behavior.
// Only the native dispatcher/filesystem and HTTP boundary are simulated. The default
// backend loader, identity, hook, screen, commands and sync are not replaced.
const native = vi.hoisted(() => {
  vi.stubEnv('VITE_MOBILE', '1')
  vi.stubEnv('VITE_OPENGYM_PERSONAL_BETA', '0')
  const state = { disk: null, calls: [], failure: null }
  vi.stubGlobal('androidBridge', {})
  vi.stubGlobal('Capacitor', {
    PluginHeaders: [
      { name: 'NutritionStorage', methods: ['headers', 'snapshot', 'readDocuments', 'saveIndex', 'publish', 'collect']
        .map(name => ({ name, rtype: 'promise' })) },
      { name: 'App', methods: [{ name: 'addListener', rtype: 'callback' }, { name: 'removeListener', rtype: 'promise' }] },
    ],
    // The shared UI installs an App back-button listener at import time.
    nativeCallback: (plugin, method) => {
      if (plugin === 'App' && method === 'addListener') return 'synthetic-listener'
      throw Error('Unexpected native callback')
    },
    nativePromise: async (plugin, method, options) => {
      if (plugin === 'App' && method === 'removeListener') return {}
      state.calls.push({ plugin, method })
      if (state.failure) throw state.failure
      if (plugin !== 'NutritionStorage') throw Error('Unexpected native plugin')
      return state.disk.plugin[method](options)
    },
  })
  return state
})

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root, host, old, observed, network, requests, server, cleanup
beforeEach(async () => {
  native.disk = await diskBridge(); native.calls = []; native.failure = null
  old = useStore.getState(); observed = null; network = 'offline'; requests = []; cleanup = []
  server = await fixture({ after: fn => cleanup.push(fn) })
  localStorage.removeItem('gym_guest')
  useStore.setState({ user: { id: scope.namespace.profileId }, sync: { ...old.sync, server: scope.namespace.serverOrigin } })
  setRemoteAuth(scope.namespace.serverOrigin, 'synthetic-test-token')
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    const parsed = new URL(url), path = parsed.pathname
    requests.push({ url, method: options.method ?? 'GET', authorization: options.headers?.Authorization })
    expect(parsed.origin).toBe(scope.namespace.serverOrigin)
    if (network === 'offline') throw new TypeError('synthetic offline network')
    const body = options.body ? JSON.parse(options.body) : null
    let response
    if (path === '/api/me') response = { user: { id: scope.namespace.profileId } }
    else if (path === '/api/nutrition/head') response = await server.store.head()
    else if (path === '/api/nutrition/publications') response = await server.store.publish(body)
    else if (path.includes('/partitions/')) {
      const digest = path.split('/').at(-1)
      response = options.method === 'PUT' ? await server.store.upload(digest, body) : await server.store.partition(digest, parsed.searchParams.get('manifest'))
    } else if (path.includes('/manifests/')) response = await server.store.manifest(path.split('/').at(-1))
    else throw Error(`Unexpected test route: ${path}`)
    return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(response)) }
  }))
  await setLang('en', false)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => { root.unmount(); useStore.setState({ user: old.user, sync: old.sync }) })
  host.remove(); setRemoteAuth('', null); localStorage.removeItem('gym_guest')
  await native.disk.cleanup()
  for (const fn of cleanup.reverse()) await fn()
})
afterAll(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

function Observer() { observed = useNutrition(); return null }
async function mount() {
  await act(async () => root.render(<StrictMode><MemoryRouter initialEntries={['/nutrition?date=2026-10-10']}>
    <Nutrition /><Observer />
  </MemoryRouter></StrictMode>))
}
async function wait(predicate) {
  for (let i = 0; i < 200 && !predicate(); i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  expect(predicate(), host.textContent).toBeTruthy()
}
async function reopen() {
  await act(async () => {
    root.unmount()
    // End the account lifetime as a reload would, without changing its disk files.
    useStore.setState({ user: null })
    useStore.setState({ user: { id: scope.namespace.profileId } })
  })
  root = createRoot(host); await mount()
  await wait(() => observed?.service && observed.status.syncStatus === 'offline')
}

test('first native open reaches headers through the real Capacitor Proxy', async () => {
  expect(Capacitor.getPlatform()).toBe('android')
  const backend = nutritionFsBackend()
  try {
    await backend.open('a'.repeat(64))
    expect(native.calls).toEqual([{ plugin: 'NutritionStorage', method: 'headers' }])
    expect(await backend.headers()).toEqual({ root: null, previous: null, index: null, objects: [], hasDocuments: false })
    expect(requests).toEqual([])
  } finally { backend.close() }
})

test('empty native guest storage reaches the real journal under StrictMode without HTTP', async () => {
  useStore.setState({ user: null }); useStore.getState().setGuest(true)
  expect(await readdir(native.disk.control.base)).toEqual([])
  await mount()
  await wait(() => host.textContent.includes('No food logged in this meal'))
  expect(observed.status.syncStatus).toBe('local')
  expect(host.textContent).not.toContain('Opening Nutrition storage…')
  expect(host.textContent).not.toContain('Loading…')
  expect(host.querySelector('[role="alert"]')).toBeNull()
  expect(requests).toEqual([])
  expect(native.calls.filter(call => call.method === 'publish')).toHaveLength(1) // installation identity only
  const identity = await nutritionInstallationIdentity()
  expect(observed.service.store.scope.namespace.profileId).toBe(`local-${identity.profileId}`)
  expect(await nutritionInstallationIdentity()).toEqual(identity)
})

test('native journal opens offline, preserves identity, history and frozen delivery on reopen, then syncs through api', async () => {
  await mount()
  await wait(() => observed?.service && observed.status.syncStatus === 'offline' && host.textContent.includes('No food logged in this meal'))
  expect(observed.service.store.scope).toEqual(scope)
  const identity = await nutritionInstallationIdentity()
  await act(async () => observed.service.save('foodEntries', entry()))
  await wait(() => host.textContent.includes('Oats'))
  const frozen = await observed.service.store.beginPending(), previous = await observed.service.store.read()
  await reopen()
  await wait(() => host.textContent.includes('Oats'))
  expect(await nutritionInstallationIdentity()).toEqual(identity)
  expect(await observed.service.store.beginPending()).toEqual(frozen)
  expect((await observed.service.store.read()).domains).toEqual(previous.domains)
  expect((await observed.service.store.read()).pendingOperations).toHaveLength(1)
  expect(host.textContent).not.toContain('Opening Nutrition storage…')
  network = 'online'
  await act(async () => { window.dispatchEvent(new Event('online')) })
  await wait(() => observed.status.syncStatus === 'synced')
  expect((await observed.service.store.read()).pendingOperations).toEqual([])
  expect((await observed.service.day('2026-10-10')).entries).toEqual([entry()])
  expect((await server.store.head()).head).not.toBeNull()
  expect(requests.some(request => request.method === 'PUT')).toBe(true)
  expect(requests.some(request => request.method === 'POST')).toBe(true)
  expect(requests.every(request => request.authorization === 'Bearer synthetic-test-token')).toBe(true)
})

test('a native headers failure rejects startup visibly instead of leaving the opening pending', async () => {
  native.failure = Object.assign(Error('synthetic native I/O failure'), { code: 'IO_FAILED' })
  await mount()
  await wait(() => !!host.querySelector('[role="alert"]'))
  expect(observed.error.issues).toContainEqual({ path: 'storage', code: 'storage_io_failed' })
  expect(observed.service).toBeNull()
  expect(host.textContent).not.toContain('Opening Nutrition storage…')
  expect(requests).toEqual([])
  expect(await readdir(native.disk.control.base)).toEqual([])
})
