// Update check — compares the installed version (__APP_VERSION__) against
// the latest release on GitHub and optionally downloads + installs the APK.
//
// Supports both standard Android builds (`releases/latest`) and generic self-hosted
// Android builds (`PUBLIC_ANDROID === true`, scanning recent releases for a valid
// 3-part SemVer release carrying a `selfhosted*.apk` asset).
//
// On Android (Capacitor) the APK is downloaded natively into the cache directory (~300 MB never
// enters WebView memory), verified by streaming SHA-256 in the native Install plugin, and handed
// to the Android package installer.

import { MOBILE } from './mobile.js'
import { PUBLIC_ANDROID } from './public-android.js'

export const AUTOMATIC_UPDATES = import.meta.env?.VITE_UPDATE_DISABLED !== '1'
export const UPDATE_REPO = import.meta.env?.VITE_UPDATE_REPO || 'solhren/openGym'
export const RELEASES_PAGE = `https://github.com/${UPDATE_REPO}/releases`

const LATEST_URL = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`
const RELEASES_LIST_URL = `https://api.github.com/repos/${UPDATE_REPO}/releases?per_page=15`

const APK_CACHE_FILE = 'opengym-update.apk'
const HASH_CACHE_FILE = 'opengym-update.apk.sha256'

export const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const STORAGE_CHECK_TS = 'opengym_update_check_ts'
const STORAGE_DISMISSED = 'opengym_update_dismissed'

export class UpdateError extends Error {
  constructor(code, message, options) {
    super(message, options)
    this.name = 'UpdateError'
    this.code = code
  }
}

function isOfflineNow() {
  return typeof navigator !== 'undefined' && navigator.onLine === false
}

/**
 * Parses a SemVer string or release tag into its components.
 * Strips channel prefixes (`v`, `selfhosted-v`, `android-selfhosted-v`), ignores `+build`
 * metadata, and treats `-b<N>` / `-build.<N>` CI versionCode suffixes as build metadata rather
 * than pre-release identifiers so `android-selfhosted-v1.4.2-b27` resolves cleanly to `1.4.2`.
 * Returns `null` if the input does not contain a valid `MAJOR.MINOR.PATCH` version.
 */
export function parseSemver(raw) {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  const stripped = trimmed.replace(/^(?:(?:android-)?selfhosted-)?v?(?=\d)/i, '')
  const plusIdx = stripped.indexOf('+')
  const coreAndPre = plusIdx >= 0 ? stripped.slice(0, plusIdx) : stripped
  const build = plusIdx >= 0 ? stripped.slice(plusIdx + 1) : ''
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(coreAndPre)
  if (!m) return null
  const major = Number(m[1])
  const minor = Number(m[2])
  const patch = Number(m[3])
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) return null

  let prerelease = []
  let buildNumber = null
  if (m[4]) {
    const bm = /^(?:b|build[.-]?)(\d+)$/i.exec(m[4])
    if (bm) {
      buildNumber = Number(bm[1])
    } else {
      prerelease = m[4].split('.').filter(Boolean)
    }
  }

  const version = prerelease.length
    ? `${major}.${minor}.${patch}-${prerelease.join('.')}`
    : `${major}.${minor}.${patch}`
  return { major, minor, patch, prerelease, build, buildNumber, version }
}

/**
 * Extracts a normalized SemVer string (`MAJOR.MINOR.PATCH` or `MAJOR.MINOR.PATCH-prerelease`)
 * from a GitHub release tag. Returns `null` for non-SemVer legacy tags like
 * `android-selfhosted-v1` or `android-personal-beta`.
 */
export function extractReleaseSemver(tag) {
  const parsed = parseSemver(tag)
  return parsed ? parsed.version : null
}

/**
 * Compares two SemVer strings (e.g. "1.4.2" vs "1.4.2-beta.1" vs "1.4.1").
 * Returns 1 if a > b, -1 if a < b, 0 if equal.
 * Build metadata (`+...` or `-b27`) plays no part in SemVer precedence.
 */
