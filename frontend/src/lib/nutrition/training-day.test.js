import { test, expect } from 'vitest'
import { isTrainingDay } from './training-day.js'

const routines = [
  { id: 'push', name: 'Push', ex: [{ id: '0001', sets: 3, reps: 10 }] },
  { id: 'pull', name: 'Pull', ex: [{ id: '0007', sets: 3, reps: 10 }] },
  { id: 'empty', name: 'Mobility', ex: [] },
]

// 2026-10-14 is a Wednesday (weekday 3)
const TODAY = '2026-10-14'

test('returns false when state or iso date is missing', () => {
  expect(isTrainingDay(null, TODAY, TODAY)).toBe(false)
  expect(isTrainingDay({}, '', TODAY)).toBe(false)
  expect(isTrainingDay({}, null, TODAY)).toBe(false)
})

test('past days depend strictly on completed workouts, ignoring unexecuted schedule plans', () => {
  const S = {
    routines,
    // Tuesday (2) and Monday (1) scheduled, but only Monday was actually logged
    week: { 1: 'push', 2: 'pull', 3: 'push' },
    workouts: [{ id: 'w1', d: '2026-10-12', sets: [] }],
  }
  expect(isTrainingDay(S, '2026-10-12', TODAY)).toBe(true)
  expect(isTrainingDay(S, '2026-10-13', TODAY)).toBe(false)
})

test('today detects completed workout, active live workout, or planned non-empty routine while ignoring edit/backfill and rest overrides', () => {
  // Completed workout on a rest day still counts as training day
  expect(isTrainingDay({
    routines,
    week: {},
    workouts: [{ id: 'w-today', d: TODAY }],
  }, TODAY, TODAY)).toBe(true)

  // Active live workout on an unscheduled day counts
  expect(isTrainingDay({
    routines,
    week: {},
    workouts: [],
    active: { routineId: 'push', startedAt: 1700000000000 },
  }, TODAY, TODAY)).toBe(true)

  // Editing an old workout or backfilling does not make today a live training day
  expect(isTrainingDay({
    routines,
    week: {},
    workouts: [],
    active: { editingWorkoutId: 'w-old' },
  }, TODAY, TODAY)).toBe(false)

  expect(isTrainingDay({
    routines,
    week: {},
    workouts: [],
    active: { backfill: '2026-10-10' },
  }, TODAY, TODAY)).toBe(false)

  // Planned non-empty routine on Wednesday (weekday 3)
  expect(isTrainingDay({
    routines,
    week: { 3: 'push' },
    workouts: [],
  }, TODAY, TODAY)).toBe(true)

  // Planned empty routine (0 exercises) does not count
  expect(isTrainingDay({
    routines,
    week: { 3: 'empty' },
    workouts: [],
  }, TODAY, TODAY)).toBe(false)

  // Explicit rest override in dayPlan cancels weekday routine
  expect(isTrainingDay({
    routines,
    week: { 3: 'push' },
    dayPlan: { [TODAY]: 'rest' },
    workouts: [],
  }, TODAY, TODAY)).toBe(false)
})

test('future days follow weekday schedule, dayPlan overrides, and rotation schedules', () => {
  // 2026-10-15 is Thursday (4), 2026-10-16 is Friday (5)
  const S = {
    routines,
    week: { 4: 'push' },
    dayPlan: {
      '2026-10-15': 'rest',
      '2026-10-16': 'pull',
    },
    workouts: [],
  }
  expect(isTrainingDay(S, '2026-10-15', TODAY)).toBe(false)
  expect(isTrainingDay(S, '2026-10-16', TODAY)).toBe(true)
  expect(isTrainingDay(S, '2026-10-17', TODAY)).toBe(false)

  // Queue rotation schedule across training weekdays (Wed=3, Thu=rest, Fri=5)
  const rotState = {
    routines,
    week: { 3: 'push', 5: 'push' },
    queue: { ids: ['push', 'pull'], startsOn: 'push', since: '2026-10-01' },
    workouts: [],
  }
  expect(isTrainingDay(rotState, '2026-10-14', TODAY)).toBe(true)
  expect(isTrainingDay(rotState, '2026-10-15', TODAY)).toBe(false)
  expect(isTrainingDay(rotState, '2026-10-16', TODAY)).toBe(true)
})
