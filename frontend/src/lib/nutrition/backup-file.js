import { check, HASH_PATTERN } from './persistence-contract.js'

/** Deliver a completed, validated export through openGym's existing chunked native share
 * adapter or a browser download. File selection remains the host UI's responsibility.
 * A failed/cancelled share leaves the immutable Blob with the caller for another attempt. */
export async function saveNutritionBackup(result, { native, share, document = globalThis.document, url = globalThis.URL, guard = () => {} } = {}) {
  guard()
  check(result?.blob && typeof result.blob.slice === 'function' && typeof result.digest === 'string' && HASH_PATTERN.test(result.digest), 'backup', 'invalid_backup_export')
  const filename = `opengym-backup-${result.digest.slice(0, 16)}.zip`
  if (native === undefined) native = (await import('@capacitor/core')).Capacitor.isNativePlatform()
  guard()
  if (native) {
    const send = share ?? (await import('../mobile.js')).shareExportBlob
    guard()
    await send(result.blob, filename)
    return { status: 'shared', filename }
  }
  check(document?.createElement && url?.createObjectURL && url?.revokeObjectURL, 'backup', 'backup_download_unavailable')
  const uri = url.createObjectURL(result.blob), link = document.createElement('a')
  try {
    link.href = uri; link.download = filename; guard(); link.click()
    // A delayed revoke lets the browser consume the download URL. No Nutrition data is
    // written to localStorage/Cache, and the URL is never constructed from imported paths.
    setTimeout(() => url.revokeObjectURL(uri), 1000)
  } catch (error) { url.revokeObjectURL(uri); throw error }
  return { status: 'download-requested', filename }
}
