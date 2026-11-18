import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '../../components/ui.jsx'
import Icon from '../../components/Icon.jsx'
import LineChart from '../../components/LineChart.jsx'
import { dateLocale, t } from '../../lib/i18n.js'
import { fmtDate } from '../../lib/format.js'
import { useStore } from '../../store/useStore.js'
import { isTrainingDay as detectTrainingDay } from '../../lib/nutrition/training-day.js'
import { estimateDynamicTdee } from '../../lib/nutrition/tdee.js'
import { daySummary, historyDays, readNutritionView } from '../../lib/nutrition/ui-service.js'
import { DEFAULT_WATER_TARGET_ML } from '../../lib/nutrition/meal-helpers.js'
import { shiftDay } from './History.jsx'
import { ErrorNotice, fmt, labels, meals, useRead } from './common.jsx'
import {
  NUTRITION_COLORS,
  CalorieRing,
  MacroDonut,
  MealStackedBar,
  DailyTargetBars,
  QualityGaugeList,
  CalibrationScale,
} from './NutritionCharts.jsx'
import './Bilan.css'

const SNAPSHOT_MACROS = ['protein', 'carbs', 'fat', 'fiber']
const MEAL_ORDER = ['breakfast', 'lunch', 'dinner', 'snack']
const PERIOD_OPTIONS = [
  { days: 7, label: '7d' },
  { days: 30, label: '30d' },
  { days: 90, label: '90d' },
]
const TREND_METRICS = [
  { key: 'kcal', label: 'Calories', unit: 'kcal' },
  { key: 'protein', label: 'Protein', unit: 'g' },
  { key: 'carbs', label: 'Carbohydrates', unit: 'g' },
  { key: 'fat', label: 'Fat', unit: 'g' },
  { key: 'fiber', label: 'Fiber', unit: 'g' },
  { key: 'water', label: 'Water', unit: 'ml' },
]

function computeTargetPercents(activeTargets) {
  if (!activeTargets) return null
  const p = activeTargets.protein
  const c = activeTargets.carbs
  const f = activeTargets.fat
  if (p != null && c != null && f != null) {
    const pKcal = Math.max(0, p) * 4
    const cKcal = Math.max(0, c) * 4
    const fKcal = Math.max(0, f) * 9
    const sum = pKcal + cKcal + fKcal
    if (sum > 0) {
      return {
        protein: Math.round((pKcal / sum) * 100),
        carbs: Math.round((cKcal / sum) * 100),
        fat: Math.round((fKcal / sum) * 100),
      }
    }
  }
  if (activeTargets.kcal != null && activeTargets.kcal > 0 && (p != null || c != null || f != null)) {
    return {
      protein: p != null ? Math.round(((Math.max(0, p) * 4) / activeTargets.kcal) * 100) : null,
      carbs: c != null ? Math.round(((Math.max(0, c) * 4) / activeTargets.kcal) * 100) : null,
      fat: f != null ? Math.round(((Math.max(0, f) * 9) / activeTargets.kcal) * 100) : null,
    }
  }
  return null
}

function mealStatsForDay(dayObj, dayEntries, mealKey, iso) {
  const fromSummary = dayObj?.meals?.[mealKey] ?? dayObj?.byMeal?.[mealKey]
  const candidate = fromSummary?.totals ?? fromSummary
  if (candidate && typeof candidate === 'object' && ('kcal' in candidate || 'protein' in candidate)) {
    return {
      kcal: candidate.kcal ?? 0,
      protein: candidate.protein ?? 0,
    }
  }
  const subset = dayEntries.filter(e => e.d === iso && e.meal === mealKey)
  if (!subset.length) return { kcal: 0, protein: 0 }
  const computed = daySummary(subset, [], iso)
  return {
    kcal: computed.totals.kcal ?? 0,
    protein: computed.totals.protein ?? 0,
  }
}

