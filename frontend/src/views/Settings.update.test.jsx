// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Settings from './Settings.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// The updater downloads an .apk and hands it to the Android package installer, so its row
// may only ever show on the native Android build: never on the web, never on iOS. Both standard
// and generic self-hosted (`PUBLIC_ANDROID`) Android APKs support in-app updates unless explicitly
// disabled via `VITE_UPDATE_DISABLED=1`.
const mocks = vi.hoisted(() => {
  const state = {
    S: null,
    MOBILE: false,
    android: false,
    automaticUpdates: true,
    toast: vi.fn(),
    openSheet: vi.fn(render => {
      const close = vi.fn()
      render?.(close)
      return close
    }),
    appListeners: [],
  }
  state.snapshot = () => ({
    S: state.S,
    user: null,
    update: mut => {
      const next = structuredClone(state.S)
      mut(next)
      state.S = next
    },
    replaceState: vi.fn(), setUser: vi.fn(), pullState: vi.fn(), pushState: vi.fn(),
    signOut: vi.fn(), signOutAll: vi.fn(), resetDemo: vi.fn(), disconnectServer: vi.fn(),
  })
  state.checkForUpdate = vi.fn(() => Promise.resolve({
    hasUpdate: true,
    latestVersion: '9.9.9',
    apkUrl: 'https://x/opengym-selfhosted.apk',
    hashUrl: 'https://x/opengym-selfhosted.apk.sha256',
  }))
  state.fetchChecksum = vi.fn(() => Promise.resolve('c'.repeat(64)))
  state.downloadAndInstall = vi.fn(() => Promise.resolve())
  state.openUnknownSourcesSettings = vi.fn(() => Promise.resolve(true))
  state.resumePendingInstall = vi.fn(() => Promise.resolve())
  state.confirmSheet = vi.fn()
  return state
})
vi.mock('../store/useStore.js', () => {
  const useStore = selector => selector ? selector(mocks.snapshot()) : mocks.snapshot()
  useStore.getState = mocks.snapshot
  return { useStore, DEF: { reminder: { time: '17:30' } }, hasData: () => false }
})
vi.mock('../store/useUI.js', () => {
  const snap = () => ({ toast: mocks.toast, openSheet: mocks.openSheet })
  const useUI = selector => selector ? selector(snap()) : snap()
  useUI.getState = snap
  return { useUI }
})
vi.mock('react-router-dom', () => ({ useNavigate: () => () => {} }))
vi.mock('../lib/api.js', () => ({
  api: vi.fn(), webauthnOK: () => false, passkeyLogin: vi.fn(), passkeyRegister: vi.fn(), IS_ANDROID: false,
}))
vi.mock('../lib/push.js', () => ({ pushSupported: () => false, enablePush: vi.fn(), disablePush: vi.fn(), sendTestPush: vi.fn() }))
vi.mock('../lib/wakelock.js', () => ({ wakeLockSupported: () => false }))
// MOBILE is read at render time through a getter so one module mock serves both builds.
vi.mock('../lib/mobile.js', () => ({
  get MOBILE() { return mocks.MOBILE },
  isAndroid: () => Promise.resolve(mocks.android),
  shareExport: vi.fn(), syncReminder: vi.fn(),
}))
vi.mock('../lib/update.js', () => {
  class UpdateError extends Error {
    constructor(code, message) {
      super(message)
      this.name = 'UpdateError'
      this.code = code
    }
  }
  return {
    get AUTOMATIC_UPDATES() { return mocks.automaticUpdates },
    RELEASES_PAGE: 'https://github.com/solhren/openGym/releases',
    UpdateError,
    checkForUpdate: (...a) => mocks.checkForUpdate(...a),
    fetchChecksum: (...a) => mocks.fetchChecksum(...a),
    downloadAndInstall: (...a) => mocks.downloadAndInstall(...a),
    openUnknownSourcesSettings: (...a) => mocks.openUnknownSourcesSettings(...a),
    resumePendingInstall: (...a) => mocks.resumePendingInstall(...a),
    shouldAutoCheckUpdate: () => true,
    markAutoChecked: vi.fn(),
    isVersionDismissed: () => false,
    dismissVersion: vi.fn(),
  }
})
vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(async (event, cb) => {
      const entry = { event, cb, remove: vi.fn() }
      mocks.appListeners.push(entry)
      return entry
    }),
  },
}))
vi.mock('./MobileOnboarding.jsx', () => ({ ConnectSheet: () => null }))
vi.mock('../sheets.jsx', () => ({
  starterPlanSheet: vi.fn(), confirmSheet: (...a) => mocks.confirmSheet(...a), importFromApp: vi.fn(),
  importFromHevy: vi.fn(), equipmentProfileSheet: vi.fn(), menuSheet: vi.fn(),
}))

