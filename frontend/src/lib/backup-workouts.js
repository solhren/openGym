import { check } from './nutrition/persistence-contract.js'
import { safeBackupValue } from './nutrition/backup-contract.js'
import { sanitizeCustomMedia } from './backup-media.js'

// Public profile fields (DEF), plus compatibility/history markers. Connection credentials,
// active sessions and write/owner identifiers are deliberately outside this allowlist.
export const WORKOUT_BACKUP_FIELDS = new Set(`unit restSec restPauseSec sound soundOnSilent vibrateOnSilent timerFlash timedSetOvertime keepAwake lang theme accent body targetW bodyweight routines week dayPlan dayNotes measurements measurementEnabled customMeasurements queue rotation scheduleMode exWeights workouts customEx gifSize heatmapMetric workoutView collapseCompleted exerciseView wc hints reminder effort autoBackup equipProfiles activeEquipId equipFilterOn exNotes favEx weekStart wdec speedUnit barWeights plates loadKind dbLoad dumbbells gymCards lastGymCardId checkIn showWeightCard weighIn connStatus shareMap connLocal startFrom enParens enOnly logRef balanceTemplate balanceOverrides showRir unitSet deleted edited undone routineOrder _ts _sync resetAt resetIds`.split(' '))

/** Keep the existing workout JSON shape, media-reference sanitation and legacy overlay.
 * This is not a replacement for workout's business migrations or its sync merge. */
export function portableWorkoutState(state, { strict = false } = {}) {
  const value = safeBackupValue(state)
  check(value && !Array.isArray(value) && Array.isArray(value.workouts) && Array.isArray(value.routines), 'workouts', 'not-backup')
  if (strict) check(Object.keys(value).every(key => WORKOUT_BACKUP_FIELDS.has(key)), 'workouts', 'unexpected_workout_field')
  else check(Object.keys(value).every(key => WORKOUT_BACKUP_FIELDS.has(key) ||
    ['active', '_wid', '_rev', '_wids', '_unstamped', '_prior', 'token', 'accessToken', 'refreshToken', 'session', 'server', 'cache', 'langAuto'].includes(key)),
  'workouts', 'unknown_workout_backup_field')
  return sanitizeCustomMedia(Object.fromEntries(Object.entries(value).filter(([key]) => WORKOUT_BACKUP_FIELDS.has(key))))
}
