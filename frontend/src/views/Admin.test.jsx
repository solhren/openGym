// @vitest-environment happy-dom
// The admin drill-down (QA C16): a profile whose stored workouts hold a null or otherwise
// shapeless entry must still open, because the sheet host sits outside the route's
// ErrorBoundary — a throw here blanked the whole app and left the account un-disableable.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Admin from './Admin.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({ answers: {}, sheets: [], config: null, calls: [] }))
vi.mock('../lib/api.js', () => ({
  api: (path, options) => {
    mocks.calls.push([path, options])
    const key = path.split('?')[0]
    return key in mocks.answers ? Promise.resolve().then(() => typeof mocks.answers[key] === 'function' ? mocks.answers[key]() : mocks.answers[key]) : Promise.reject(new Error('not found'))
  }
}))
vi.mock('../store/useStore.js', () => {
  const snap = () => ({ user: { id: 'adm', name: 'Admin', admin: true }, S: {}, config: mocks.config })
  const useStore = selector => selector ? selector(snap()) : snap()
  useStore.getState = snap
  return { useStore }
})
vi.mock('../store/useUI.js', () => {
  const snap = () => ({ toast: () => {}, openSheet: render => mocks.sheets.push(render) })
  const useUI = selector => selector ? selector(snap()) : snap()
  useUI.getState = snap
  return { useUI }
})
vi.mock('react-router-dom', () => ({ useNavigate: () => () => {} }))
vi.mock('../sheets.jsx', () => ({ confirmSheet: vi.fn() }))
vi.mock('./AdminCoach.jsx', () => ({ default: () => null }))

const mounted = []
function render(el) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push(root)
  act(() => root.render(el))
  return host
}
const settle = () => act(() => new Promise(r => setTimeout(r, 0)))

const good = { id: 'w1', name: 'Push day', d: '2026-09-10', start: 1000, end: 61000, entries: [{ sets: [{ done: true }, { done: false }] }] }

beforeEach(() => {
  document.body.innerHTML = ''
  mocks.sheets.length = 0
  mocks.config = null
  mocks.calls = []
  mocks.answers = {
    '/api/admin/users': { users: [{ id: 'u1', name: 'Mallory', workouts: 2, lastSync: null, disabled: false }], invite_only: false },
    '/api/admin/invites': { invites: [] },
    '/api/admin/audit': { rows: [] },
    '/api/admin/user': {
      user: { id: 'u1', name: 'Mallory', created: '2026-09-01T00:00:00Z', disabled: false, admin: false },
      unit: 'kg', lastSync: null, routines: [], bodyweight: [],
      // What GET /api/admin/user hands over for a document written before PUT /api/data dropped
      // such entries: a null, and a bare object without entries, next to a real session.
      workouts: [null, good, {}]
    }
  }
})
afterEach(() => { act(() => { mounted.splice(0).forEach(root => root.unmount()) }) })

describe('Admin user drill-down', () => {
  it('account-only responses keep management available without fake statistics, private history or export', async () => {
    mocks.config = { instance_mode: 'multi-user', registration_open: true }
    const user = { id: 'u1', name: 'Mallory', created: '2026-09-01T00:00:00Z', disabled: false, admin: false }
    mocks.answers['/api/admin/users'] = { account_only: true, users: [user], invite_only: true }
    mocks.answers['/api/admin/user'] = { account_only: true, user }
    const page = render(<Admin />)
    await settle()
    expect(page.textContent).not.toContain('Training now')
    expect(page.textContent).not.toContain('undefined workouts')
    expect(page.textContent).not.toContain('Active 7 days')
    const row = [...page.querySelectorAll('.item')].find(el => el.textContent.includes('Mallory'))
    expect(row.tagName).toBe('BUTTON')
    act(() => row.click())
    const sheet = render(mocks.sheets[0](() => {}))
    await settle()
    expect(sheet.textContent).toContain('Disable account')
    expect(sheet.textContent).toContain('Delete account')
    expect(sheet.textContent).not.toContain('Workout history')
    expect(sheet.textContent).not.toContain('No workouts logged')
    expect(sheet.textContent).not.toContain('Download their data')
    expect(sheet.querySelector('.tiles')).toBeNull()
    expect(sheet.textContent).toContain('retained Nutrition versions')
    expect(page.textContent).toContain('New code')
  })

  it('personal mode does not offer invitation generation', async () => {
    mocks.config = { instance_mode: 'personal', registration_open: false }
    mocks.answers['/api/admin/users'] = { account_only: true, users: [{ id: 'adm', name: 'Owner', admin: true }] }
    const page = render(<Admin />)
    await settle()
    expect(page.textContent).toContain('Owner')
    expect(page.textContent).not.toContain('Invite codes')
    expect(page.textContent).not.toContain('New code')
  })

  it('a failed account-detail read reports an error instead of loading forever', async () => {
    delete mocks.answers['/api/admin/user']
    const page = render(<Admin />)
    await settle()
    act(() => page.querySelector('.item').click())
    const sheet = render(mocks.sheets[0](() => {}))
    await settle()
    expect(sheet.querySelector('[role="alert"]')).toBeTruthy()
    expect(sheet.textContent).not.toContain('Loading…')
    expect(sheet.textContent).not.toContain('Delete account')
  })

  it('opens a profile with malformed workout entries and still offers "Disable account"', async () => {
    const page = render(<Admin />)
    await settle()
    const row = [...page.querySelectorAll('.item')].find(el => el.textContent.includes('Mallory'))
    expect(row).toBeTruthy()
    act(() => row.click())
    expect(mocks.sheets.length).toBe(1)
    const sheet = render(mocks.sheets[0](() => {}))
    await settle()
    const buttons = [...sheet.querySelectorAll('button')].map(b => b.textContent)
    expect(buttons).toContain('Disable account')
    // The one real session is listed; the two shapeless entries are skipped, not drawn as blanks.
    const rows = [...sheet.querySelectorAll('.list > div')]
    expect(rows.length).toBe(1)
    expect(rows[0].textContent).toContain('Push day')
    expect(rows[0].textContent).toContain('1 sets')
  })
})

