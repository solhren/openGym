import { test, expect } from 'vitest'
import { estimateDynamicTdee, assessGoalCalibration, buildWeightTrendSeries, LB_TO_KG } from './tdee.js'

function addDays(iso, delta) {
  const dt = new Date(`${iso}T12:00:00Z`)
  dt.setUTCDate(dt.getUTCDate() + delta)
  return dt.toISOString().slice(0, 10)
}

function generateNutritionDays(startIso, count, kcal) {
  return Array.from({ length: count }, (_, i) => ({
    d: addDays(startIso, i),
    count: 3,
    totals: { kcal },
  }))
}

test('returns clear insufficient-data diagnostics when food logs, weigh-ins, or span are below minimum', () => {
  expect(estimateDynamicTdee().status).toBe('insufficient-data')

  const start = '2026-10-01'
  const foodDays = generateNutritionDays(start, 7, 2400) // < 10 food days
  const bodyweight = [
    { d: '2026-10-01', w: 80 },
    { d: '2026-10-05', w: 80 },
    { d: '2026-10-10', w: 80 },
    { d: '2026-10-15', w: 80 },
  ]
  const res = estimateDynamicTdee({ nutritionDays: foodDays, bodyweight, endDate: '2026-10-21' })
  expect(res.status).toBe('insufficient-data')
  expect(res.requirements).toEqual({
    foodDays: 7,
    minFoodDays: 10,
    weighIns: 4,
    minWeighIns: 4,
    spanDays: 14,
    minSpanDays: 10,
  })
  expect(res.averageIntakeKcal).toBe(2400)
  expect(res.weightSeries).toHaveLength(4)

  // Clustered weigh-ins with < 10 days span also trigger insufficient-data
  const clustered = estimateDynamicTdee({
    nutritionDays: generateNutritionDays(start, 15, 2400),
    bodyweight: [
      { d: '2026-10-01', w: 80 },
      { d: '2026-10-02', w: 80 },
      { d: '2026-10-03', w: 80 },
      { d: '2026-10-05', w: 80 },
    ],
    endDate: '2026-10-21',
  })
  expect(clustered.status).toBe('insufficient-data')
  expect(clustered.requirements.spanDays).toBe(4)
})

test('estimates steady maintenance TDEE accurately and ignores partial morning / water-only days', () => {
  const start = '2026-10-01'
  const nutritionDays = [
    ...generateNutritionDays(start, 19, 2500),
    // Day 20: water-only day (count === 0)
    { d: '2026-10-20', count: 0, totals: { kcal: 0 } },
    // Day 21 (endDate today): unfinished 220 kcal morning coffee/snack
    { d: '2026-10-21', count: 1, totals: { kcal: 220 } },
    // Also test a 600 kcal unfinished breakfast on endDate in a separate check below
  ]
  const bodyweight = Array.from({ length: 10 }, (_, i) => ({
    d: addDays(start, i * 2),
    w: 80 + (i % 2 === 0 ? 0.1 : -0.1),
  }))

  const res = estimateDynamicTdee({
    nutritionDays,
    bodyweight,
    endDate: '2026-10-21',
  })
  expect(res.status).toBe('ready')
  expect(res.confidence).toBe('high')
  expect(res.requirements.foodDays).toBe(19)
  expect(res.averageIntakeKcal).toBe(2500)
  expect(res.estimatedTdeeKcal).toBeGreaterThan(2450)
  expect(res.estimatedTdeeKcal).toBeLessThan(2550)

  // A 600 kcal unfinished breakfast on endDate (<55% of 2500 avg) is also excluded when excludeIncompleteToday=true
  const withHalfBreakfast = [
    ...generateNutritionDays(start, 19, 2500),
    { d: '2026-10-21', count: 1, totals: { kcal: 600 } },
  ]
  const res2 = estimateDynamicTdee({ nutritionDays: withHalfBreakfast, bodyweight, endDate: '2026-10-21' })
  expect(res2.averageIntakeKcal).toBe(2500)
})

test('estimates TDEE during weight loss, weight gain, and lb units with EWMA warmup', () => {
  // Warm-up 14 days + 21-day window losing exactly 0.07 kg/day (-0.49 kg/wk => ~539 kcal/day deficit)
  // Eating 2000 kcal/day => TDEE should converge right around 2539 kcal/day
  const baseStart = '2026-09-15'
  const bodyweightKg = Array.from({ length: 36 }, (_, i) => ({
    d: addDays(baseStart, i),
    w: 85 - i * 0.07,
  }))
  const windowStart = addDays(baseStart, 15) // 2026-09-30
  const windowEnd = addDays(baseStart, 35)   // 2026-10-20
  const cutDays = generateNutritionDays(windowStart, 21, 2000)

  const cutRes = estimateDynamicTdee({
    nutritionDays: cutDays,
    bodyweight: bodyweightKg,
    endDate: windowEnd,
  })
  expect(cutRes.status).toBe('ready')
  expect(cutRes.confidence).toBe('high')
  expect(cutRes.weeklyWeightChangeKg).toBeCloseTo(-0.49, 1)
  expect(cutRes.estimatedTdeeKcal).toBeGreaterThan(2500)
  expect(cutRes.estimatedTdeeKcal).toBeLessThan(2580)

  // Same exact physical trajectory recorded in pounds (lb)
  const bodyweightLb = bodyweightKg.map(row => ({ d: row.d, w: row.w / LB_TO_KG }))
  const lbRes = estimateDynamicTdee({
    nutritionDays: cutDays,
    bodyweight: bodyweightLb,
    unit: 'lb',
    endDate: windowEnd,
  })
  expect(lbRes.status).toBe('ready')
  expect(Math.abs(lbRes.estimatedTdeeKcal - cutRes.estimatedTdeeKcal)).toBeLessThanOrEqual(3)
  expect(lbRes.weeklyWeightChangeDisplay).toBeCloseTo(-0.49 / LB_TO_KG, 1)
  expect(lbRes.weightSeries[0].rawDisplay).toBeCloseTo(85 / LB_TO_KG, 1)
})