export function compareSemver(a, b) {
  const pa = typeof a === 'object' && a !== null ? a : parseSemver(String(a ?? ''))
  const pb = typeof b === 'object' && b !== null ? b : parseSemver(String(b ?? ''))
  if (!pa && !pb) return 0
  if (pa && !pb) return 1
  if (!pa && pb) return -1

  if (pa.major !== pb.major) return pa.major > pb.major ? 1 : -1
  if (pa.minor !== pb.minor) return pa.minor > pb.minor ? 1 : -1
  if (pa.patch !== pb.patch) return pa.patch > pb.patch ? 1 : -1

  const preA = pa.prerelease || []
  const preB = pb.prerelease || []
  if (preA.length === 0 && preB.length === 0) return 0
  if (preA.length === 0) return 1
  if (preB.length === 0) return -1

  const len = Math.max(preA.length, preB.length)
  for (let i = 0; i < len; i++) {
    if (i >= preA.length) return -1
    if (i >= preB.length) return 1
    const idA = preA[i]
    const idB = preB[i]
    if (idA === idB) continue
    const numA = /^\d+$/.test(idA)
    const numB = /^\d+$/.test(idB)
    if (numA && numB) {
      const diff = Number(idA) - Number(idB)
      if (diff !== 0) return diff > 0 ? 1 : -1
    } else if (numA !== numB) {
      return numA ? -1 : 1
    } else {
      return idA < idB ? -1 : 1
    }
  }
  return 0
}

function findMatchingHashAsset(assets, apk, preferSelfhosted) {
  if (apk?.name) {
    const exact = `${apk.name}.sha256`.toLowerCase()
    const byExact = assets.find(a => String(a?.name || '').toLowerCase() === exact)
    if (byExact) return byExact
  }
  if (preferSelfhosted) {
    return assets.find(a => /selfhosted.*\.apk\.sha256$/i.test(a?.name || ''))
      || assets.find(a => /\.apk\.sha256$/i.test(a?.name || ''))
      || null
  }
  return assets.find(a => /\.apk\.sha256$/i.test(a?.name || '') && !/selfhosted/i.test(a?.name || ''))
    || assets.find(a => /\.apk\.sha256$/i.test(a?.name || ''))
    || null
}

async function fetchGithubJson(url) {
  if (isOfflineNow()) {
    throw new UpdateError('offline', 'Device is offline')
  }
  let res
  try {
    res = await fetch(url, { headers: { Accept: 'application/vnd.github+json' } })
  } catch (err) {
    throw new UpdateError('offline', err?.message || 'Network request failed', { cause: err })
  }
  if (res.status === 404) return { notFound: true, data: null }
  if (res.status === 403 || res.status === 429) {
    throw new UpdateError('rate-limited', `GitHub API rate limit (${res.status})`)
  }
  if (!res.ok) {
    throw new UpdateError('http-error', `GitHub API ${res.status}`)
  }
  return { notFound: false, data: await res.json() }
}

/**
 * Checks GitHub for a newer version.
 * - On `PUBLIC_ANDROID` (self-hosted generic APK): queries recent releases and selects the
 *   highest valid 3-part SemVer release containing a `selfhosted*.apk` asset.
 * - On standard builds: queries `releases/latest` and selects the standard `.apk` asset.
 *
 * Returns `{ hasUpdate, latestVersion, apkUrl, hashUrl }` or throws `UpdateError`.
 */
let cached = null
export function resetUpdateCheck() { cached = null }

export async function checkForUpdate({ force = false } = {}) {
  if (!AUTOMATIC_UPDATES) return { hasUpdate: false, manualOnly: true, apkUrl: null, hashUrl: null }
  if (force) cached = null
  if (!cached) cached = fetchLatest().catch(e => { cached = null; throw e })
  return cached
}

