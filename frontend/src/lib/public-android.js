// Separate distribution profile: never inferred from a paired hostname or user data.
export const PUBLIC_ANDROID = import.meta.env.VITE_OPENGYM_PUBLIC_ANDROID === '1'
if (PUBLIC_ANDROID && (import.meta.env.VITE_MOBILE !== '1' || import.meta.env.VITE_OPENGYM_PERSONAL_BETA === '1')) {
  throw new Error('Invalid self-hosted Android build profile')
}

/** Only an HTTPS origin can receive a pairing code/session in the public app. */
export function publicServerOrigin(raw) {
  if (typeof raw !== 'string' || raw.length > 2048 || /[\u0000-\u001f\u007f]/.test(raw)) return null
  const value = raw.trim()
  if (!value || /[\u0000-\u0020\u007f\\]/.test(value)) return null
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(value) ? value : 'https://' + value)
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password ||
      url.search || url.hash || (url.pathname !== '' && url.pathname !== '/')) return null
    return url.origin
  } catch { return null }
}