import { UpdateError } from '../lib/update.js'
import { resetPendingResumeListener } from '../components/UpdatePrompt.jsx'

globalThis.__APP_VERSION__ ??= 'test'

let host, root
let online = true
beforeEach(() => {
  mocks.S = {
    unit: 'kg', restSec: 90, restPauseSec: 15, sound: false, effort: 'none',
    gifSize: 'full', workouts: [], routines: [], exWeights: {},
  }
  mocks.MOBILE = false
  mocks.android = false
  mocks.automaticUpdates = true
  mocks.appListeners.length = 0
  online = true
  Object.defineProperty(navigator, 'onLine', {
    configurable: true,
    get: () => online,
  })
  resetPendingResumeListener()
  mocks.checkForUpdate.mockClear()
  mocks.fetchChecksum.mockClear()
  mocks.downloadAndInstall.mockClear()
  mocks.openUnknownSourcesSettings.mockClear()
  mocks.resumePendingInstall.mockClear()
  mocks.confirmSheet.mockClear()
  mocks.toast.mockClear()
  mocks.openSheet.mockClear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  resetPendingResumeListener()
  act(() => root.unmount())
  host.remove()
})

// The effect resolves two promises (isAndroid, then checkForUpdate) before the row can render.
const mount = async () => {
  await act(async () => { root.render(<Settings page="about" />) })
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}
const updateRow = () => [...host.querySelectorAll('.lrow')].find(r => r.textContent.includes('Update to openGym v9.9.9'))
const checkRow = () => [...host.querySelectorAll('.lrow')].find(r => r.textContent.includes('Check for updates'))
const webRow = () => [...host.querySelectorAll('.lrow')].find(r => r.textContent.includes('Get the Android app'))

