import { isNutritionDate } from './validate.js'

export const KCAL_PER_KG = 7700
export const LB_TO_KG = 0.45359237
export const MIN_DAILY_INTAKE_KCAL = 500
export const MIN_TDEE_KCAL = 800
export const MAX_TDEE_KCAL = 7000
export const MIN_FOOD_DAYS = 10
export const MIN_WEIGH_INS = 4
export const MIN_SPAN_DAYS = 10

const round = (n, decimals = 2) => {
  const f = 10 ** decimals
  return Math.round(n * f) / f
}

function daysBetween(startIso, endIso) {
  return Math.round((Date.parse(`${endIso}T00:00:00Z`) - Date.parse(`${startIso}T00:00:00Z`)) / 86400000)
}

function addDaysISO(iso, deltaDays) {
  const dt = new Date(`${iso}T12:00:00Z`)
  dt.setUTCDate(dt.getUTCDate() + deltaDays)
  return dt.toISOString().slice(0, 10)
}

export function buildWeightTrendSeries(bodyweight = [], { unit = 'kg', endDate = null } = {}) {
  const isLb = unit === 'lb'
  const byDay = new Map()

  for (const row of bodyweight ?? []) {
    if (!isNutritionDate(row?.d)) continue
    if (endDate && isNutritionDate(endDate) && row.d > endDate) continue
    const w = Number(row?.w)
    if (!Number.isFinite(w) || w <= 0) continue
    byDay.set(row.d, w)
  }

  const sortedDays = [...byDay.keys()].sort()
  const series = []
  let prevTrendKg = null
  let prevDate = null

  for (const d of sortedDays) {
    const rawInput = byDay.get(d)
    const rawKg = isLb ? rawInput * LB_TO_KG : rawInput
    let exactTrendKg
    if (prevTrendKg === null) {
      exactTrendKg = rawKg
    } else {
      const deltaDays = Math.max(1, daysBetween(prevDate, d))
      const alpha = 1 - Math.pow(0.85, deltaDays)
      exactTrendKg = prevTrendKg + alpha * (rawKg - prevTrendKg)
    }
    prevTrendKg = exactTrendKg
    prevDate = d

    series.push({
      d,
      rawKg: round(rawKg, 3),
      trendKg: round(exactTrendKg, 3),
      rawDisplay: round(isLb ? rawInput : rawKg, 2),
      trendDisplay: round(isLb ? exactTrendKg / LB_TO_KG : exactTrendKg, 2),
      _exactTrendKg: exactTrendKg,
    })
  }

  return series
}

export function assessGoalCalibration({
  estimatedTdeeKcal,
  goal,
  latestTrendKg = null,
  trainingDaysPerWeek = 3,
  unit = 'kg',
} = {}) {
  if (!goal || goal.targets?.kcal == null || !Number.isFinite(goal.targets.kcal)) return null
  if (!Number.isFinite(estimatedTdeeKcal) || estimatedTdeeKcal <= 0) return null

  const isLb = unit === 'lb'
  const baseKcal = goal.targets.kcal
  const trainKcal = goal.trainingTargets?.kcal
  const trainDays = Math.min(7, Math.max(0, Number(trainingDaysPerWeek) || 0))
  const targetKcal = (trainKcal != null && Number.isFinite(trainKcal) && trainDays > 0)
    ? Math.round(((baseKcal * (7 - trainDays)) + (trainKcal * trainDays)) / 7)
    : Math.round(baseKcal)

  const expectedDailyDeltaKcal = targetKcal - estimatedTdeeKcal
  const expectedWeeklyKgRaw = (expectedDailyDeltaKcal * 7) / KCAL_PER_KG
  const expectedWeeklyKg = round(expectedWeeklyKgRaw, 3)
  const expectedWeeklyDisplay = round(isLb ? expectedWeeklyKgRaw / LB_TO_KG : expectedWeeklyKgRaw, 2)
  const roundTo25 = kcal => Math.max(MIN_TDEE_KCAL, Math.round(kcal / 25) * 25)
  const hasWeight = Number.isFinite(latestTrendKg) && latestTrendKg > 0

  const mode = goal.mode || 'custom'
  let status = 'custom'
  let suggestedKcal = roundTo25(estimatedTdeeKcal)

  if (mode === 'cut') {
    const minLossKg = hasWeight ? latestTrendKg * 0.0025 : 0.2
    const maxLossKg = hasWeight ? latestTrendKg * 0.01 : 0.8
    const targetDeficit = hasWeight
      ? Math.min(750, Math.max(300, (latestTrendKg * 0.005 * KCAL_PER_KG) / 7))
      : 450
    suggestedKcal = roundTo25(estimatedTdeeKcal - targetDeficit)
    if (expectedWeeklyKgRaw > -minLossKg) status = 'too-slow'
    else if (expectedWeeklyKgRaw < -maxLossKg) status = 'too-fast'
    else status = 'well-calibrated'
  } else if (mode === 'bulk') {
    const minGainKg = hasWeight ? latestTrendKg * 0.001 : 0.1
    const maxGainKg = hasWeight ? latestTrendKg * 0.005 : 0.4
    const targetSurplus = hasWeight
      ? Math.min(400, Math.max(175, (latestTrendKg * 0.0028 * KCAL_PER_KG) / 7))
      : 250
    suggestedKcal = roundTo25(estimatedTdeeKcal + targetSurplus)
    if (expectedWeeklyKgRaw < minGainKg) status = 'too-slow'
    else if (expectedWeeklyKgRaw > maxGainKg) status = 'too-fast'
    else status = 'well-calibrated'
  } else if (mode === 'maintenance') {
    suggestedKcal = roundTo25(estimatedTdeeKcal)
    if (Math.abs(expectedWeeklyKgRaw) <= 0.2) status = 'well-calibrated'
    else if (expectedWeeklyKgRaw > 0.2) status = 'above-maintenance'
    else status = 'below-maintenance'
  }

  return {
    mode,
    status,
    targetKcal,
    baseTargetKcal: baseKcal,
    trainingTargetKcal: trainKcal ?? null,
    expectedDailyDeltaKcal,
    expectedWeeklyKg,
    expectedWeeklyDisplay,
    suggestedKcal,
  }
}

