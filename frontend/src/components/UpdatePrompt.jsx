import { forwardRef, useEffect, useRef, useState } from 'react'
import { MOBILE, isAndroid } from '../lib/mobile.js'
import { t } from '../lib/i18n.js'
import {
  AUTOMATIC_UPDATES,
  RELEASES_PAGE,
  UpdateError,
  checkForUpdate,
  dismissVersion,
  downloadAndInstall,
  fetchChecksum,
  isVersionDismissed,
  markAutoChecked,
  openUnknownSourcesSettings,
  resumePendingInstall,
  shouldAutoCheckUpdate,
} from '../lib/update.js'
import { useUI } from '../store/useUI.js'
import { confirmSheet } from '../sheets.jsx'
import Icon from './Icon.jsx'
import { Button } from './ui.jsx'

// Download progress sheet — receives a ref callback that exposes a (received, total) setter.
export const DownloadProgress = forwardRef(function DownloadProgress(_, ref) {
  const [pct, setPct] = useState(0)
  const [text, setText] = useState(t('Starting download…'))
  if (ref) ref(function update(received, total) {
    if (total > 0) {
      const p = Math.min(100, Math.round((received / total) * 100))
      setPct(p)
      setText(t('{0} %', p))
    } else {
      setText(t('{0} MB', (received / 1_000_000).toFixed(1)))
    }
  })
  return (
    <div style={{ textAlign: 'center', padding: '8px 0' }}>
      <h3>{t('Downloading update…')}</h3>
      <div style={{ margin: '16px 0', height: 6, borderRadius: 3, background: 'var(--fill-3)', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: pct + '%', background: 'var(--acc)', borderRadius: 3, transition: 'width .2s' }} />
      </div>
      <div className="muted small">{text}</div>
    </div>
  )
})

let pendingResumeCleanup = null

export function resetPendingResumeListener() {
  if (pendingResumeCleanup) {
    const fn = pendingResumeCleanup
    pendingResumeCleanup = null
    fn()
  }
}

function showUnknownSourcesSheet(expectedHash, updateInfo) {
  confirmSheet({
    title: t('Allow app installations'),
    message: t('Android requires enabling “Install unknown apps” for openGym before opening the update. Your download is saved and ready.'),
    confirmText: t('Open Android settings'),
    onConfirm: async () => {
      await attachResumeOnReturn(expectedHash, updateInfo)
      try {
        await openUnknownSourcesSettings()
      } catch {
        resetPendingResumeListener()
        useUI.getState().toast(t('Could not open Android settings. Enable “Install unknown apps” for openGym and try again.'))
      }
    },
  })
}

async function attachResumeOnReturn(expectedHash, updateInfo) {
  resetPendingResumeListener()
  try {
    const { App: CapApp } = await import('@capacitor/app')
    if (!CapApp?.addListener) return
    let done = false
    let handle = null
    const cleanup = () => {
      if (done) return
      done = true
      if (pendingResumeCleanup === cleanup) pendingResumeCleanup = null
      handle?.remove?.()
    }
    pendingResumeCleanup = cleanup
    handle = await CapApp.addListener('appStateChange', async state => {
      if (!state?.isActive || done) return
      cleanup()
      try {
        await resumePendingInstall(expectedHash)
      } catch (resumeErr) {
        if (resumeErr?.code === 'unknown-sources-denied') {
          showUnknownSourcesSheet(expectedHash, updateInfo)
        } else {
          useUI.getState().toast(t('Update failed: {0}', resumeErr?.message || String(resumeErr)))
        }
      }
    })
    if (done) handle?.remove?.()
  } catch {
    // @capacitor/app not available in this environment
  }
}

/**
 * Shared interactive update runner used by both the launch prompt and Settings → About.
 * Handles offline detection, download progress, interrupted-download cleanup + retry sheet,
 * and Android "Install unknown apps" permission recovery without re-downloading the APK.
 */
