// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  MOBILE: true,
  android: true,
  automaticUpdates: true,
  shouldAutoCheck: true,
  dismissed: new Set(),
  checkForUpdate: vi.fn(),
  fetchChecksum: vi.fn(),
  downloadAndInstall: vi.fn(),
  openUnknownSourcesSettings: vi.fn(),
  resumePendingInstall: vi.fn(),
  markAutoChecked: vi.fn(),
  toast: vi.fn(),
  openSheet: vi.fn(),
  confirmSheet: vi.fn(),
  appListeners: [],
}))

vi.mock('../lib/mobile.js', () => ({
  get MOBILE() { return mocks.MOBILE },
  isAndroid: () => Promise.resolve(mocks.android),
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
    shouldAutoCheckUpdate: () => mocks.shouldAutoCheck,
    markAutoChecked: (...a) => mocks.markAutoChecked(...a),
    isVersionDismissed: v => mocks.dismissed.has(v),
    dismissVersion: v => mocks.dismissed.add(v),
  }
})

vi.mock('../store/useUI.js', () => {
  const snap = () => ({ toast: mocks.toast, openSheet: mocks.openSheet })
  const useUI = selector => (selector ? selector(snap()) : snap())
  useUI.getState = snap
  return { useUI }
})

vi.mock('../sheets.jsx', () => ({
  confirmSheet: (...a) => mocks.confirmSheet(...a),
}))

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(async (event, cb) => {
      const entry = { event, cb, remove: vi.fn() }
      mocks.appListeners.push(entry)
      return entry
    }),
  },
}))

import UpdatePrompt, { resetPendingResumeListener, runInteractiveUpdate } from './UpdatePrompt.jsx'
import { UpdateError } from '../lib/update.js'

const VALID_HASH = 'b'.repeat(64)

