import { userInfo } from 'node:os'

/** Verify the real invoking identity, never USER/LOGNAME. Explicit root ownership is
 * useful for isolated CI fixtures; it never makes a generated container run as root. */
export function deploymentOwner(environment = process.env, identity = userInfo()) {
  const owner = environment.OPENGYM_DEPLOY_OWNER ?? identity.username
  if (owner !== identity.username || environment.SUDO_USER || environment.SUDO_UID ||
      (identity.uid === 0 && environment.OPENGYM_DEPLOY_OWNER !== identity.username)) {
    throw Error('Run as OPENGYM_DEPLOY_OWNER (defaults to the current user), without sudo; root requires explicit ownership')
  }
  const uid = environment.OPENGYM_RUNTIME_UID ?? (identity.uid || 1000)
  const gid = environment.OPENGYM_RUNTIME_GID ?? (identity.gid || 1000)
  if (![uid, gid].every(value => /^[1-9][0-9]{0,9}$/.test(String(value)) && Number(value) <= 2147483647)) {
    throw Error('OPENGYM_RUNTIME_UID and OPENGYM_RUNTIME_GID must be nonzero numeric IDs')
  }
  return { owner, uid: Number(uid), gid: Number(gid) }
}
