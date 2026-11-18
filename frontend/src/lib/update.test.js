// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  MOBILE: false,
  PUBLIC_ANDROID: false,
  fsDownloadFile: vi.fn(),
  fsReadFile: vi.fn(),
  fsDeleteFile: vi.fn(),
  fsAddListener: vi.fn(),
  installCanInstall: vi.fn(),
  installOpenSettings: vi.fn(),
  installHasCachedApk: vi.fn(),
  installApk: vi.fn(),
}))

vi.mock('./mobile.js', () => ({
  get MOBILE() { return mocks.MOBILE },
}))

vi.mock('./public-android.js', () => ({
  get PUBLIC_ANDROID() { return mocks.PUBLIC_ANDROID },
}))

vi.mock('@capacitor/filesystem', () => ({
  Directory: { Cache: 'CACHE' },
  Encoding: { UTF8: 'utf8' },
  Filesystem: {
    downloadFile: (...a) => mocks.fsDownloadFile(...a),
    readFile: (...a) => mocks.fsReadFile(...a),
    deleteFile: (...a) => mocks.fsDeleteFile(...a),
    addListener: (...a) => mocks.fsAddListener(...a),
  },
}))

vi.mock('@capacitor/core', () => ({
  registerPlugin: () => ({
    canInstall: (...a) => mocks.installCanInstall(...a),
    openInstallSettings: (...a) => mocks.installOpenSettings(...a),
    hasCachedApk: (...a) => mocks.installHasCachedApk(...a),
    installApk: (...a) => mocks.installApk(...a),
  }),
}))

import {
  AUTOMATIC_UPDATES,
  AUTO_CHECK_INTERVAL_MS,
  RELEASES_PAGE,
  UPDATE_REPO,
  UpdateError,
  canInstallPackages,
  checkForUpdate,
  compareSemver,
  dismissVersion,
  downloadAndInstall,
  extractReleaseSemver,
  fetchChecksum,
  isVersionDismissed,
  markAutoChecked,
  openUnknownSourcesSettings,
  parseSemver,
  resetUpdateCheck,
  resumePendingInstall,
  sha256,
  shouldAutoCheckUpdate,
} from './update.js'

const VALID_HASH = 'a'.repeat(64)

