import {PERSONAL_BETA} from './personal-beta.js'

/**
 * Whether "Continue without account" may be offered, given the public config from /api/config.
 *
 * Guest mode is allowed unless the server has *positively* said otherwise. That asymmetry is the
 * whole point: a config we could not fetch — offline, server restarting, request failed — is not
 * the same answer as `allow_guest: false`, and treating it as one would lock people out of an
 * instance whose admin never disabled anything. An instance that really did disable guests says
 * so on the next successful boot, and the session is ended then (see useStore.boot).
 *
 * Older servers predate the flag and send no `allow_guest` at all; they mean "allowed".
 * The explicit personal build is the exception: it forbids guests even before
 * config loads or when the API is unavailable. Ordinary offline mode is unchanged.
 *
 * @param {{allow_guest?: boolean}|null|undefined} config Parsed /api/config body, or null.
 * @returns {boolean} true when the guest entrance may be shown and used.
 */
export const guestAllowed = config => !PERSONAL_BETA && !(config && config.allow_guest === false)
