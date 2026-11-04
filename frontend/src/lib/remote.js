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
import {PUBLIC_ANDROID,publicServerOrigin} from './public-android.js'
const PERSONAL_SESSION='opengym.personal.session.'+new URL(PERSONAL_ORIGIN).hostname
const PUBLIC_SESSION='opengym.selfhosted.session.v1'
let publicSession=null,publicTransition=false,publicSessionUncertain=false
const uncertainSession=()=>Object.assign(new Error('secure-session-restart-required'),{code:'secure-session-restart-required'})
async function savePairing(data){
  if(PERSONAL_BETA||PUBLIC_ANDROID)await durableSecureSet(PERSONAL_BETA?PERSONAL_SESSION:PUBLIC_SESSION,JSON.stringify(data))
  else await saveRemoteFile(data)
  if(PUBLIC_ANDROID)publicSession=data
}
// Do not allow a delayed renewal/disconnect to overwrite a newer pairing. The
// public profile rejects concurrent reads/transitions. A JS timeout cannot cancel
// a native write. Once its outcome is unknown, keep this process closed to every
// session operation, even if the native callback eventually arrives. Recovery
// requires a full app-process restart; a WebView reload is not a cancellation.
async function changePublicSession(action){
  if(!PUBLIC_ANDROID)return action()
  if(publicSessionUncertain)throw uncertainSession()
  if(publicTransition)throw new Error('Session change already in progress')
  publicTransition=true
  try{return await action()}
  catch(error){
    if(error?.code==='secure-storage-timeout'){
      publicSessionUncertain=true
      setRemoteAuth('',null)
      throw uncertainSession()
    }
    throw error
  }finally{if(!publicSessionUncertain)publicTransition=false}
}

// Accepts what someone actually types: bare host, no scheme, trailing slash, stray whitespace.
// Defaults to https:// (self-hosting docs already push for HTTPS; the one exception, localhost,
// still parses fine without a scheme). Returns null for anything that isn't a usable URL at all.
export function normalizeServerUrl(raw) {
  if(PUBLIC_ANDROID)return publicServerOrigin(raw)
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
  if(PUBLIC_ANDROID)return changePublicSession(async()=>{
    // This package has its own app sandbox. Never import another distribution's
    // plaintext token or silently fall back to a local session after a vault error.
    const raw=await durableSecureGet(PUBLIC_SESSION)
    if(raw==null){publicSession=null;return null}
    if(typeof raw!=='string'||raw.length>16384)throw new Error('secure-session-invalid')
    const value=JSON.parse(raw)
    if(value?.mode==='local'){publicSession={mode:'local'};return publicSession}
    if(value?.mode!=='remote'||publicServerOrigin(value.base)!==value.base||
      typeof value.token!=='string'||!value.token||value.token.length>4096||
      typeof value.user?.id!=='string'||!value.user.id||value.user.id.length>128)throw new Error('secure-session-invalid')
    publicSession=value;return value
  })
  if(PERSONAL_BETA){
    try{const raw=await durableSecureGet(PERSONAL_SESSION),v=raw?JSON.parse(raw):null;return v?.mode==='remote'&&v.base===PERSONAL_ORIGIN&&typeof v.token==='string'&&v.token.length<=4096&&v.token.length>0&&typeof v.user?.id==='string'?v:null}catch{return null}
  }
  return loadRemoteFile()
}

export async function chooseLocal() {
  if(PERSONAL_BETA)throw new Error('Connect to my server')
  if(PUBLIC_ANDROID)return changePublicSession(()=>savePairing({mode:'local'}))
  await saveRemoteFile({ mode: 'local' })
}

// The server's Cloudflare Access token goes with it (lib/cf-access.js).
export async function forgetRemote() {
  return changePublicSession(async()=>{
  if(PERSONAL_BETA)await durableSecureRemove(PERSONAL_SESSION)
  else if(PUBLIC_ANDROID)await savePairing({mode:'local'})
  else await saveRemoteFile({ mode: 'local' })
  setRemoteAuth('', null)
  await clearCfAccess()
  })
}

// The server renewed the token (GET /api/me hands one out once the old is past half its life):
// every request from now on carries it, and the pairing file keeps it for the next start. The
// old one stays valid until its own expiry, so a write that fails here costs nothing but a
// renewal on a later start.
export async function renewToken(remote, token) {
  return changePublicSession(async()=>{
  if(PERSONAL_BETA&&remote.base!==PERSONAL_ORIGIN)throw new Error('Wrong personal beta server')
  if(PUBLIC_ANDROID&&publicServerOrigin(remote.base)!==remote.base)throw new Error('Invalid HTTPS server address')
  if(PUBLIC_ANDROID&&(publicSession?.mode!=='remote'||publicSession.base!==remote.base||publicSession.token!==remote.token||publicSession.user?.id!==remote.user?.id))throw new Error('Session changed before renewal')
  if(PUBLIC_ANDROID&&(typeof token!=='string'||!token||token.length>4096))throw new Error('Invalid renewal response')
  if(PERSONAL_BETA||PUBLIC_ANDROID){await savePairing({ ...remote, token });setRemoteAuth(remote.base, token)}
  else{setRemoteAuth(remote.base,token);await saveRemoteFile({...remote,token})}
  })
}

// Redeems the pairing code, wires api.js at the resolved base, and persists the connection so
// boot() can restore it on the next launch.
export async function connect(rawUrl, code) {
  const base = normalizeServerUrl(rawUrl)
  if (!base) throw new Error('Enter a valid server address')
  if(PERSONAL_BETA&&base!==PERSONAL_ORIGIN)throw new Error('Wrong personal beta server')
  return changePublicSession(async()=>{
  const { token, user } = await pairRedeem(base, String(code || '').trim())
  if(PUBLIC_ANDROID&&(typeof token!=='string'||!token||token.length>4096||typeof user?.id!=='string'||!user.id||user.id.length>128||JSON.stringify({token,user}).length>16000))throw new Error('Invalid pairing response')
  if(PERSONAL_BETA||PUBLIC_ANDROID){await savePairing({ mode:'remote',base,token,user });setRemoteAuth(base,token)}
  else{setRemoteAuth(base,token);await saveRemoteFile({mode:'remote',base,token,user})}
  return user
  })
}