test('flags extreme physically implausible weight jumps as unreliable', () => {
  const start = '2026-10-01'
  const res = estimateDynamicTdee({
    nutritionDays: generateNutritionDays(start, 14, 2200),
    bodyweight: [
      { d: '2026-10-01', w: 80 },
      { d: '2026-10-05', w: 72 },
      { d: '2026-10-10', w: 64 },
      { d: '2026-10-14', w: 55 },
    ],
    windowDays: 14,
    endDate: '2026-10-14',
  })
  expect(res.status).toBe('unreliable')
  expect(res.estimatedTdeeKcal).toBeNull()
})

test('assessGoalCalibration evaluates cut, bulk, maintenance, custom, and cycling trainingTargets', () => {
  // Cut at 80kg, TDEE 2600: ideal weekly loss is -0.20 to -0.80 kg/wk (~2150 kcal)
  expect(assessGoalCalibration({
    estimatedTdeeKcal: 2600,
    latestTrendKg: 80,
    goal: { mode: 'cut', targets: { kcal: 2100 } },
  }).status).toBe('well-calibrated')

  const slowCut = assessGoalCalibration({
    estimatedTdeeKcal: 2600,
    latestTrendKg: 80,
    goal: { mode: 'cut', targets: { kcal: 2550 } },
  })
  expect(slowCut.status).toBe('too-slow')
  expect(slowCut.suggestedKcal % 25).toBe(0)

  expect(assessGoalCalibration({
    estimatedTdeeKcal: 2600,
    latestTrendKg: 80,
    goal: { mode: 'cut', targets: { kcal: 1500 } },
  }).status).toBe('too-fast')

  // Bulk at 80kg, TDEE 2600: ideal weekly gain is +0.08 to +0.40 kg/wk
  expect(assessGoalCalibration({
    estimatedTdeeKcal: 2600,
    latestTrendKg: 80,
    goal: { mode: 'bulk', targets: { kcal: 2850 } },
  }).status).toBe('well-calibrated')

  expect(assessGoalCalibration({
    estimatedTdeeKcal: 2600,
    latestTrendKg: 80,
    goal: { mode: 'bulk', targets: { kcal: 2500 } },
  }).status).toBe('too-slow')

  expect(assessGoalCalibration({
    estimatedTdeeKcal: 2600,
    latestTrendKg: 80,
    goal: { mode: 'bulk', targets: { kcal: 3300 } },
  }).status).toBe('too-fast')

  // Maintenance & Custom
  expect(assessGoalCalibration({
    estimatedTdeeKcal: 2600,
    latestTrendKg: 80,
    goal: { mode: 'maintenance', targets: { kcal: 2650 } },
  }).status).toBe('well-calibrated')

  expect(assessGoalCalibration({
    estimatedTdeeKcal: 2600,
    latestTrendKg: 80,
    goal: { mode: 'custom', targets: { kcal: 1900 } },
  }).status).toBe('custom')

  // Calorie cycling blends rest + training targets across trainingDaysPerWeek
  const cycled = assessGoalCalibration({
    estimatedTdeeKcal: 2500,
    latestTrendKg: 80,
    trainingDaysPerWeek: 4,
    goal: {
      mode: 'bulk',
      targets: { kcal: 2500 },
      trainingTargets: { kcal: 3000 },
    },
  })
  expect(cycled.targetKcal).toBe(Math.round((2500 * 3 + 3000 * 4) / 7))
  expect(cycled.status).toBe('well-calibrated')
})

test('buildWeightTrendSeries deduplicates same-day weigh-ins and ignores invalid entries', () => {
  const series = buildWeightTrendSeries([
    { d: 'bad-date', w: 80 },
    { d: '2026-10-02', w: 81 },
    { d: '2026-10-01', w: 80 },
    { d: '2026-10-01', w: 80.4 },
    { d: '2026-10-03', w: 0 },
  ])
  expect(series.map(s => s.d)).toEqual(['2026-10-01', '2026-10-02'])
  expect(series[0].rawKg).toBe(80.4)
  expect(series[0].trendKg).toBe(80.4)
})