function calibrationVerdict(cal) {
  if (!cal) return null
  const kcalText = fmt(cal.suggestedKcal)
  if (cal.mode === 'cut') {
    if (cal.status === 'well-calibrated') {
      return t('Your calorie target is well calibrated for a steady, sustainable cut.')
    }
    if (cal.status === 'too-slow') {
      return t('Your current target is close to maintenance — fat loss may be slow. Suggested target: ~{0} kcal/d.', kcalText)
    }
    if (cal.status === 'too-fast') {
      return t('Your deficit is steep — consider ~{0} kcal/d to protect muscle mass and recovery.', kcalText)
    }
  }
  if (cal.mode === 'bulk') {
    if (cal.status === 'well-calibrated') {
      return t('Your calorie surplus is well calibrated for lean muscle gain.')
    }
    if (cal.status === 'too-slow') {
      return t('Your target sits near maintenance — consider ~{0} kcal/d to support steady muscle gain.', kcalText)
    }
    if (cal.status === 'too-fast') {
      return t('Your surplus is high — consider ~{0} kcal/d to limit excess fat gain.', kcalText)
    }
  }
  if (cal.mode === 'maintenance') {
    if (cal.status === 'well-calibrated') {
      return t('Your calorie target aligns closely with your estimated maintenance.')
    }
    if (cal.status === 'above-maintenance') {
      return t('Your target sits above your estimated TDEE — consider ~{0} kcal/d to hold weight steady.', kcalText)
    }
    if (cal.status === 'below-maintenance') {
      return t('Your target sits below your estimated TDEE — consider ~{0} kcal/d to hold weight steady.', kcalText)
    }
  }
  const prefix = cal.expectedDailyDeltaKcal >= 0 ? '+' : ''
  return t('Estimated daily balance: {0} kcal/d vs your Dynamic TDEE.', `${prefix}${fmt(cal.expectedDailyDeltaKcal)}`)
}

