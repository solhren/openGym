// Mobile build only: "connect to my server" mode (see mobile.js's header comment for why the
// mobile flavor has no backend at all by default). This is the alternative — pairing the app to
// an already self-hosted openGym server instead of keeping data device-local.
//
// Passkeys can't be used from inside the app's own WebView (its origin never matches the
// server's RP_ID), so auth here is a short one-time code redeemed from an already signed-in
// browser tab (Settings → "Pair the mobile app") for a bearer token — see api/server.js's
// /api/pair/create + /api/pair/redeem.
import { pairRedeem, setRemoteAuth } from './api.js'
import { loadRemoteFile, saveRemoteFile } from './mobile.js'
import { clearCfAccess } from './cf-access.js'
import {PERSONAL_BETA,PERSONAL_ORIGIN} from './personal-beta.js'
import {durableSecureGet,durableSecureSet,durableSecureRemove} from './coach-secrets.js'
const PERSONAL_SESSION='opengym.personal.session.'+new URL(PERSONAL_ORIGIN).hostname
const savePairing=data=>PERSONAL_BETA?durableSecureSet(PERSONAL_SESSION,JSON.stringify(data)):saveRemoteFile(data)

// Accepts what someone actually types: bare host, no scheme, trailing slash, stray whitespace.
// Defaults to https:// (self-hosting docs already push for HTTPS; the one exception, localhost,
// still parses fine without a scheme). Returns null for anything that isn't a usable URL at all.
export function normalizeServerUrl(raw) {
  const s = String(raw || '').trim()
  if (!s) return null
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : 'https://' + s
  try {
    const u = new URL(withScheme)
    if (!u.hostname) return null
    return u.origin
  } catch (e) { return null }
}

export async function loadRemote() {
  if(PERSONAL_BETA){
    try{const raw=await durableSecureGet(PERSONAL_SESSION),v=raw?JSON.parse(raw):null;return v?.mode==='remote'&&v.base===PERSONAL_ORIGIN&&typeof v.token==='string'&&v.token.length<=4096&&v.token.length>0&&typeof v.user?.id==='string'?v:null}catch{return null}
  }
  return loadRemoteFile()
}

export async function chooseLocal() {
  if(PERSONAL_BETA)throw new Error('Connect to my server')
  await saveRemoteFile({ mode: 'local' })
}

// The server's Cloudflare Access token goes with it (lib/cf-access.js).
export async function forgetRemote() {
  if(PERSONAL_BETA)await durableSecureRemove(PERSONAL_SESSION)
  else await saveRemoteFile({ mode: 'local' })
  setRemoteAuth('', null)
  await clearCfAccess()
}

// The server renewed the token (GET /api/me hands one out once the old is past half its life):
// every request from now on carries it, and the pairing file keeps it for the next start. The
// old one stays valid until its own expiry, so a write that fails here costs nothing but a
// renewal on a later start.
export async function renewToken(remote, token) {
  if(PERSONAL_BETA&&remote.base!==PERSONAL_ORIGIN)throw new Error('Wrong personal beta server')
  if(PERSONAL_BETA){await savePairing({ ...remote, token });setRemoteAuth(remote.base, token)}
  else{setRemoteAuth(remote.base,token);await saveRemoteFile({...remote,token})}
}

// Redeems the pairing code, wires api.js at the resolved base, and persists the connection so
// boot() can restore it on the next launch.
export async function connect(rawUrl, code) {
  const base = normalizeServerUrl(rawUrl)
  if (!base) throw new Error('Enter a valid server address')
  if(PERSONAL_BETA&&base!==PERSONAL_ORIGIN)throw new Error('Wrong personal beta server')
  const { token, user } = await pairRedeem(base, String(code || '').trim())
  if(PERSONAL_BETA){await savePairing({ mode:'remote',base,token,user });setRemoteAuth(base,token)}
  else{setRemoteAuth(base,token);await saveRemoteFile({mode:'remote',base,token,user})}
  return user
}