export function estimateDynamicTdee({
  nutritionDays = [],
  bodyweight = [],
  unit = 'kg',
  goal = null,
  windowDays = 21,
  endDate = null,
  excludeIncompleteToday = true,
  minDailyKcal = MIN_DAILY_INTAKE_KCAL,
  trainingDaysPerWeek = 3,
} = {}) {
  const isLb = unit === 'lb'
  const effectiveWindowDays = Math.max(14, Math.round(Number(windowDays) || 21))

  let refEndDate = isNutritionDate(endDate) ? endDate : null
  if (!refEndDate) {
    for (const d of [
      ...(nutritionDays ?? []).map(x => x?.d),
      ...(bodyweight ?? []).map(x => x?.d),
    ]) {
      if (isNutritionDate(d) && (!refEndDate || d > refEndDate)) refEndDate = d
    }
  }

  if (!refEndDate) {
    return {
      status: 'insufficient-data',
      requirements: {
        foodDays: 0,
        minFoodDays: MIN_FOOD_DAYS,
        weighIns: 0,
        minWeighIns: MIN_WEIGH_INS,
        spanDays: 0,
        minSpanDays: MIN_SPAN_DAYS,
      },
      windowDays: effectiveWindowDays,
      startDate: null,
      endDate: null,
      unit,
      weightSeries: [],
      averageIntakeKcal: null,
      estimatedTdeeKcal: null,
      confidence: null,
      dailyWeightChangeKg: null,
      weeklyWeightChangeKg: null,
      weeklyWeightChangeDisplay: null,
      latestTrendKg: null,
      latestTrendDisplay: null,
      calibration: null,
    }
  }

  const startDate = addDaysISO(refEndDate, -(effectiveWindowDays - 1))
  const internalSeries = buildWeightTrendSeries(bodyweight, { unit, endDate: refEndDate })
  const weightSeries = internalSeries.map(({ _exactTrendKg, ...pub }) => pub)

  // Deduplicate nutrition days in [startDate, refEndDate]
  const dayByDate = new Map()
  for (const day of nutritionDays ?? []) {
    if (!isNutritionDate(day?.d) || day.d < startDate || day.d > refEndDate) continue
    dayByDate.set(day.d, day)
  }

  let candidateFoodDays = []
  for (const [d, day] of [...dayByDate.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const kcal = day?.totals?.kcal ?? day?.kcal ?? null
    const count = day?.count ?? (kcal != null && kcal > 0 ? 1 : 0)
    if (count > 0 && Number.isFinite(kcal) && kcal >= minDailyKcal) {
      candidateFoodDays.push({ d, kcal })
    }
  }

  if (excludeIncompleteToday && candidateFoodDays.length >= 2) {
    const last = candidateFoodDays[candidateFoodDays.length - 1]
    if (last.d === refEndDate) {
      const prior = candidateFoodDays.slice(0, -1)
      const priorAvg = prior.reduce((s, x) => s + x.kcal, 0) / prior.length
      if (last.kcal < priorAvg * 0.55) {
        candidateFoodDays = prior
      }
    }
  }

  const loggedFoodDays = candidateFoodDays.length
  const avgIntakeExact = loggedFoodDays > 0
    ? candidateFoodDays.reduce((s, x) => s + x.kcal, 0) / loggedFoodDays
    : null
  const averageIntakeKcal = avgIntakeExact != null ? Math.round(avgIntakeExact) : null

  const windowWeighIns = internalSeries.filter(w => w.d >= startDate && w.d <= refEndDate)
  const weighInCount = windowWeighIns.length
  const spanDays = weighInCount >= 2
    ? daysBetween(windowWeighIns[0].d, windowWeighIns[weighInCount - 1].d)
    : 0

  const requirements = {
    foodDays: loggedFoodDays,
    minFoodDays: MIN_FOOD_DAYS,
    weighIns: weighInCount,
    minWeighIns: MIN_WEIGH_INS,
    spanDays,
    minSpanDays: MIN_SPAN_DAYS,
  }

  const latestOverall = internalSeries.at(-1) ?? null

  if (loggedFoodDays < MIN_FOOD_DAYS || weighInCount < MIN_WEIGH_INS || spanDays < MIN_SPAN_DAYS) {
    return {
      status: 'insufficient-data',
      requirements,
      windowDays: effectiveWindowDays,
      startDate,
      endDate: refEndDate,
      unit,
      weightSeries,
      averageIntakeKcal,
      estimatedTdeeKcal: null,
      confidence: null,
      dailyWeightChangeKg: null,
      weeklyWeightChangeKg: null,
      weeklyWeightChangeDisplay: null,
      latestTrendKg: latestOverall?.trendKg ?? null,
      latestTrendDisplay: latestOverall?.trendDisplay ?? null,
      calibration: null,
    }
  }

  const firstWeighIn = windowWeighIns[0]
  const lastWeighIn = windowWeighIns[weighInCount - 1]
  const dailyChangeExact = (lastWeighIn._exactTrendKg - firstWeighIn._exactTrendKg) / spanDays
  const weeklyChangeExact = dailyChangeExact * 7
  const dailyWeightChangeKg = round(dailyChangeExact, 4)
  const weeklyWeightChangeKg = round(weeklyChangeExact, 3)
  const weeklyWeightChangeDisplay = round(isLb ? weeklyChangeExact / LB_TO_KG : weeklyChangeExact, 2)

  const rawTdee = Math.round(avgIntakeExact - dailyChangeExact * KCAL_PER_KG)

  if (!Number.isFinite(rawTdee) || rawTdee < MIN_TDEE_KCAL || rawTdee > MAX_TDEE_KCAL) {
    return {
      status: 'unreliable',
      requirements,
      windowDays: effectiveWindowDays,
      startDate,
      endDate: refEndDate,
      unit,
      weightSeries,
      averageIntakeKcal,
      rawEstimatedTdeeKcal: rawTdee,
      estimatedTdeeKcal: null,
      confidence: null,
      dailyWeightChangeKg,
      weeklyWeightChangeKg,
      weeklyWeightChangeDisplay,
      latestTrendKg: lastWeighIn.trendKg,
      latestTrendDisplay: lastWeighIn.trendDisplay,
      calibration: null,
    }
  }

  const confidence = (loggedFoodDays >= 18 && weighInCount >= 8 && spanDays >= 18) ? 'high' : 'medium'
  const calibration = assessGoalCalibration({
    estimatedTdeeKcal: rawTdee,
    goal,
    latestTrendKg: lastWeighIn.trendKg,
    trainingDaysPerWeek,
    unit,
  })

  return {
    status: 'ready',
    confidence,
    estimatedTdeeKcal: rawTdee,
    averageIntakeKcal,
    dailyWeightChangeKg,
    weeklyWeightChangeKg,
    weeklyWeightChangeDisplay,
    startTrendKg: firstWeighIn.trendKg,
    endTrendKg: lastWeighIn.trendKg,
    latestTrendKg: lastWeighIn.trendKg,
    latestTrendDisplay: lastWeighIn.trendDisplay,
    windowDays: effectiveWindowDays,
    startDate,
    endDate: refEndDate,
    unit,
    requirements,
    weightSeries,
    calibration,
  }
}