describe('lib/update.js', () => {
  const origVersion = globalThis.__APP_VERSION__
  const origFetch = globalThis.fetch
  let online = true

  beforeEach(() => {
    globalThis.__APP_VERSION__ = '1.4.1'
    mocks.MOBILE = true
    mocks.PUBLIC_ANDROID = true
    online = true
    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      get: () => online,
    })
    resetUpdateCheck()
    localStorage.clear()
    vi.clearAllMocks()
    mocks.installHasCachedApk.mockResolvedValue({ cached: false })
    mocks.installApk.mockResolvedValue({})
    mocks.installCanInstall.mockResolvedValue({ granted: true })
    mocks.installOpenSettings.mockResolvedValue({ opened: true })
    mocks.fsDownloadFile.mockResolvedValue({})
    mocks.fsDeleteFile.mockResolvedValue({})
    mocks.fsAddListener.mockResolvedValue({ remove: vi.fn() })
  })

  afterEach(() => {
    globalThis.__APP_VERSION__ = origVersion
    globalThis.fetch = origFetch
  })

  describe('configuration defaults', () => {
    it('enables automatic updates on generic PUBLIC_ANDROID builds and targets solhren/openGym', () => {
      expect(AUTOMATIC_UPDATES).toBe(true)
      expect(UPDATE_REPO).toBe('solhren/openGym')
      expect(RELEASES_PAGE).toBe('https://github.com/solhren/openGym/releases')
    })
  })

  describe('SemVer parsing, tag extraction & comparison', () => {
    it('extracts 3-part SemVer cleanly across standard and self-hosted tags', () => {
      expect(extractReleaseSemver('v1.4.2')).toBe('1.4.2')
      expect(extractReleaseSemver('1.4.2')).toBe('1.4.2')
      expect(extractReleaseSemver('android-selfhosted-v1.4.2')).toBe('1.4.2')
      expect(extractReleaseSemver('selfhosted-v1.4.2')).toBe('1.4.2')
      expect(extractReleaseSemver('android-selfhosted-v1.4.2-b27')).toBe('1.4.2')
      expect(extractReleaseSemver('1.4.2+selfhosted-123')).toBe('1.4.2')
      expect(extractReleaseSemver('v1.4.2-beta.1')).toBe('1.4.2-beta.1')
    })

    it('rejects legacy non-SemVer tags so they never trigger false updates', () => {
      expect(extractReleaseSemver('android-selfhosted-v1')).toBeNull()
      expect(extractReleaseSemver('android-personal-beta')).toBeNull()
      expect(extractReleaseSemver('v1.4')).toBeNull()
      expect(extractReleaseSemver('')).toBeNull()
      expect(extractReleaseSemver(null)).toBeNull()
    })

    it('compares releases, build suffixes, and prereleases accurately', () => {
      expect(compareSemver('1.4.2', '1.4.1')).toBe(1)
      expect(compareSemver('1.4.1', '1.4.2')).toBe(-1)
      expect(compareSemver('1.4.2', '1.4.2-beta.1')).toBe(1)
      expect(compareSemver('1.4.2-beta.1', '1.4.1')).toBe(1)
      expect(compareSemver('1.4.2-beta.10', '1.4.2-beta.2')).toBe(1)
      expect(compareSemver('1.4.2+2026-09-18.2', '1.4.2')).toBe(0)
      expect(compareSemver('android-selfhosted-v1.4.2-b27', '1.4.2')).toBe(0)
      expect(compareSemver('android-selfhosted-v1.4.2-b27', '1.4.1')).toBe(1)
      expect(parseSemver('android-selfhosted-v1.4.2-b27')?.buildNumber).toBe(27)
    })
  })

  describe('checkForUpdate — channel-aware GitHub lookup', () => {
    it('PUBLIC_ANDROID: picks highest valid SemVer release with selfhosted APK and ignores legacy tags', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => [
          {
            tag_name: 'android-selfhosted-v1',
            draft: false,
            assets: [{ name: 'opengym-selfhosted.apk', browser_download_url: 'https://x/legacy.apk' }],
          },
          {
            tag_name: 'android-personal-beta',
            draft: false,
            assets: [{ name: 'opengym-personal.apk', browser_download_url: 'https://x/personal.apk' }],
          },
          {
            tag_name: 'v1.9.0',
            draft: false,
            assets: [{ name: 'opengym.apk', browser_download_url: 'https://x/standard.apk' }],
          },
          {
            tag_name: 'android-selfhosted-v1.4.2-b27',
            draft: false,
            assets: [
              { name: 'opengym-selfhosted.apk', browser_download_url: 'https://x/sh-b27.apk' },
              { name: 'opengym-selfhosted.apk.sha256', browser_download_url: 'https://x/sh-b27.apk.sha256' },
            ],
          },
          {
            tag_name: 'android-selfhosted-v1.4.2-b29',
            draft: false,
            assets: [
              { name: 'opengym-selfhosted.apk', browser_download_url: 'https://x/sh-b29.apk' },
              { name: 'opengym-selfhosted.apk.sha256', browser_download_url: 'https://x/sh-b29.apk.sha256' },
            ],
          },
        ],
      })

      const info = await checkForUpdate()
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://api.github.com/repos/solhren/openGym/releases?per_page=15',
        expect.any(Object),
      )
      expect(info).toEqual({
        hasUpdate: true,
        latestVersion: '1.4.2',
        apkUrl: 'https://x/sh-b29.apk',
        hashUrl: 'https://x/sh-b29.apk.sha256',
      })
    })

    it('PUBLIC_ANDROID: reports hasUpdate=false when already running the latest version', async () => {
      globalThis.__APP_VERSION__ = '1.4.2'
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => [
          {
            tag_name: 'android-selfhosted-v1.4.2-b29',
            draft: false,
            assets: [
              { name: 'opengym-selfhosted.apk', browser_download_url: 'https://x/sh-b29.apk' },
              { name: 'opengym-selfhosted.apk.sha256', browser_download_url: 'https://x/sh-b29.apk.sha256' },
            ],
          },
        ],
      })

      const info = await checkForUpdate()
      expect(info.hasUpdate).toBe(false)
      expect(info.latestVersion).toBe('1.4.2')
    })

    it('standard Android (PUBLIC_ANDROID=false): queries releases/latest and prefers standard APK', async () => {
      mocks.PUBLIC_ANDROID = false
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          tag_name: 'v1.5.0',
          assets: [
            { name: 'opengym-selfhosted.apk', browser_download_url: 'https://x/sh.apk' },
            { name: 'opengym-selfhosted.apk.sha256', browser_download_url: 'https://x/sh.apk.sha256' },
            { name: 'opengym.apk', browser_download_url: 'https://x/std.apk' },
            { name: 'opengym.apk.sha256', browser_download_url: 'https://x/std.apk.sha256' },
          ],
        }),
      })

      const info = await checkForUpdate()
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://api.github.com/repos/solhren/openGym/releases/latest',
        expect.any(Object),
      )
      expect(info).toEqual({
        hasUpdate: true,
        latestVersion: '1.5.0',
        apkUrl: 'https://x/std.apk',
        hashUrl: 'https://x/std.apk.sha256',
      })
    })

    it('classifies offline, rate-limited, and HTTP errors with UpdateError codes and supports force refresh', async () => {
      online = false
      await expect(checkForUpdate()).rejects.toMatchObject({ name: 'UpdateError', code: 'offline' })

      online = true
      globalThis.fetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 403 })
      await expect(checkForUpdate()).rejects.toMatchObject({ name: 'UpdateError', code: 'rate-limited' })

      globalThis.fetch = vi.fn()
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => [] })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => [{
            tag_name: 'android-selfhosted-v1.5.0',
            draft: false,
            assets: [{ name: 'opengym-selfhosted.apk', browser_download_url: 'https://x/150.apk' }],
          }],
        })
      const first = await checkForUpdate()
      expect(first.hasUpdate).toBe(false)
      const cachedSecond = await checkForUpdate()
      expect(cachedSecond.hasUpdate).toBe(false)
      expect(globalThis.fetch).toHaveBeenCalledTimes(1)

      const forced = await checkForUpdate({ force: true })
      expect(forced.hasUpdate).toBe(true)
      expect(forced.latestVersion).toBe('1.5.0')
      expect(globalThis.fetch).toHaveBeenCalledTimes(2)
    })
  })

  describe('fetchChecksum & sha256', () => {
    it('parses SHA-256 checksum with trailing filename on mobile and computes WebCrypto sha256', async () => {
      mocks.fsReadFile.mockResolvedValue({ data: `${VALID_HASH.toUpperCase()}  opengym-selfhosted.apk\n` })
      const hex = await fetchChecksum('https://x/sh.apk.sha256')
      expect(hex).toBe(VALID_HASH)

      const buf = new TextEncoder().encode('openGym').buffer
      const digest = await sha256(buf)
      expect(digest).toMatch(/^[0-9a-f]{64}$/)
    })

    it('cleans up partial checksum file and throws UpdateError when interrupted', async () => {
      mocks.fsDownloadFile.mockRejectedValueOnce(new Error('socket reset'))
      await expect(fetchChecksum('https://x/sh.apk.sha256')).rejects.toMatchObject({
        name: 'UpdateError',
        code: 'download-interrupted',
      })
      expect(mocks.fsDeleteFile).toHaveBeenCalledWith({ path: 'opengym-update.apk.sha256', directory: 'CACHE' })
    })
  })

  describe('downloadAndInstall & unknown-sources recovery', () => {
    it('rejects missing or invalid checksums with checksum-missing', async () => {
      await expect(downloadAndInstall('https://x/app.apk', '')).rejects.toMatchObject({
        code: 'checksum-missing',
      })
      expect(mocks.fsDownloadFile).not.toHaveBeenCalled()
    })

    it('cleans up partial APK when download drops mid-stream and throws download-interrupted', async () => {
      const removeListener = vi.fn()
      mocks.fsAddListener.mockResolvedValueOnce({ remove: removeListener })
      mocks.fsDownloadFile.mockRejectedValueOnce(new Error('Connection closed prematurely'))

      await expect(downloadAndInstall('https://x/app.apk', VALID_HASH, () => {})).rejects.toMatchObject({
        name: 'UpdateError',
        code: 'download-interrupted',
      })

      // Deleted once before starting + once in catch cleanup
      expect(mocks.fsDeleteFile).toHaveBeenCalledTimes(2)
      expect(removeListener).toHaveBeenCalledTimes(1)
      expect(mocks.installApk).not.toHaveBeenCalled()
    })

    it('maps ERR_UNKNOWN_SOURCES to unknown-sources-denied and resumes cached APK without re-downloading', async () => {
      const pluginErr = Object.assign(new Error('Unknown app installation permission is required'), {
        code: 'ERR_UNKNOWN_SOURCES',
      })
      mocks.installApk.mockRejectedValueOnce(pluginErr)

      await expect(downloadAndInstall('https://x/app.apk', VALID_HASH)).rejects.toMatchObject({
        name: 'UpdateError',
        code: 'unknown-sources-denied',
      })
      expect(mocks.fsDownloadFile).toHaveBeenCalledTimes(1)
      // Must NOT delete the verified 300 MB APK after download succeeded!
      expect(mocks.fsDeleteFile).toHaveBeenCalledTimes(1)

      // Returning from Android settings: resumePendingInstall installs directly from cache
      mocks.installApk.mockResolvedValueOnce({})
      await resumePendingInstall(VALID_HASH)
      expect(mocks.fsDownloadFile).toHaveBeenCalledTimes(1)
      expect(mocks.installApk).toHaveBeenLastCalledWith({
        fileName: 'opengym-update.apk',
        sha256: VALID_HASH,
      })

      // Also if downloadAndInstall is called again while hasCachedApk is true, skips downloadFile!
      mocks.installHasCachedApk.mockResolvedValueOnce({ cached: true })
      await downloadAndInstall('https://x/app.apk', VALID_HASH)
      expect(mocks.fsDownloadFile).toHaveBeenCalledTimes(1)
    })

    it('wraps canInstallPackages and openUnknownSourcesSettings', async () => {
      mocks.installCanInstall.mockResolvedValueOnce({ granted: false })
      expect(await canInstallPackages()).toBe(false)
      expect(await openUnknownSourcesSettings()).toBe(true)
      expect(mocks.installOpenSettings).toHaveBeenCalledTimes(1)
    })
  })

  describe('launch auto-check throttling & version dismissal', () => {
    it('throttles auto-check within 6h window and allows after window expires', () => {
      const t0 = 1_700_000_000_000
      expect(shouldAutoCheckUpdate(t0)).toBe(true)
      markAutoChecked(t0)
      expect(shouldAutoCheckUpdate(t0 + 60_000)).toBe(false)
      expect(shouldAutoCheckUpdate(t0 + AUTO_CHECK_INTERVAL_MS)).toBe(true)
    })

    it('remembers dismissed version per release and re-prompts on newer version', () => {
      expect(isVersionDismissed('1.4.2')).toBe(false)
      dismissVersion('android-selfhosted-v1.4.2-b27')
      expect(isVersionDismissed('1.4.2')).toBe(true)
      expect(isVersionDismissed('v1.4.2')).toBe(true)
      expect(isVersionDismissed('1.4.3')).toBe(false)
    })
  })
})
