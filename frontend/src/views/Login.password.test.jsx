// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Login from './Login.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

/* The sign-in screen with password sign-in (#118). Only an instance that advertises
   `password_login` shows any of it; there, a browser without passkey support finally has a way
   in instead of being told to stay local, and creating a profile can use a password. */
const mocks = vi.hoisted(() => {
  const state = { webauthn: true, config: null, sheets: [] }
  state.snapshot = () => ({
    config: state.config, S: {},
    setUser: vi.fn(), adoptProfile: vi.fn(), setGuest: vi.fn(), loadConfig: vi.fn(async () => state.config),
    pushState: vi.fn(), pullState: vi.fn(),
  })
  return state
})
vi.mock('../store/useStore.js', () => {
  const useStore = selector => selector ? selector(mocks.snapshot()) : mocks.snapshot()
  useStore.getState = mocks.snapshot
  return { useStore, hasData: () => false }
})
vi.mock('../store/useUI.js', () => {
  const snap = () => ({ toast: vi.fn(), openSheet: render => { mocks.sheets.push(render); return {} } })
  const useUI = selector => selector ? selector(snap()) : snap()
  useUI.getState = snap
  return { useUI }
})
vi.mock('../lib/api.js', () => ({
  webauthnOK: () => mocks.webauthn, passkeyLogin: vi.fn(), passkeyRegister: vi.fn(), BIO: 'your fingerprint', bio: () => 'your fingerprint',
  api: vi.fn(), passkeyAssertion: vi.fn(), passwordLogin: vi.fn(), passwordRegister: vi.fn(), passwordResetRedeem: vi.fn(),
}))
vi.mock('../lib/demo.js', () => ({ DEMO: false, REPO: 'https://example.invalid' }))
vi.mock('../sheets.jsx', () => ({ askAddDeviceData: vi.fn(), confirmSheet: vi.fn() }))

const mounted = []
function mount(el) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push({ root, host })
  act(() => root.render(el))
  return host
}
const buttons = host => [...host.querySelectorAll('button')].map(b => b.textContent)
const button = (host, text) => [...host.querySelectorAll('button')].find(b => b.textContent === text)

beforeEach(() => { mocks.webauthn = true; mocks.config = null; mocks.sheets.length = 0 })
afterEach(() => { act(() => { mounted.splice(0).forEach(({ root, host }) => { root.unmount(); host.remove() }) }) })

describe('Login with password sign-in', () => {
  it('an instance without it looks exactly as before', () => {
    const page = mount(<Login />)
    expect(buttons(page)).not.toContain('Sign in with password')
    expect(page.textContent).toContain('Passkeys use your fingerprint. No passwords to remember.')
    mocks.webauthn = false
    const noPasskeys = mount(<Login />)
    expect(noPasskeys.textContent).toContain("This browser doesn't do passkeys, but you can still use openGym locally on this device.")
    expect(buttons(noPasskeys)).not.toContain('Sign in with password')
  })

  it('next to passkeys it is a second button, and the footer no longer says "no passwords"', () => {
    mocks.config = { password_login: true, allow_guest: true }
    const page = mount(<Login />)
    expect(buttons(page).slice(0, 3)).toEqual(['Sign in with passkey', 'Sign in with password', 'Create new profile'])
    expect(page.textContent).toContain('Passkeys use your fingerprint. A password works too, where passkeys do not.')
    act(() => button(page, 'Sign in with password').click())
    const sheet = mount(mocks.sheets[0](() => {}))
    expect(sheet.querySelector('h3').textContent).toBe('Sign in with password')
    expect(sheet.querySelector('input[autocomplete="current-password"]')).toBeTruthy()
  })

  it('a browser without passkeys gets a way in instead of "stay local"', () => {
    mocks.webauthn = false
    mocks.config = { password_login: true, allow_guest: false }
    const page = mount(<Login />)
    expect(page.textContent).toContain("This browser doesn't support passkeys. Sign in with your name and password instead.")
    expect(page.textContent).not.toContain('Try a browser or device with passkey support.')
    expect(buttons(page)).toEqual(['Sign in with password', 'Create new profile'])
    // Creating a profile here can only mean a password: no passkey/password choice to make.
    act(() => button(page, 'Create new profile').click())
    const sheet = mount(mocks.sheets[0](() => {}))
    expect(sheet.querySelector('.seg')).toBeNull()
    expect(sheet.querySelector('input[placeholder="Repeat the password"]')).toBeTruthy()
    expect(buttons(sheet)).toContain('Create profile')
  })

  it('where both work, creating a profile starts on the passkey and switches to a password', () => {
    mocks.config = { password_login: true, invite_only: true }
    const page = mount(<Login />)
    act(() => button(page, 'Create new profile').click())
    const sheet = mount(mocks.sheets[0](() => {}))
    expect(buttons(sheet)).toContain('Create passkey')
    act(() => button(sheet, 'Password').click())
    expect(buttons(sheet)).toContain('Create profile')
    expect(sheet.querySelector('input[placeholder="Invite code"]')).toBeTruthy()
    expect(sheet.querySelector('input[autocomplete="new-password"]')).toBeTruthy()
  })
})

describe('Login on explicitly managed self-hosted instances', () => {
  for (const mode of ['personal', 'multi-user']) {
    it(`${mode} hides registration when the server closes it but keeps existing account access`, () => {
      mocks.config = { instance_mode: mode, registration_open: false, allow_guest: false }
      const page = mount(<Login />)
      expect(buttons(page)).not.toContain('Create new profile')
      expect(buttons(page)).not.toContain('Continue without account')
      expect(buttons(page)).toContain('Sign in with passkey')
      expect(buttons(page)).toContain('Use a code from your other device')
      expect(mocks.sheets).toHaveLength(0)
    })

    it(`${mode} fails closed while registration availability is unknown`, () => {
      mocks.config = { instance_mode: mode, allow_guest: false }
      expect(buttons(mount(<Login />))).not.toContain('Create new profile')
    })
  }

  it('first-owner registration remains invitation protected and disappears after refreshed closure', () => {
    mocks.config = { instance_mode: 'personal', registration_open: true, invite_only: true, allow_guest: false }
    const page = mount(<Login />)
    act(() => button(page, 'Create new profile').click())
    const sheet = mount(mocks.sheets[0](() => {}))
    expect(sheet.querySelector('input[aria-label="Your name"]')).toBeTruthy()
    expect(sheet.querySelector('input[aria-label="Invite code"]')).toBeTruthy()
    expect(buttons(sheet)).toContain('Create passkey')
    mocks.config = { ...mocks.config, registration_open: false }
    act(() => mounted.find(item => item.host === page).root.render(<Login />))
    expect(buttons(page)).not.toContain('Create new profile')
  })

  it('an explicitly open multi-user instance keeps profile creation without an invitation field', () => {
    mocks.config = { instance_mode: 'multi-user', registration_open: true, invite_only: false, allow_guest: false }
    const page = mount(<Login />)
    act(() => button(page, 'Create new profile').click())
    const sheet = mount(mocks.sheets[0](() => {}))
    expect(sheet.querySelector('input[placeholder="Invite code"]')).toBeNull()
    expect(buttons(sheet)).toContain('Create passkey')
  })
})
