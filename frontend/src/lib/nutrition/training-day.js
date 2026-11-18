import { workoutDay, effectiveRoutines } from '../history.js'
import { todayISO } from '../format.js'

export function isTrainingDay(S, iso, today = todayISO()) {
  if (!S || typeof S !== 'object' || !iso || typeof iso !== 'string') return false
  const workouts = Array.isArray(S.workouts) ? S.workouts : []
  const logged = workouts.some(w => workoutDay(w) === iso)
  if (iso < today) return logged

  const hasPlanned = () => {
    const safeS = {
      ...S,
      routines: Array.isArray(S.routines) ? S.routines : [],
      workouts,
      week: S.week && typeof S.week === 'object' ? S.week : {},
      dayPlan: S.dayPlan && typeof S.dayPlan === 'object' ? S.dayPlan : {},
    }
    return (effectiveRoutines(safeS, iso, today) || []).some(r => Array.isArray(r?.ex) && r.ex.length > 0)
  }

  if (iso === today) {
    if (logged) return true
    if (!!S.active && !S.active.editingWorkoutId && !S.active.backfill) return true
    return hasPlanned()
  }
  return hasPlanned()
}