describe('Settings — in-app update check', () => {
  it('web build: never asks for releases; the Updates section points at the APK instead', async () => {
    await mount()
    expect(mocks.checkForUpdate).not.toHaveBeenCalled()
    expect(updateRow()).toBeUndefined()
    expect(checkRow()).toBeUndefined()
    expect(webRow()).toBeTruthy()
  })

  it('mobile build on iOS: no check, no row, no section', async () => {
    mocks.MOBILE = true
    await mount()
    expect(mocks.checkForUpdate).not.toHaveBeenCalled()
    expect(updateRow()).toBeUndefined()
    expect(checkRow()).toBeUndefined()
    expect(webRow()).toBeUndefined()
  })

  it('Android with VITE_UPDATE_DISABLED=1: hides the updater row and makes no GitHub check', async () => {
    mocks.MOBILE = true
    mocks.android = true
    mocks.automaticUpdates = false
    await mount()
    expect(mocks.checkForUpdate).not.toHaveBeenCalled()
    expect(updateRow()).toBeUndefined()
    expect(checkRow()).toBeUndefined()
    expect(webRow()).toBeUndefined()
  })

  it('generic & standard Android builds: checks once, shows the row, and downloads + verifies on confirm', async () => {
    mocks.MOBILE = true
    mocks.android = true
    await mount()
    expect(mocks.checkForUpdate).toHaveBeenCalledTimes(1)
    expect(updateRow()).toBeTruthy()
    act(() => { updateRow().click() })
    expect(mocks.confirmSheet).toHaveBeenCalledTimes(1)
    expect(mocks.confirmSheet.mock.calls[0][0].title).toBe('Update to 9.9.9?')

    await act(async () => {
      await mocks.confirmSheet.mock.calls[0][0].onConfirm()
    })
    expect(mocks.fetchChecksum).toHaveBeenCalledWith('https://x/opengym-selfhosted.apk.sha256')
    expect(mocks.downloadAndInstall).toHaveBeenCalledWith(
      'https://x/opengym-selfhosted.apk',
      'c'.repeat(64),
      expect.any(Function),
    )
  })

  it('Android without a newer release: a "Check for updates" row stays, and tapping it checks again', async () => {
    mocks.MOBILE = true
    mocks.android = true
    mocks.checkForUpdate.mockResolvedValueOnce({ hasUpdate: false, latestVersion: 'test', apkUrl: null, hashUrl: null })
    await mount()
    expect(mocks.checkForUpdate).toHaveBeenCalledTimes(1)
    expect(updateRow()).toBeUndefined()
    expect(checkRow()).toBeTruthy()
    await act(async () => { checkRow().click(); await Promise.resolve() })
    expect(mocks.checkForUpdate).toHaveBeenCalledTimes(2)
    await act(async () => { await Promise.resolve() })
    expect(updateRow()).toBeTruthy()   // the second (default) answer had 9.9.9 — the row now offers it
  })

  it('Android when GitHub is unreachable: stays quiet on mount, shows offline toast on manual check, and retry sheet on offline download', async () => {
    mocks.MOBILE = true
    mocks.android = true
    mocks.checkForUpdate.mockRejectedValueOnce(new UpdateError('offline', 'offline'))
    await mount()
    expect(updateRow()).toBeUndefined()
    expect(checkRow()).toBeTruthy()
    expect(mocks.toast).not.toHaveBeenCalled()

    // Manual tap while offline shows feedback toast
    mocks.checkForUpdate.mockRejectedValueOnce(new UpdateError('offline', 'offline'))
    await act(async () => { checkRow().click(); await Promise.resolve() })
    expect(mocks.toast).toHaveBeenCalledWith('Couldn’t check for updates. Are you online?')

    // Once update is known, starting download while offline offers Retry download sheet
    await act(async () => { checkRow().click(); await Promise.resolve() })
    await act(async () => { await Promise.resolve() })
    expect(updateRow()).toBeTruthy()
    online = false
    act(() => { updateRow().click() })
    await act(async () => { await mocks.confirmSheet.mock.calls[0][0].onConfirm() })
    expect(mocks.confirmSheet).toHaveBeenLastCalledWith(expect.objectContaining({
      title: 'You appear to be offline',
      confirmText: 'Retry download',
    }))
  })

  it('interrupted download: offers Retry download sheet and succeeds on retry', async () => {
    mocks.MOBILE = true
    mocks.android = true
    await mount()
    act(() => { updateRow().click() })

    mocks.downloadAndInstall
      .mockRejectedValueOnce(new UpdateError('download-interrupted', 'Network dropped'))
      .mockResolvedValueOnce()

    await act(async () => { await mocks.confirmSheet.mock.calls[0][0].onConfirm() })
    expect(mocks.confirmSheet).toHaveBeenCalledTimes(2)
    expect(mocks.confirmSheet.mock.calls[1][0]).toMatchObject({
      title: 'Download interrupted',
      confirmText: 'Retry download',
    })

    await act(async () => { await mocks.confirmSheet.mock.calls[1][0].onConfirm() })
    expect(mocks.downloadAndInstall).toHaveBeenCalledTimes(2)
  })

  it('unknown-sources permission denied: guides user to Android settings and resumes cached APK on return', async () => {
    mocks.MOBILE = true
    mocks.android = true
    await mount()
    act(() => { updateRow().click() })

    mocks.downloadAndInstall.mockRejectedValueOnce(
      new UpdateError('unknown-sources-denied', 'Unknown app installation permission is required'),
    )

    await act(async () => { await mocks.confirmSheet.mock.calls[0][0].onConfirm() })
    expect(mocks.confirmSheet).toHaveBeenCalledTimes(2)
    expect(mocks.confirmSheet.mock.calls[1][0]).toMatchObject({
      title: 'Allow app installations',
      confirmText: 'Open Android settings',
    })

    // User opens Android settings and returns to openGym
    await act(async () => { await mocks.confirmSheet.mock.calls[1][0].onConfirm() })
    expect(mocks.openUnknownSourcesSettings).toHaveBeenCalledTimes(1)
    expect(mocks.appListeners).toHaveLength(1)

    await act(async () => { await mocks.appListeners[0].cb({ isActive: true }) })
    expect(mocks.resumePendingInstall).toHaveBeenCalledWith('c'.repeat(64))
    expect(mocks.downloadAndInstall).toHaveBeenCalledTimes(1)
  })
})
