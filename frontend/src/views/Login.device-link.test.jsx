// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Login from './Login.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

/* The sign-in screen's way in for a device whose person already has a profile elsewhere (#95):
   a code from the signed-in device gives this one a passkey of its own, instead of "Create new
   profile" making a second, empty one. Only where this browser can make a passkey. */
const mocks = vi.hoisted(() => {
  const state = { webauthn: true, config: null, sheets: [], personal: false }
  state.snapshot = () => ({
    config: state.config, S: {}, user: null, linkCode: null,
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
  createPasskey: vi.fn(),
}))
vi.mock('../lib/demo.js', () => ({ DEMO: false, REPO: 'https://example.invalid' }))
vi.mock('../lib/personal-beta.js',()=>({get PERSONAL_BETA(){return mocks.personal},PERSONAL_ORIGIN:'https://gym.solhren.fr'}))
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

beforeEach(() => { mocks.webauthn = true; mocks.config = null; mocks.personal=false; mocks.sheets.length = 0 })
afterEach(() => { act(() => { mounted.splice(0).forEach(({ root, host }) => { root.unmount(); host.remove() }) }) })

describe('Login: a code from another device', () => {
  it('personal build keeps guest and signup closed while API configuration is unavailable',()=>{
    mocks.personal=true;mocks.config=null;const all=buttons(mount(<Login/>));expect(all).not.toContain('Continue without account');expect(all).not.toContain('Create new profile');expect(all).toContain('Sign in with passkey')
  })
  it('personal beta hides guest and new-account actions once the sole owner exists', () => {
    mocks.config={personal_beta:true,registration_open:false,allow_guest:false,invite_only:true}
    const all=buttons(mount(<Login/>))
    expect(all).toContain('Sign in with passkey');expect(all).not.toContain('Create new profile');expect(all).not.toContain('Continue without account')
  })
  it('personal bootstrap keeps the existing invitation/passkey registration screen', () => {
    mocks.config={personal_beta:true,registration_open:true,allow_guest:false,invite_only:true}
    const page=mount(<Login/>);act(()=>button(page,'Create new profile').click());const sheet=mount(mocks.sheets[0](()=>{}));const invite=sheet.querySelector('input[placeholder="Invite code"]');expect(invite.maxLength).toBeGreaterThanOrEqual(32)
  })
  it('sits under the ways in where passkeys work, and opens the sheet that redeems a code', () => {
    mocks.config = { allow_guest: true }
    const page = mount(<Login />)
    const all = buttons(page)
    expect(all.indexOf('Use a code from your other device')).toBe(all.indexOf('Create new profile') + 1)
    act(() => button(page, 'Use a code from your other device').click())
    const sheet = mount(mocks.sheets[0](() => {}))
    expect(sheet.querySelector('h3').textContent).toBe('Add this device')
    expect(sheet.querySelector('input[placeholder="Code from your other device"]')).toBeTruthy()
  })

  it('is not offered in a browser that cannot make a passkey, with or without passwords', () => {
    mocks.webauthn = false
    expect(buttons(mount(<Login />))).not.toContain('Use a code from your other device')
    mocks.config = { password_login: true }
    expect(buttons(mount(<Login />))).not.toContain('Use a code from your other device')
  })
})