// The users call failing, or answering without a list, used to leave "Loading…" up for good —
// what a paired phone that had lost its pairing showed its admin, and all it showed.
describe('Admin when the users cannot be loaded', () => {
  const text = page => page.textContent
  it('an answer without a list is an error, not an endless "Loading…"', async () => {
    mocks.answers['/api/admin/users'] = {}
    const page = render(<Admin />)
    await settle()
    expect(text(page)).not.toContain('Loading…')
    expect(text(page)).toContain('Could not load the users')
    expect(text(page)).toContain('The server answered without a list of users.')
  })

  it('a failed call says why, and "Try again" loads the list once the server answers', async () => {
    delete mocks.answers['/api/admin/users']
    const page = render(<Admin />)
    await settle()
    expect(page.querySelector('[role="alert"]').textContent).toContain('not found')

    mocks.answers['/api/admin/users'] = { users: [{ id: 'u1', name: 'Mallory', workouts: 2, lastSync: null, disabled: false }], invite_only: false }
    const retry = [...page.querySelectorAll('button')].find(b => b.textContent === 'Try again')
    act(() => retry.click())
    await settle()
    expect(page.querySelector('[role="alert"]')).toBeNull()
    expect(text(page)).toContain('1 users')
    expect([...page.querySelectorAll('.item')].some(el => el.textContent.includes('Mallory'))).toBe(true)
  })

  it('a list that loaded stays up when a later update fails, marked as the last one', async () => {
    const page = render(<Admin />)
    await settle()
    delete mocks.answers['/api/admin/users']
    const refresh = page.querySelector('[aria-label="refresh"]')
    act(() => refresh.click())
    await settle()
    expect(text(page)).toContain('The last update failed')
    expect([...page.querySelectorAll('.item')].some(el => el.textContent.includes('Mallory'))).toBe(true)
  })
})


describe('managed invitation feedback', () => {
  it('explains personal mode and does not offer extra accounts', async () => {
    mocks.config = { instance_mode: 'personal', signup_policy: 'invite', max_users: 1 }
    const host = render(<Admin />); await settle()
    expect(host.querySelector('[aria-label="Instance access policy"]').textContent).toContain('Personal instance')
    expect(host.textContent).toContain('Account limit: 1')
    expect(host.textContent).not.toContain('New code')
    expect(host.textContent).toContain('does not install catalogues')
  })

  it('failed invitation reads are not presented as an empty list or open registration', async () => {
    delete mocks.answers['/api/admin/users']; delete mocks.answers['/api/admin/invites']
    const host = render(<Admin />); await settle()
    expect(host.textContent).toContain('Could not load invitations')
    expect(host.textContent).not.toContain('No codes yet')
    expect(host.textContent).not.toContain('Sign-up is open')
    expect([...host.querySelectorAll('button')].find(b => b.textContent === 'New code').disabled).toBe(true)
    mocks.answers['/api/admin/invites'] = { invites: [{ code: 'FIXTURE8' }] }
    await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === 'Retry invitations').click())
    expect([...host.querySelectorAll('input')].some(input => input.value === 'FIXTURE8' && input.readOnly)).toBe(true)
    expect(host.textContent).not.toContain('Could not load invitations')
  })

  it('creating an invitation is single-flight and failed clipboard writes do not claim success', async () => {
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(Error('denied')) } })
    try {
      let complete
      mocks.answers['/api/admin/invites/new'] = () => new Promise(resolve => { complete = resolve })
      const host = render(<Admin />); await settle()
      const button = [...host.querySelectorAll('button')].find(b => b.textContent === 'New code')
      await act(async () => { button.click(); button.click() })
      expect(mocks.calls.filter(([path]) => path.endsWith('/invites/new'))).toHaveLength(1)
      expect(button.disabled).toBe(true)
      // Even if refreshing fails, a created code stays visible for manual copying.
      delete mocks.answers['/api/admin/invites']
      await act(async () => complete({ invite: { code: 'FIXTURE8' } }))
      expect(host.textContent).toContain('Could not copy')
      expect([...host.querySelectorAll('input')].some(input => input.value === 'FIXTURE8' && input.readOnly)).toBe(true)
      expect(host.textContent).not.toContain('Code copied')
      mocks.answers['/api/admin/invites'] = { invites: [{ code: 'FIXTURE8', usedBy: 'second-account' }] }
      await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === 'Retry invitations').click())
      expect(host.textContent).toContain('Already used')
      expect([...host.querySelectorAll('input')].some(input => input.value === 'FIXTURE8')).toBe(false)
    } finally {
      if (original) Object.defineProperty(navigator, 'clipboard', original)
      else delete navigator.clipboard
    }
  })
})