async function fetchLatest() {
  if (PUBLIC_ANDROID) {
    const { notFound, data } = await fetchGithubJson(RELEASES_LIST_URL)
    if (notFound || !Array.isArray(data)) {
      return { hasUpdate: false, latestVersion: __APP_VERSION__, apkUrl: null, hashUrl: null }
    }
    let best = null
    for (const rel of data) {
      if (!rel || rel.draft) continue
      const parsed = parseSemver(rel.tag_name)
      if (!parsed) continue
      const assets = Array.isArray(rel.assets) ? rel.assets : []
      const apk = assets.find(a => /selfhosted.*\.apk$/i.test(a?.name || ''))
      if (!apk) continue
      const hash = findMatchingHashAsset(assets, apk, true)
      if (!best) {
        best = { parsed, apk, hash }
      } else {
        const cmp = compareSemver(parsed, best.parsed)
        const buildCmp = (parsed.buildNumber ?? -1) - (best.parsed.buildNumber ?? -1)
        if (cmp > 0 || (cmp === 0 && buildCmp > 0)) {
          best = { parsed, apk, hash }
        }
      }
    }
    if (!best) {
      return { hasUpdate: false, latestVersion: __APP_VERSION__, apkUrl: null, hashUrl: null }
    }
    const latestVersion = best.parsed.version
    const hasUpdate = compareSemver(latestVersion, __APP_VERSION__) > 0
    return {
      hasUpdate,
      latestVersion,
      apkUrl: best.apk?.browser_download_url || null,
      hashUrl: best.hash?.browser_download_url || null,
    }
  }

  const { notFound, data: latest } = await fetchGithubJson(LATEST_URL)
  if (notFound || !latest) {
    return { hasUpdate: false, latestVersion: __APP_VERSION__, apkUrl: null, hashUrl: null }
  }
  const latestVersion = extractReleaseSemver(latest.tag_name)
  if (!latestVersion) {
    return { hasUpdate: false, latestVersion: __APP_VERSION__, apkUrl: null, hashUrl: null }
  }
  const hasUpdate = compareSemver(latestVersion, __APP_VERSION__) > 0
  const assets = Array.isArray(latest.assets) ? latest.assets : []
  const apk = assets.find(a => /\.apk$/i.test(a?.name || '') && !/selfhosted/i.test(a?.name || ''))
    || assets.find(a => /\.apk$/i.test(a?.name || ''))
  const hash = findMatchingHashAsset(assets, apk, false)
  return {
    hasUpdate,
    latestVersion,
    apkUrl: apk?.browser_download_url || null,
    hashUrl: hash?.browser_download_url || null,
  }
}

/**
 * Fetches the SHA-256 checksum published next to the APK, returning 64 lowercase hex characters
 * or `null` if unavailable/malformed. Throws `UpdateError` if offline or interrupted mid-transfer.
 */
export async function fetchChecksum(hashUrl) {
  if (!hashUrl) return null
  if (isOfflineNow()) throw new UpdateError('offline', 'Device is offline')
  let text
  if (MOBILE) {
    const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem')
    try {
      await Filesystem.downloadFile({ url: hashUrl, path: HASH_CACHE_FILE, directory: Directory.Cache })
      text = (await Filesystem.readFile({ path: HASH_CACHE_FILE, directory: Directory.Cache, encoding: Encoding.UTF8 })).data
    } catch (err) {
      try { await Filesystem.deleteFile({ path: HASH_CACHE_FILE, directory: Directory.Cache }) } catch { /* ignore */ }
      throw new UpdateError(isOfflineNow() ? 'offline' : 'download-interrupted', err?.message || 'Could not download checksum', { cause: err })
    }
  } else {
    let res
    try {
      res = await fetch(hashUrl)
    } catch (err) {
      throw new UpdateError('offline', err?.message || 'Could not download checksum', { cause: err })
    }
    if (!res.ok) return null
    text = await res.text()
  }
  const hex = String(text).trim().split(/\s/)[0]
  return /^[0-9a-f]{64}$/i.test(hex) ? hex.toLowerCase() : null
}

/**
 * Computes the SHA-256 hash of an ArrayBuffer using the Web Crypto API.
 * Returns the hex-encoded digest string.
 */
export async function sha256(buffer) {
  const hash = await crypto.subtle.digest('SHA-256', buffer)
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('')
}

async function getInstallPlugin() {
  const { registerPlugin } = await import('@capacitor/core')
  return registerPlugin('Install')
}

function mapInstallError(err) {
  if (err instanceof UpdateError) return err
  const code = String(err?.code || '')
  const msg = String(err?.message || err || '')
  if (code === 'ERR_UNKNOWN_SOURCES' || /unknown app|unknown sources|canRequestPackageInstalls/i.test(msg)) {
    return new UpdateError('unknown-sources-denied', msg || 'Unknown app installation permission is required', { cause: err })
  }
  if (code === 'ERR_HASH_MISMATCH' || /sha-?256 mismatch|corrupted|tampered/i.test(msg)) {
    return new UpdateError('checksum-mismatch', msg || 'SHA-256 mismatch: the download may be corrupted', { cause: err })
  }
  return new UpdateError('installer-failed', msg || 'Could not open Android package installer', { cause: err })
}

export async function canInstallPackages() {
  if (!MOBILE) return false
  const Install = await getInstallPlugin()
  if (typeof Install.canInstall !== 'function') return true
  const res = await Install.canInstall()
  return !!res?.granted
}

export async function openUnknownSourcesSettings() {
  if (!MOBILE) return false
  const Install = await getInstallPlugin()
  const res = await Install.openInstallSettings()
  return !!res?.opened
}

/**
 * Resumes installing an already-downloaded APK in cache without re-downloading ~300 MB
 * (e.g. right after returning from Android's "Install unknown apps" settings screen).
 */
