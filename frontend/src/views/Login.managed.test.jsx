// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, expect, test, vi } from 'vitest'
import Login from './Login.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const state = vi.hoisted(() => {
  vi.stubEnv('VITE_OPENGYM_MANAGED_WEB', '1')
  vi.stubEnv('VITE_MOBILE', '0')
  vi.stubEnv('VITE_OPENGYM_PERSONAL_BETA', '0')
  return { config: null, loadConfig: vi.fn(), sheets: [] }
})
vi.mock('../store/useStore.js', () => {
  const snapshot = () => ({ config: state.config, loadConfig: state.loadConfig, S: {}, setUser: vi.fn(), adoptProfile: vi.fn(), setGuest: vi.fn() })
  const useStore = selector => selector ? selector(snapshot()) : snapshot()
  useStore.getState = snapshot
  return { useStore, hasData: () => false }
})
vi.mock('../store/useUI.js', () => {
  const snapshot = () => ({ toast: vi.fn(), openSheet: render => state.sheets.push(render) })
  const useUI = selector => selector ? selector(snapshot()) : snapshot()
  useUI.getState = snapshot
  return { useUI }
})
vi.mock('../lib/api.js', () => ({
  webauthnOK: () => true, passkeyLogin: vi.fn(), passkeyRegister: vi.fn(), bio: () => 'your fingerprint',
  api: vi.fn(), passkeyAssertion: vi.fn(), passwordLogin: vi.fn(), passwordRegister: vi.fn(), passwordResetRedeem: vi.fn(),
}))
vi.mock('../lib/demo.js', () => ({ DEMO: false, REPO: 'https://example.invalid' }))
vi.mock('../sheets.jsx', () => ({ askAddDeviceData: vi.fn(), confirmSheet: vi.fn() }))
let host, root
const buttons = () => [...host.querySelectorAll('button')].map(button => button.textContent)
const render = () => act(() => root.render(<Login />))
beforeEach(() => {
  state.config = null; state.loadConfig.mockClear(); state.sheets.length = 0
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })
afterAll(() => vi.unstubAllEnvs())

test('first open with unavailable API cannot create a local guest or offer unconfirmed registration', () => {
  render()
  expect(buttons()).not.toContain('Continue without account')
  expect(buttons()).not.toContain('Create new profile')
  expect(buttons()).toContain('Sign in with passkey')
  expect(host.querySelector('[role="alert"]').textContent).toContain('Could not load')
  act(() => [...host.querySelectorAll('button')].find(button => button.textContent === 'Try again').click())
  expect(state.loadConfig).toHaveBeenCalledTimes(1)
})

test('retry can expose only server-authorized first-owner registration and retains no guest entrance', () => {
  render()
  state.config = { instance_mode: 'personal', registration_open: true, invite_only: true, allow_guest: false }
  render()
  expect(host.querySelector('[role="alert"]')).toBeNull()
  expect(buttons()).toContain('Create new profile')
  expect(buttons()).not.toContain('Continue without account')
})

test('a mismatched legacy configuration does not silently turn the managed web build into a guest app', () => {
  state.config = { allow_guest: true }
  render()
  expect(buttons()).not.toContain('Continue without account')
  expect(buttons()).not.toContain('Create new profile')
})