describe('UpdatePrompt & runInteractiveUpdate', () => {
  let host, root
  let online = true

  beforeEach(() => {
    mocks.MOBILE = true
    mocks.android = true
    mocks.automaticUpdates = true
    mocks.shouldAutoCheck = true
    mocks.dismissed.clear()
    mocks.appListeners.length = 0
    online = true
    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      get: () => online,
    })
    resetPendingResumeListener()
    vi.clearAllMocks()

    mocks.openSheet.mockImplementation(render => {
      const close = vi.fn()
      render(close)
      return close
    })
    mocks.checkForUpdate.mockResolvedValue({
      hasUpdate: true,
      latestVersion: '1.5.0',
      apkUrl: 'https://x/opengym-selfhosted.apk',
      hashUrl: 'https://x/opengym-selfhosted.apk.sha256',
    })
    mocks.fetchChecksum.mockResolvedValue(VALID_HASH)
    mocks.downloadAndInstall.mockResolvedValue()
    mocks.openUnknownSourcesSettings.mockResolvedValue(true)
    mocks.resumePendingInstall.mockResolvedValue()

    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    resetPendingResumeListener()
    act(() => root.unmount())
    host.remove()
  })

  const flush = async () => {
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  it('does not check or render on web, iOS, or while onboarding/workout is active', async () => {
    mocks.MOBILE = false
    await act(async () => { root.render(<UpdatePrompt active />) })
    await flush()
    expect(mocks.checkForUpdate).not.toHaveBeenCalled()
    expect(host.textContent).toBe('')

    mocks.MOBILE = true
    mocks.android = false
    await act(async () => { root.render(<UpdatePrompt active />) })
    await flush()
    expect(mocks.checkForUpdate).not.toHaveBeenCalled()

    mocks.android = true
    await act(async () => { root.render(<UpdatePrompt active={false} />) })
    await flush()
    expect(mocks.checkForUpdate).not.toHaveBeenCalled()
  })

  it('stays completely silent at launch if offline or GitHub fails', async () => {
    mocks.checkForUpdate.mockRejectedValueOnce(new UpdateError('offline', 'Device is offline'))
    await act(async () => { root.render(<UpdatePrompt active />) })
    await flush()

    expect(mocks.toast).not.toHaveBeenCalled()
    expect(mocks.confirmSheet).not.toHaveBeenCalled()
    expect(host.textContent).toBe('')
  })

  it('prompts when an update is available at launch and supports Later dismissal', async () => {
    await act(async () => { root.render(<UpdatePrompt active />) })
    await flush()

    expect(host.textContent).toContain('openGym v1.5.0 is available')
    const laterBtn = [...host.querySelectorAll('button')].find(b => b.textContent === 'Later')
    expect(laterBtn).toBeTruthy()

    act(() => { laterBtn.click() })
    expect(mocks.dismissed.has('1.5.0')).toBe(true)
    expect(host.textContent).toBe('')
  })

  it('triggers download & install when tapping Download & Install on the launch prompt', async () => {
    await act(async () => { root.render(<UpdatePrompt active />) })
    await flush()

    const installBtn = [...host.querySelectorAll('button')].find(b => b.textContent === 'Download & Install')
    await act(async () => { installBtn.click() })
    await flush()

    expect(mocks.fetchChecksum).toHaveBeenCalledWith('https://x/opengym-selfhosted.apk.sha256')
    expect(mocks.downloadAndInstall).toHaveBeenCalledWith(
      'https://x/opengym-selfhosted.apk',
      VALID_HASH,
      expect.any(Function),
    )
  })

  it('shows Retry download sheet when offline or interrupted mid-download, and retries cleanly', async () => {
    const info = {
      hasUpdate: true,
      latestVersion: '1.5.0',
      apkUrl: 'https://x/opengym-selfhosted.apk',
      hashUrl: 'https://x/opengym-selfhosted.apk.sha256',
    }

    online = false
    const resOffline = await runInteractiveUpdate(info)
    expect(resOffline.status).toBe('offline')
    expect(mocks.confirmSheet).toHaveBeenCalledWith(expect.objectContaining({
      title: 'You appear to be offline',
      confirmText: 'Retry download',
    }))

    online = true
    mocks.confirmSheet.mockClear()
    mocks.downloadAndInstall
      .mockRejectedValueOnce(new UpdateError('download-interrupted', 'Socket closed'))
      .mockResolvedValueOnce()

    const resInterrupted = await runInteractiveUpdate(info)
    expect(resInterrupted.status).toBe('download-interrupted')
    expect(mocks.confirmSheet).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Download interrupted',
      confirmText: 'Retry download',
    }))

    // Trigger retry from the sheet
    await mocks.confirmSheet.mock.calls[0][0].onConfirm()
    expect(mocks.downloadAndInstall).toHaveBeenCalledTimes(2)
  })

  it('recovers from unknown-sources-denied by opening Android settings and auto-resuming cached APK on app return', async () => {
    const info = {
      hasUpdate: true,
      latestVersion: '1.5.0',
      apkUrl: 'https://x/opengym-selfhosted.apk',
      hashUrl: 'https://x/opengym-selfhosted.apk.sha256',
    }

    mocks.downloadAndInstall.mockRejectedValueOnce(
      new UpdateError('unknown-sources-denied', 'Unknown app installation permission is required'),
    )

    const res = await runInteractiveUpdate(info)
    expect(res.status).toBe('unknown-sources-denied')
    expect(mocks.confirmSheet).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Allow app installations',
      confirmText: 'Open Android settings',
    }))

    // User taps "Open Android settings"
    await mocks.confirmSheet.mock.calls[0][0].onConfirm()
    expect(mocks.openUnknownSourcesSettings).toHaveBeenCalledTimes(1)
    expect(mocks.appListeners).toHaveLength(1)
    expect(mocks.appListeners[0].event).toBe('appStateChange')

    // Simulate returning to openGym after enabling permission in Android settings
    await mocks.appListeners[0].cb({ isActive: true })
    expect(mocks.appListeners[0].remove).toHaveBeenCalledTimes(1)
    expect(mocks.resumePendingInstall).toHaveBeenCalledWith(VALID_HASH)
    // Must NOT re-download the 300 MB APK!
    expect(mocks.downloadAndInstall).toHaveBeenCalledTimes(1)
  })
})