export async function runInteractiveUpdate(updateInfo) {
  if (!updateInfo?.apkUrl) {
    window.open(RELEASES_PAGE, '_blank', 'noopener')
    return { status: 'opened-releases' }
  }

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    confirmSheet({
      title: t('You appear to be offline'),
      message: t('Connect to the internet and try downloading openGym v{0} again.', updateInfo.latestVersion),
      confirmText: t('Retry download'),
      onConfirm: () => runInteractiveUpdate(updateInfo),
    })
    return { status: 'offline' }
  }

  let closeProgress = null
  let setProgress = null
  useUI.getState().openSheet(close => {
    closeProgress = close
    return <DownloadProgress ref={fn => { setProgress = fn }} />
  }, { locked: true })

  let expectedHash = null
  try {
    expectedHash = await fetchChecksum(updateInfo.hashUrl)
    if (!/^[0-9a-f]{64}$/i.test(expectedHash || '')) {
      throw new UpdateError('checksum-missing', t('Checksum not available, so not installing'))
    }
    await downloadAndInstall(updateInfo.apkUrl, expectedHash, (received, total) => {
      if (setProgress) setProgress(received, total)
    })
    if (closeProgress) closeProgress()
    return { status: 'installed' }
  } catch (err) {
    if (closeProgress) closeProgress()
    const code = err?.code || (typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : null)

    if (code === 'unknown-sources-denied' && expectedHash) {
      showUnknownSourcesSheet(expectedHash, updateInfo)
      return { status: 'unknown-sources-denied' }
    }

    if (code === 'download-interrupted' || code === 'offline') {
      confirmSheet({
        title: code === 'offline' ? t('You appear to be offline') : t('Download interrupted'),
        message: code === 'offline'
          ? t('Connect to the internet and try downloading openGym v{0} again.', updateInfo.latestVersion)
          : t('The update download lost connection before finishing. Any partial file was cleaned up.'),
        confirmText: t('Retry download'),
        onConfirm: () => runInteractiveUpdate(updateInfo),
      })
      return { status: code }
    }

    useUI.getState().toast(t('Update failed: {0}', err?.message || String(err)))
    return { status: 'failed', error: err }
  }
}

export default function UpdatePrompt({ active = true }) {
  const [promptInfo, setPromptInfo] = useState(null)
  const checkedRef = useRef(false)

  useEffect(() => {
    if (!MOBILE || !AUTOMATIC_UPDATES || !active || checkedRef.current) return
    let cancelled = false
    isAndroid()
      .then(ok => {
        if (cancelled || !ok || checkedRef.current) return
        if (!shouldAutoCheckUpdate()) {
          checkedRef.current = true
          return
        }
        checkedRef.current = true
        return checkForUpdate().then(info => {
          markAutoChecked()
          if (cancelled) return
          if (info?.hasUpdate && info.latestVersion && !isVersionDismissed(info.latestVersion)) {
            setPromptInfo(info)
          }
        })
      })
      .catch(() => {
        // Silent at launch when offline or GitHub is unreachable
      })
    return () => { cancelled = true }
  }, [active])

  if (!MOBILE || !AUTOMATIC_UPDATES || !active || !promptInfo?.hasUpdate) return null

  const onLater = () => {
    dismissVersion(promptInfo.latestVersion)
    setPromptInfo(null)
  }

  const onInstall = () => {
    const info = promptInfo
    setPromptInfo(null)
    runInteractiveUpdate(info)
  }

  return (
    <div
      role="region"
      aria-label={t('App update available')}
      style={{
        position: 'fixed',
        left: 12,
        right: 12,
        bottom: 'calc(var(--tabbar-h, 64px) + env(safe-area-inset-bottom, 0px) + 12px)',
        maxWidth: 460,
        margin: '0 auto',
        zIndex: 90,
        background: 'var(--bg-2, #1c1c1e)',
        border: '1px solid var(--sep, rgba(255,255,255,0.12))',
        borderRadius: 16,
        padding: '12px 14px',
        boxShadow: '0 8px 28px rgba(0, 0, 0, 0.35)',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span
          className="lrow-i"
          style={{ '--tint': 'var(--green)', flexShrink: 0 }}
          aria-hidden="true"
        >
          <Icon name="download" />
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 15, lineHeight: 1.25 }}>
            {t('openGym v{0} is available', promptInfo.latestVersion)}
          </div>
          <div className="muted small" style={{ marginTop: 2, lineHeight: 1.3 }}>
            {t('Verified update ready to download and install.')}
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <Button size="sm" onClick={onLater}>{t('Later')}</Button>
        <Button size="sm" variant="primary" onClick={onInstall}>{t('Download & Install')}</Button>
      </div>
    </div>
  )
}