export async function resumePendingInstall(expectedHash) {
  if (!AUTOMATIC_UPDATES) throw new UpdateError('installer-failed', 'Automatic updates are disabled')
  if (!/^[0-9a-f]{64}$/i.test(expectedHash || '')) {
    throw new UpdateError('checksum-missing', 'No valid SHA-256 checksum to verify the download against')
  }
  if (!MOBILE) return
  const Install = await getInstallPlugin()
  try {
    await Install.installApk({ fileName: APK_CACHE_FILE, sha256: expectedHash.toLowerCase() })
  } catch (err) {
    throw mapInstallError(err)
  }
}

/**
 * Downloads the APK from `url` into the cache directory, cleans up partial downloads if
 * interrupted, reuses an already-verified cached APK when available, and launches the native
 * Android package installer after streaming SHA-256 verification.
 *
 * @param {string} url - Direct download URL for the APK
 * @param {string} expectedHash - Expected 64-hex SHA-256 digest
 * @param {function|null} onProgress - Called with (received, total) bytes during download, or null
 */
export async function downloadAndInstall(url, expectedHash, onProgress = null) {
  if (!AUTOMATIC_UPDATES) throw new UpdateError('installer-failed', 'Use the verified APK from your distribution maintainer')
  if (!MOBILE) {
    window.open(RELEASES_PAGE, '_blank', 'noopener')
    return
  }
  if (!/^[0-9a-f]{64}$/i.test(expectedHash || '')) {
    throw new UpdateError('checksum-missing', 'No valid SHA-256 checksum to verify the download against')
  }

  const normalizedHash = expectedHash.toLowerCase()
  const Install = await getInstallPlugin()

  let alreadyCached = false
  if (typeof Install.hasCachedApk === 'function') {
    try {
      const res = await Install.hasCachedApk({ fileName: APK_CACHE_FILE, sha256: normalizedHash })
      alreadyCached = !!res?.cached
    } catch {
      alreadyCached = false
    }
  }

  if (!alreadyCached) {
    if (isOfflineNow()) throw new UpdateError('offline', 'Device is offline')
    const { Filesystem, Directory } = await import('@capacitor/filesystem')
    try {
      await Filesystem.deleteFile({ path: APK_CACHE_FILE, directory: Directory.Cache })
    } catch {
      // No stale partial APK in cache
    }
    const listener = onProgress
      ? await Filesystem.addListener('progress', p => onProgress(p.bytes, p.contentLength))
      : null
    try {
      await Filesystem.downloadFile({ url, path: APK_CACHE_FILE, directory: Directory.Cache, progress: !!onProgress })
    } catch (err) {
      try { await Filesystem.deleteFile({ path: APK_CACHE_FILE, directory: Directory.Cache }) } catch { /* ignore */ }
      throw new UpdateError(
        isOfflineNow() ? 'offline' : 'download-interrupted',
        err?.message || 'Download was interrupted before completion',
        { cause: err },
      )
    } finally {
      await listener?.remove()
    }
  } else if (onProgress) {
    onProgress(1, 1)
  }

  try {
    await Install.installApk({ fileName: APK_CACHE_FILE, sha256: normalizedHash })
  } catch (err) {
    throw mapInstallError(err)
  }
}

export function shouldAutoCheckUpdate(now = Date.now()) {
  try {
    const raw = localStorage.getItem(STORAGE_CHECK_TS)
    if (!raw) return true
    const last = Number(raw)
    if (!Number.isFinite(last) || last <= 0) return true
    return now - last >= AUTO_CHECK_INTERVAL_MS
  } catch {
    return true
  }
}

export function markAutoChecked(now = Date.now()) {
  try {
    localStorage.setItem(STORAGE_CHECK_TS, String(now))
  } catch {
    // Ignore storage errors (private mode / quota)
  }
}

export function isVersionDismissed(version) {
  if (!version) return false
  try {
    const raw = localStorage.getItem(STORAGE_DISMISSED)
    if (!raw) return false
    const normStored = extractReleaseSemver(raw) || raw.trim()
    const normTarget = extractReleaseSemver(String(version)) || String(version).trim()
    return normStored === normTarget
  } catch {
    return false
  }
}

export function dismissVersion(version) {
  if (!version) return
  try {
    const norm = extractReleaseSemver(String(version)) || String(version).trim()
    localStorage.setItem(STORAGE_DISMISSED, norm)
  } catch {
    // Ignore storage errors
  }
}
