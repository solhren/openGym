// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import App from './App.jsx'
import { DEF, useStore } from './store/useStore.js'
import { setLang, t } from './lib/i18n.js'
import { transactionalIdb } from './lib/nutrition/local-storage.test-util.js'

// Exercise the actual App, Shell, Login, Home, lazy Nutrition route, store and API client.
// Only browser I/O is simulated: unsuccessful HTTP and a transactional IndexedDB model.
// Mocking Shell or pre-setting a guest would miss the regression after the login button.
globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root, host, previous, errors
beforeEach(async () => {
  previous = useStore.getState()
  localStorage.clear()
  window.location.hash = '#/home'
  vi.stubGlobal('indexedDB', transactionalIdb().idb)
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  errors = vi.spyOn(console, 'error')
  useStore.setState({ S: structuredClone(DEF), user: null, ready: false, config: null,
    needsMobileOnboarding: false, linkCode: null, sync: { ...previous.sync, auth: false, offline: false, lastError: null } })
  await setLang('en')
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => {
    root.unmount()
    // Invalidate the account-bound singleton as well as the React tree. Route unmounting
    // deliberately retains it, so restoring only a null user could reuse this test's DB.
    useStore.setState({ user: undefined })
    useStore.setState(previous, true)
  })
  host.remove(); localStorage.clear(); window.location.hash = ''
  await setLang('en'); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
async function waitFor(predicate) {
  for (let n = 0; n < 200 && !predicate(); n++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) })
  expect(predicate()).toBeTruthy()
}
const button = key => [...host.querySelectorAll('button')].find(node => node.textContent.trim() === t(key))
const click = async key => { expect(button(key)).toBeTruthy(); await act(async () => button(key).click()) }
async function type(label, value) {
  const input = [...host.querySelectorAll('label')].find(node => node.textContent === t(label))?.querySelector('input')
  expect(input).toBeTruthy()
  await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
}

test.each(['502 proxy response', 'offline network'])('Continue without account renders the real shell, searches and logs Nutrition with %s', async failure => {
  const fetch = vi.fn(async () => {
    if (failure === 'offline network') throw new TypeError('Failed to fetch')
    return new Response('<html>Bad Gateway</html>', { status: 502, headers: { 'Content-Type': 'text/html' } })
  })
  vi.stubGlobal('fetch', fetch)
  await act(async () => root.render(<App />))
  await waitFor(() => !!button('Continue without account'))
  expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/config', '/api/me'])
  expect(useStore.getState().config).toBeNull()
  // The reported click happened in French; use the real language subscription too.
  await act(async () => { useStore.getState().update(s => { s.lang = 'fr' }) })
  await waitFor(() => button('Continue without account')?.textContent === 'Continuer sans compte')
  await click('Continue without account')
  expect(useStore.getState().isGuest()).toBe(true)
  expect(host.querySelector('h1')?.textContent).toBe('openGym')
  expect(button('Nutrition')).toBeTruthy()
  expect(host.querySelector('#tabbar')).toBeTruthy()
  await click('Nutrition')
  await waitFor(() => host.textContent.includes(t('No food logged in this meal')))
  expect(host.textContent).toContain(t('Nutrition is saved on this device only'))
  await click('Personal foods'); await waitFor(() => !!button('Create food'))
  expect(host.textContent).not.toContain('Guest oats')
  await click('Create food')
  await type('Name', 'Guest oats'); await type('Calories', '380')
  await act(async () => host.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  await waitFor(() => !host.querySelector('form') && host.textContent.includes('Guest oats'))
  await click('Home'); await click('Nutrition'); await click('Personal foods')
  await waitFor(() => host.textContent.includes('Guest oats'))
  await click('Journal'); await waitFor(() => !!button('Add food')); await click('Add food')
  await waitFor(() => !!host.querySelector('.nutrition-result'))
  const search = () => host.querySelector(`input[aria-label="${t('Search foods and recipes')}"]`)
  const query = async value => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(search(), value)
      search().dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }))
    })
    expect(search().value).toBe(value)
  }
  await query('absent food'); expect(host.querySelector('.nutrition-result')).toBeNull()
  await act(async () => search().closest('.searchf').querySelector(`[aria-label="${t('Clear')}"]`).click())
  expect(search().value).toBe(''); expect(host.querySelector('.nutrition-result')).toBeTruthy()
  await query('  GUEST oats  ')
  expect(host.querySelectorAll('.nutrition-result')).toHaveLength(1)
  await act(async () => host.querySelector('.nutrition-result').click()); await type('Quantity', '50')
  await act(async () => host.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  await waitFor(() => !host.querySelector('form') && !!host.querySelector('.nutrition-list strong'))
  expect(host.querySelector('.nutrition-list strong').textContent).toBe('Guest oats')
  expect(host.textContent).toContain('190')
  await click('Home'); await click('Nutrition')
  await waitFor(() => host.querySelector('.nutrition-list strong')?.textContent === 'Guest oats')
  expect(host.textContent).toContain(t('Nutrition is saved on this device only'))
  expect(host.textContent).not.toContain(t('Nutrition synchronized'))
  // A guest must never publish the durable local edit to an unavailable server.
  expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/config', '/api/me'])
  expect(errors.mock.calls).toEqual([])
})

test('a successful config explicitly forbidding guests still removes a saved guest entrance', async () => {
  localStorage.setItem('gym_guest', '1')
  vi.stubGlobal('fetch', vi.fn(async url => new Response(JSON.stringify(
    url === '/api/config' ? { allow_guest: false } : { error: 'unauthorized' }
  ), { status: url === '/api/config' ? 200 : 401, headers: { 'Content-Type': 'application/json' } })))
  await act(async () => root.render(<App />))
  await waitFor(() => useStore.getState().ready)
  expect(useStore.getState().isGuest()).toBe(false)
  expect(button('Continue without account')).toBeUndefined()
  expect(button('Nutrition')).toBeUndefined()
  expect(host.querySelector('#tabbar')).toBeNull()
  expect(errors.mock.calls).toEqual([])
})