export default function Bilan({
  service,
  status,
  date,
  isTrainingDay: isTrainingDayProp,
  openDay,
  openGoals,
  onSuggestKcal,
}) {
  const S = useStore(s => s.S)
  const unit = S?.unit || 'kg'

  const [rangeDays, setRangeDays] = useState(7)
  const [metric, setMetric] = useState('kcal')
  const [plateScope, setPlateScope] = useState('today')
  const [adjustError, setAdjustError] = useState(null)

  useEffect(() => {
    setPlateScope('today')
    setAdjustError(null)
  }, [date])

  const trainingToday = isTrainingDayProp !== undefined
    ? Boolean(isTrainingDayProp)
    : detectTrainingDay(S, date)

  const checkTrainingDay = useCallback(
    d => (d === date && isTrainingDayProp !== undefined ? Boolean(isTrainingDayProp) : detectTrainingDay(S, d)),
    [S, date, isTrainingDayProp]
  )

  const fetchSpan = Math.max(rangeDays, 30)
  const fetchPeriod = useMemo(
    () => ({ start: shiftDay(date, -(fetchSpan - 1)), end: date }),
    [date, fetchSpan]
  )

  const result = useRead(
    service,
    status.revision,
    fetchPeriod,
    () => readNutritionView(service, { period: fetchPeriod })
  )

  // Keep previous period snapshot visible for the same service+date while a wider range (90d) loads
  const lastSnapshotRef = useRef(null)
  if (result.data) {
    lastSnapshotRef.current = { service, date, data: result.data }
  }
  const activeData = result.data ?? (
    lastSnapshotRef.current?.service === service && lastSnapshotRef.current?.date === date
      ? lastSnapshotRef.current.data
      : null
  )

  const goals = useMemo(
    () => (activeData?.library ?? []).flatMap(p => p.records.nutritionGoals ?? []),
    [activeData]
  )
  const entries = activeData?.entries ?? []

  const days28 = useMemo(
    () => (activeData
      ? historyDays(entries, goals, shiftDay(date, -27), date, { isTrainingDay: checkTrainingDay })
      : []),
    [activeData, entries, goals, date, checkTrainingDay]
  )

  const trendDays = useMemo(
    () => (activeData
      ? historyDays(entries, goals, shiftDay(date, -(rangeDays - 1)), date, { isTrainingDay: checkTrainingDay })
      : []),
    [activeData, entries, goals, date, rangeDays, checkTrainingDay]
  )

  const todaySummary = useMemo(
    () => (activeData ? daySummary(entries, goals, date, { isTrainingDay: trainingToday }) : null),
    [activeData, entries, goals, date, trainingToday]
  )

  const trainingDaysPerWeek = useMemo(() => {
    const recent7 = days28.slice(-7)
    const count = recent7.filter(d => d.isTrainingDay).length
    return count > 0 ? count : 3
  }, [days28])

  const tdee = useMemo(
    () => estimateDynamicTdee({
      nutritionDays: days28,
      bodyweight: S?.bodyweight ?? [],
      unit,
      goal: todaySummary?.goal ?? null,
      windowDays: 21,
      endDate: date,
      trainingDaysPerWeek,
    }),
    [days28, S?.bodyweight, unit, todaySummary?.goal, date, trainingDaysPerWeek]
  )

  useEffect(() => {
    if (!onSuggestKcal) return
    if (tdee.status === 'ready') {
      onSuggestKcal(tdee.calibration?.suggestedKcal ?? tdee.estimatedTdeeKcal)
    } else {
      onSuggestKcal(null)
    }
  }, [onSuggestKcal, tdee.status, tdee.calibration?.suggestedKcal, tdee.estimatedTdeeKcal])

  const loggedTrendDays = useMemo(
    () => trendDays.filter(d => d.count > 0),
    [trendDays]
  )

  const donutGrams = useMemo(() => {
    if (!todaySummary) return { protein: 0, carbs: 0, fat: 0 }
    if (plateScope === 'average' && loggedTrendDays.length > 0) {
      const n = loggedTrendDays.length
      return {
        protein: loggedTrendDays.reduce((s, d) => s + (d.totals.protein ?? 0), 0) / n,
        carbs: loggedTrendDays.reduce((s, d) => s + (d.totals.carbs ?? 0), 0) / n,
        fat: loggedTrendDays.reduce((s, d) => s + (d.totals.fat ?? 0), 0) / n,
      }
    }
    return {
      protein: todaySummary.totals.protein ?? 0,
      carbs: todaySummary.totals.carbs ?? 0,
      fat: todaySummary.totals.fat ?? 0,
    }
  }, [todaySummary, plateScope, loggedTrendDays])

  const targetPercents = useMemo(
    () => computeTargetPercents(todaySummary?.activeTargets),
    [todaySummary?.activeTargets]
  )

  const mealItems = useMemo(() => {
    if (!todaySummary) return []
    if (plateScope === 'average' && loggedTrendDays.length > 0) {
      const n = loggedTrendDays.length
      return MEAL_ORDER.map(key => {
        let kcalSum = 0
        let protSum = 0
        for (const d of loggedTrendDays) {
          const st = mealStatsForDay(d, entries, key, d.d)
          kcalSum += st.kcal
          protSum += st.protein
        }
        return {
          key,
          label: t(meals[key]),
          kcal: kcalSum / n,
          protein: protSum / n,
        }
      })
    }
    return MEAL_ORDER.map(key => {
      const st = mealStatsForDay(todaySummary, entries, key, date)
      return {
        key,
        label: t(meals[key]),
        kcal: st.kcal,
        protein: st.protein,
      }
    })
  }, [todaySummary, plateScope, loggedTrendDays, entries, date])

  const weightChartData = useMemo(() => {
    if (!tdee.weightSeries || tdee.weightSeries.length < 2) return null
    const cutoff = shiftDay(date, -(Math.max(rangeDays, 28) - 1))
    const windowed = tdee.weightSeries.filter(w => w.d >= cutoff)
    const rows = windowed.length >= 2 ? windowed : tdee.weightSeries
    const rawPoints = rows.map(w => ({
      t: new Date(`${w.d}T12:00:00`).getTime(),
      d: w.d,
      y: w.rawDisplay,
    }))
    const trendPoints = rows.map(w => ({
      t: new Date(`${w.d}T12:00:00`).getTime(),
      d: w.d,
      y: w.trendDisplay,
      note: `${t('Raw')}: ${fmt(w.rawDisplay)} ${unit} · ${t('Trend')}: ${fmt(w.trendDisplay)} ${unit}`,
    }))
    return {
      anchorPoints: trendPoints,
      series: [
        { points: rawPoints, color: 'rgba(148, 163, 184, 0.45)' },
        { points: trendPoints, color: 'var(--acc)' },
      ],
    }
  }, [tdee.weightSeries, date, rangeDays, unit])

  const activeMetricMeta = TREND_METRICS.find(m => m.key === metric) ?? TREND_METRICS[0]
  const metricUnit = activeMetricMeta.unit
  const locale = dateLocale()

  const barDays = useMemo(() => trendDays.map(d => {
    const label = new Date(`${d.d}T12:00:00`).toLocaleDateString(locale, {
      day: 'numeric',
      month: 'short',
    })
    const value = metric === 'water'
      ? ((d.waterEntries?.length ?? 0) > 0 || d.waterMl > 0 || d.count > 0 ? d.waterMl : null)
      : (d.count > 0 && d.totals[metric] != null ? d.totals[metric] : null)
    const target = d.overlapping
      ? null
      : metric === 'water'
        ? d.waterTargetMl
        : (d.activeTargets?.[metric] ?? null)
    return {
      d: d.d,
      label,
      value,
      target,
      isTrainingDay: d.isTrainingDay,
    }
  }), [trendDays, metric, locale])

  const consistency = useMemo(() => {
    const loggedMetric = barDays.filter(d => d.value != null)
    const average = loggedMetric.length > 0
      ? loggedMetric.reduce((s, d) => s + d.value, 0) / loggedMetric.length
      : null

    const protDays = loggedTrendDays.filter(d => !d.overlapping && d.activeTargets?.protein != null)
    const protHit = protDays.filter(d => (d.totals.protein ?? 0) >= d.activeTargets.protein).length
    const proteinPct = protDays.length > 0 ? Math.round((protHit / protDays.length) * 100) : null

    const kcalDays = loggedTrendDays.filter(d => !d.overlapping && d.activeTargets?.kcal != null && d.activeTargets.kcal > 0)
    const kcalHit = kcalDays.filter(d => {
      const target = d.activeTargets.kcal
      return Math.abs((d.totals.kcal ?? 0) - target) <= target * 0.1
    }).length
    const kcalPct = kcalDays.length > 0 ? Math.round((kcalHit / kcalDays.length) * 100) : null

    return {
      average,
      protein: proteinPct != null ? { pct: proteinPct, hit: protHit, total: protDays.length } : null,
      kcal: kcalPct != null ? { pct: kcalPct, hit: kcalHit, total: kcalDays.length } : null,
    }
  }, [barDays, loggedTrendDays])

  if (result.error) {
    return (
      <>
        <ErrorNotice error={result.error} />
        <Button onClick={result.reload}>{t('Retry')}</Button>
      </>
    )
  }

  if (!activeData || !todaySummary) {
    return <p role="status">{t('Loading…')}</p>
  }

  const waterMl = todaySummary.waterMl ?? 0
  const waterTargetMl = todaySummary.waterTargetMl ?? DEFAULT_WATER_TARGET_ML
  const waterPct = waterTargetMl > 0 ? Math.min(100, Math.round((waterMl / waterTargetMl) * 100)) : 0
  const hasTrainingOverridesActive = Boolean(
    trainingToday &&
    todaySummary.goal?.trainingTargets &&
    Object.values(todaySummary.goal.trainingTargets).some(v => v != null)
  )

  const cal = tdee.calibration
  const canAdjustGoal = Boolean(
    tdee.status === 'ready' &&
    cal &&
    todaySummary.goal &&
    cal.suggestedKcal != null &&
    cal.suggestedKcal !== todaySummary.goal.targets?.kcal &&
    ['too-slow', 'too-fast', 'above-maintenance', 'below-maintenance'].includes(cal.status)
  )

  const handleAdjustGoal = async () => {
    if (!canAdjustGoal || status.busy) return
    setAdjustError(null)
    try {
      await service.save('nutritionGoals', {
        ...todaySummary.goal,
        targets: { ...todaySummary.goal.targets, kcal: cal.suggestedKcal },
      }, todaySummary.goal)
    } catch (err) {
      setAdjustError(err)
    }
  }

  const qualityItems = [
    {
      key: 'fiber',
      label: t(labels.fiber),
      kind: 'min',
      value: todaySummary.count > 0 ? todaySummary.totals.fiber : 0,
      target: todaySummary.activeTargets?.fiber ?? null,
      unit: 'g',
    },
    {
      key: 'sugar',
      label: t(labels.sugar),
      kind: 'max',
      value: todaySummary.count > 0 ? todaySummary.totals.sugar : 0,
      target: todaySummary.activeTargets?.sugar ?? null,
      unit: 'g',
    },
    {
      key: 'saturatedFat',
      label: t(labels.saturatedFat),
      kind: 'max',
      value: todaySummary.count > 0 ? todaySummary.totals.saturatedFat : 0,
      target: todaySummary.activeTargets?.saturatedFat ?? null,
      unit: 'g',
    },
    {
      key: 'sodium',
      label: t(labels.sodium),
      kind: 'max',
      value: todaySummary.count > 0 ? todaySummary.totals.sodium : 0,
      target: todaySummary.activeTargets?.sodium ?? null,
      unit: 'g',
    },
  ]

  const recordedDaysCount = trendDays.filter(d => d.count > 0 || d.waterMl > 0).length
  const req = tdee.requirements

  return (
    <div className="bilan-stack">
      {/* Section 1 — Today's Snapshot */}
      <section className="card bilan-card" data-bilan-section="snapshot">
        <div className="bilan-card-header">
          <h2>{t("Today's overview")}</h2>
          <div className="bilan-header-actions">
            <span
              className={`bilan-day-badge ${trainingToday ? 'is-training' : 'is-rest'}`}
              data-day-badge={trainingToday ? 'training' : 'rest'}
            >
              <Icon name={trainingToday ? 'dumbbell' : 'moon'} size={14} />
              <span>{trainingToday ? t('Training day') : t('Rest day')}</span>
            </span>
            {openGoals && (
              <Button size="sm" variant="plain" onClick={openGoals}>
                {t('Goals')}
              </Button>
            )}
          </div>
        </div>

        <div className="bilan-snapshot-grid">
          <div className="bilan-ring-col">
            <CalorieRing
              consumed={todaySummary.totals.kcal ?? 0}
              target={todaySummary.activeTargets?.kcal}
              remaining={todaySummary.remaining?.kcal}
            />
            {todaySummary.overlapping && (
              <p className="bilan-ring-caption">{t('Overlapping goals')}</p>
            )}
            {!todaySummary.overlapping && !todaySummary.goal && (
              <p className="bilan-ring-caption">{t('No goal defined')}</p>
            )}
            {hasTrainingOverridesActive && (
              <span className="bilan-active-mode-chip">{t('Training targets active')}</span>
            )}
          </div>

          <div className="bilan-macros-col">
            {SNAPSHOT_MACROS.map(k => {
              const consumed = todaySummary.totals[k] ?? 0
              const target = todaySummary.activeTargets?.[k] ?? null
              const hasTarget = target != null && target > 0
              const pct = hasTarget
                ? Math.min(100, Math.round((Math.max(0, consumed) / target) * 100))
                : (consumed > 0 ? 32 : 0)
              const isOver = hasTarget && consumed > target * 1.05
              return (
                <div className="bilan-macro-row" key={k} data-macro-row={k}>
                  <div className="bilan-macro-line">
                    <span className="bilan-macro-label">
                      <span
                        className="bilan-macro-dot"
                        style={{ background: NUTRITION_COLORS[k] }}
                        aria-hidden="true"
                      />
                      {t(labels[k])}
                    </span>
                    <span className={`bilan-macro-val${isOver ? ' is-over' : ''}`}>
                      <strong>{fmt(consumed)}</strong>
                      {target != null ? ` / ${fmt(target)}` : ''} g
                    </span>
                  </div>
                  <div
                    className="bilan-bar-track"
                    role="progressbar"
                    aria-label={t(labels[k])}
                    aria-valuemin={0}
                    aria-valuemax={hasTarget ? target : undefined}
                    aria-valuenow={Math.round(consumed * 10) / 10}
                  >
                    <div
                      className="bilan-bar-fill"
                      style={{
                        width: `${pct}%`,
                        background: NUTRITION_COLORS[k],
                        opacity: hasTarget ? 1 : 0.55,
                      }}
                    />
                  </div>
                </div>
              )
            })}

            <div className="bilan-hydration-box" data-hydration-gauge="true">
              <div className="bilan-macro-line">
                <span className="bilan-macro-label">
                  <span aria-hidden="true">💧</span>
                  {t('Water')}
                </span>
                <span className="bilan-macro-val">
                  <strong>{fmt(waterMl)}</strong>
                  {waterTargetMl != null ? ` / ${fmt(waterTargetMl)}` : ''} ml
                </span>
              </div>
              <div
                className="bilan-bar-track"
                role="progressbar"
                aria-label={t('Water')}
                aria-valuemin={0}
                aria-valuemax={waterTargetMl ?? undefined}
                aria-valuenow={Math.round(waterMl)}
              >
                <div
                  className="bilan-bar-fill"
                  style={{
                    width: `${waterPct}%`,
                    background: NUTRITION_COLORS.water,
                  }}
                />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Section 2 — Plate & Meal Breakdown */}
      <section className="card bilan-card" data-bilan-section="distribution">
        <div className="bilan-card-header">
          <h2>{t('Macro & meal distribution')}</h2>
          {loggedTrendDays.length > 0 && (
            <div className="bilan-pills" role="group" aria-label={t('Distribution scope')}>
              <button
                type="button"
                className="bilan-pill"
                aria-pressed={plateScope === 'today'}
                onClick={() => setPlateScope('today')}
              >
                {t('Today')}
              </button>
              <button
                type="button"
                className="bilan-pill"
                aria-pressed={plateScope === 'average'}
                onClick={() => setPlateScope('average')}
              >
                {t('Period average')}
              </button>
            </div>
          )}
        </div>

        {plateScope === 'today' && (todaySummary.totals.kcal ?? 0) <= 0 && (
          <p className="bilan-note">
            {loggedTrendDays.length > 0
              ? t('No food logged on this day — switch to Period average to inspect your typical split.')
              : t('Log a meal in your Journal to unlock macro and meal energy breakdown.')}
          </p>
        )}

        <MacroDonut
          grams={donutGrams}
          targetPercents={targetPercents}
          labels={{
            protein: t(labels.protein),
            carbs: t(labels.carbs),
            fat: t(labels.fat),
          }}
        />

        <div className="bilan-subblock">
          <h3 className="bilan-subtitle">{t('Meal breakdown')}</h3>
          <MealStackedBar meals={mealItems} />
        </div>
      </section>

      {/* Section 3 — Dynamic TDEE & Metabolism */}
      <section className="card bilan-card" data-bilan-section="tdee" data-tdee-status={tdee.status}>
        <div className="bilan-card-header">
          <h2>{t('Dynamic TDEE & calibration')}</h2>
          {tdee.status === 'ready' && tdee.confidence && (
            <span className="bilan-day-badge is-rest">
              {tdee.confidence === 'high' ? t('High confidence') : t('Medium confidence')}
            </span>
          )}
        </div>

        {tdee.status === 'ready' && (
          <>
            <div className="bilan-tdee-tiles">
              <div className="bilan-metric-tile" data-tdee-tile="estimated">
                <span className="bilan-metric-label">{t('Estimated TDEE')}</span>
                <span className="bilan-metric-value">
                  {fmt(tdee.estimatedTdeeKcal)} <span className="bilan-metric-unit">kcal/d</span>
                </span>
              </div>
              <div className="bilan-metric-tile" data-tdee-tile="intake">
                <span className="bilan-metric-label">{t('Average intake')}</span>
                <span className="bilan-metric-value">
                  {fmt(Math.round(tdee.averageIntakeKcal))} <span className="bilan-metric-unit">kcal/d</span>
                </span>
              </div>
              <div className="bilan-metric-tile" data-tdee-tile="trend">
                <span className="bilan-metric-label">{t('Weight trend')}</span>
                <span className="bilan-metric-value">
                  {tdee.weeklyWeightChangeDisplay >= 0 ? '+' : ''}
                  {fmt(tdee.weeklyWeightChangeDisplay)} <span className="bilan-metric-unit">{unit}/wk</span>
                </span>
              </div>
            </div>

            {cal ? (
              <>
                {['cut', 'bulk', 'maintenance'].includes(cal.mode) && (
                  <CalibrationScale
                    status={
                      cal.status === 'above-maintenance'
                        ? 'too-fast'
                        : cal.status === 'below-maintenance'
                          ? 'too-slow'
                          : cal.status
                    }
                    mode={cal.mode}
                    dailyDeltaKcal={cal.expectedDailyDeltaKcal}
                    weeklyKg={cal.expectedWeeklyKg}
                    label={t('Goal calibration')}
                  />
                )}
                <div className="bilan-verdict-box" data-calibration-verdict={cal.status}>
                  <p>{calibrationVerdict(cal)}</p>
                  {canAdjustGoal && (
                    <div>
                      <Button
                        size="sm"
                        variant="tinted"
                        disabled={status.busy}
                        onClick={handleAdjustGoal}
                      >
                        {t('Adjust goal to {0} kcal', cal.suggestedKcal)}
                      </Button>
                    </div>
                  )}
                  <ErrorNotice error={adjustError} />
                </div>
              </>
            ) : (
              <div className="bilan-verdict-box">
                <p>
                  {t('Set a calorie goal to compare your planned pace against your estimated TDEE ({0} kcal/d).', fmt(tdee.estimatedTdeeKcal))}
                </p>
                {openGoals && (
                  <div>
                    <Button size="sm" variant="tinted" onClick={openGoals}>
                      {t('Create nutrition goal')}
                    </Button>
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {tdee.status === 'insufficient-data' && req && (
          <div className="bilan-unlock-card" data-tdee-unlock="true">
            <p className="bilan-note">
              {t('Log nutrition and body weight over 2–3 weeks to unlock your personalized Dynamic TDEE.')}
            </p>

            <div className="bilan-unlock-req" data-unlock-req="food">
              <div className="bilan-macro-line">
                <span className="bilan-macro-label">{t('Logged nutrition days')}</span>
                <span className="bilan-macro-val">
                  <strong>{req.foodDays}</strong> / {req.minFoodDays} {t('days')}
                </span>
              </div>
              <div
                className="bilan-bar-track"
                role="progressbar"
                aria-label={t('Logged nutrition days')}
                aria-valuemin={0}
                aria-valuemax={req.minFoodDays}
                aria-valuenow={req.foodDays}
              >
                <div
                  className="bilan-bar-fill"
                  style={{
                    width: `${Math.min(100, Math.round((req.foodDays / req.minFoodDays) * 100))}%`,
                    background: 'var(--acc)',
                  }}
                />
              </div>
            </div>

            <div className="bilan-unlock-req" data-unlock-req="weight">
              <div className="bilan-macro-line">
                <span className="bilan-macro-label">{t('Body-weight entries')}</span>
                <span className="bilan-macro-val">
                  <strong>{req.weighIns}</strong> / {req.minWeighIns} {t('weigh-ins')} ({req.spanDays}/{req.minSpanDays}d)
                </span>
              </div>
              <div
                className="bilan-bar-track"
                role="progressbar"
                aria-label={t('Body-weight entries')}
                aria-valuemin={0}
                aria-valuemax={req.minWeighIns}
                aria-valuenow={req.weighIns}
              >
                <div
                  className="bilan-bar-fill"
                  style={{
                    width: `${Math.min(100, Math.round((req.weighIns / req.minWeighIns) * 100))}%`,
                    background: NUTRITION_COLORS.protein,
                  }}
                />
              </div>
            </div>
          </div>
        )}

        {tdee.status === 'unreliable' && (
          <div className="bilan-verdict-box">
            <p>
              {t('Recent intake or weight fluctuations are too wide for a reliable TDEE estimate yet. Keep logging steadily.')}
            </p>
          </div>
        )}

        {weightChartData && (
          <div className="bilan-subblock" data-weight-trend-chart="true">
            <div className="bilan-chart-legend">
              <span className="bilan-subtitle">{t('Body-weight trend')}</span>
              <span className="bilan-legend-items">
                <span className="bilan-legend-item">
                  <span
                    className="bilan-legend-swatch"
                    style={{ background: 'rgba(148, 163, 184, 0.7)' }}
                    aria-hidden="true"
                  />
                  {t('Raw weigh-ins')}
                </span>
                <span className="bilan-legend-item">
                  <span
                    className="bilan-legend-swatch"
                    style={{ background: 'var(--acc)' }}
                    aria-hidden="true"
                  />
                  {t('EWMA trend')}
                </span>
              </span>
            </div>
            <LineChart
              points={weightChartData.anchorPoints}
              series={weightChartData.series}
              unit={unit}
            />
          </div>
        )}
      </section>

      {/* Section 4 — Trends & Consistency */}
      <section className="card bilan-card" data-bilan-section="trends">
        <div className="bilan-card-header">
          <h2>{t('Trends & consistency')}</h2>
          <div className="bilan-pills" role="group" aria-label={t('Period')}>
            {PERIOD_OPTIONS.map(opt => (
              <button
                key={opt.days}
                type="button"
                className="bilan-pill"
                aria-pressed={rangeDays === opt.days}
                onClick={() => setRangeDays(opt.days)}
              >
                {t(opt.label)}
              </button>
            ))}
          </div>
        </div>

        <div className="bilan-pills" role="group" aria-label={t('Nutrient')}>
          {TREND_METRICS.map(m => (
            <button
              key={m.key}
              type="button"
              className="bilan-pill"
              aria-pressed={metric === m.key}
              onClick={() => setMetric(m.key)}
            >
              {t(m.label)}
            </button>
          ))}
        </div>

        <DailyTargetBars
          days={barDays}
          metric={metric}
          unit={metricUnit}
          color={NUTRITION_COLORS[metric]}
          onSelectDay={openDay}
        />

        <div className="bilan-consistency-strip" data-consistency-strip="true">
          <div className="bilan-metric-tile">
            <span className="bilan-metric-label">{t('Average on recorded days')}</span>
            <span className="bilan-metric-value">
              {consistency.average != null ? (
                <>
                  {fmt(consistency.average)} <span className="bilan-metric-unit">{metricUnit}</span>
                </>
              ) : '—'}
            </span>
          </div>
          <div className="bilan-metric-tile">
            <span className="bilan-metric-label">{t('Protein target hit')}</span>
            <span className="bilan-metric-value">
              {consistency.protein != null ? (
                <>
                  {consistency.protein.pct}%{' '}
                  <span className="bilan-metric-unit">
                    ({consistency.protein.hit}/{consistency.protein.total})
                  </span>
                </>
              ) : '—'}
            </span>
          </div>
          <div className="bilan-metric-tile">
            <span className="bilan-metric-label">{t('Within ±10% kcal')}</span>
            <span className="bilan-metric-value">
              {consistency.kcal != null ? (
                <>
                  {consistency.kcal.pct}%{' '}
                  <span className="bilan-metric-unit">
                    ({consistency.kcal.hit}/{consistency.kcal.total})
                  </span>
                </>
              ) : '—'}
            </span>
          </div>
        </div>
      </section>

      {/* Section 5 — Food Quality & Collapsible Daily Log */}
      <section className="card bilan-card" data-bilan-section="quality">
        <div className="bilan-card-header">
          <h2>{t('Food quality & micronutrients')}</h2>
        </div>
        <QualityGaugeList items={qualityItems} />
      </section>

      <details className="card bilan-daily-log" data-bilan-section="daily-log">
        <summary>
          <span>{t('Daily log ({0} days)', trendDays.length)}</span>
          <span className="muted small">{t('{0} recorded', recordedDaysCount)}</span>
        </summary>
        <ul className="bilan-daily-log-list">
          {[...trendDays].reverse().map(d => (
            <li className="bilan-daily-log-item" key={d.d}>
              <Button size="sm" onClick={() => openDay?.(d.d)}>
                {fmtDate(d.d, true, true)}
              </Button>
              <span className="bilan-daily-log-meta">
                <span>{d.isTrainingDay ? '🏋️' : '🌙'}</span>
                <span>{d.count ? t('{0} entries', d.count) : t('No food logged')}</span>
                {d.count > 0 && (
                  <span>
                    <strong>{fmt(d.totals.kcal ?? 0)} kcal</strong> · {fmt(d.totals.protein ?? 0)} g P
                  </span>
                )}
                {d.waterMl > 0 && <span>💧 {fmt(d.waterMl)} ml</span>}
              </span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  )
}
