// @vitest-environment happy-dom
import { test, expect } from 'vitest'
import { WORKOUT_BACKUP_FIELDS, portableWorkoutState } from './backup-workouts.js'
import { DEF } from '../store/useStore.js'
test('all public workout profile fields remain exportable, except installation-only active session', () => {
  expect(Object.keys(DEF).filter(key => key !== 'active').filter(key => !WORKOUT_BACKUP_FIELDS.has(key))).toEqual([])
  const state = portableWorkoutState({ ...JSON.parse(JSON.stringify(DEF)), token: 'secret', _wid: 'installation' })
  for (const key of Object.keys(DEF).filter(key => key !== 'active')) expect(state[key]).toEqual(DEF[key])
  expect(state.token).toBeUndefined(); expect(state._wid).toBeUndefined(); expect(state.active).toBeUndefined()
})
test('unknown future personal fields are refused, never silently omitted', () => {
  expect(() => portableWorkoutState({ workouts: [], routines: [], futurePersonalField: ['keep'] })).toThrow()
})
