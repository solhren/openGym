import { useMemo, useState } from 'react'
import { Button } from '../../components/ui.jsx'
import LineChart from '../../components/LineChart.jsx'
import { t } from '../../lib/i18n.js'
import { fmtDate } from '../../lib/format.js'
import { historyDays, readNutritionView } from '../../lib/nutrition/ui-service.js'
import { useRead, ErrorNotice, Select, NutrientValues, fmt, labels, GoalStatus } from './common.jsx'

export const shiftDay = (date, offset) => {
  const value = new Date(`${date}T12:00:00Z`); value.setUTCDate(value.getUTCDate() + offset)
  if (value.getUTCFullYear() < 1) return '0001-01-01'
  if (value.getUTCFullYear() > 9999) return '9999-12-31'
  return value.toISOString().slice(0, 10)
}
export function periodOf(date, range) {
  if (range === 'week') return { start: shiftDay(date, -6), end: date }
  const start = `${date.slice(0, 7)}-01`, d = new Date(`${start}T12:00:00Z`)
  d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0)
  return { start, end: d.toISOString().slice(0, 10) }
}
export default function History({ service, status, date, data, openDay }) {
  const [range, setRange] = useState('week'), [metric, setMetric] = useState('kcal'), period = periodOf(date, range)
  const result = useRead(service, status.revision, period, () => readNutritionView(service, { period }))
  const goals = (result.data?.library ?? []).flatMap(p => p.records.nutritionGoals ?? [])
  const days = useMemo(() => result.data ? historyDays(result.data.entries, goals, period.start, period.end) : [], [result.data, period.start, period.end])
  // Missing intake creates a gap, not a false zero. The table remains the accessible chart
  // alternative; unlogged days are distinguished from a fully recorded zero intake.
  // LineChart formats ticks in local time; its presentation timestamps must be local
  // noon too. UTC noon would shift tick labels by a day in UTC+14. Domain ids stay UTC-free.
  const points = useMemo(() => days.filter(d => d.count > 0 && d.totals[metric] != null).map(d => ({ t: new Date(`${d.d}T12:00:00`).getTime(), d: d.d, y: d.totals[metric] })), [days, metric])
  const series = useMemo(() => {
    const segments = []; let current = []
    for (const day of days) {
      if (day.count && day.totals[metric] != null) current.push({ t: new Date(`${day.d}T12:00:00`).getTime(), d: day.d, y: day.totals[metric] })
      else if (current.length) { segments.push({ points: current, color: 'var(--acc)' }); current = [] }
    }
    if (current.length) segments.push({ points: current, color: 'var(--acc)' })
    return segments.length > 1 ? segments : null
  }, [days, metric])
  const logged = days.filter(d => d.count > 0 && d.totals[metric] != null), average = logged.length ? logged.reduce((sum, d) => sum + d.totals[metric], 0) / logged.length : null
  return <><div className="nutrition-grid"><Select label="Period" value={range} onChange={setRange} options={[{ value: 'week', label: t('Last 7 days') }, { value: 'month', label: t('Month') }]} />
    <Select label="Nutrient" value={metric} onChange={setMetric} options={['kcal', 'protein', 'carbs', 'fat'].map(value => ({ value, label: t(labels[value]) }))} /></div>
    <ErrorNotice error={result.error} />{result.error && <Button onClick={result.reload}>{t('Retry')}</Button>}
    {!result.data && !result.error && <p role="status">{t('Loading…')}</p>}
    {result.data && <><section className="card"><h2>{t('Nutrition history')}</h2><p>{t('Average on recorded days')}: {fmt(average)} {metric === 'kcal' ? 'kcal' : 'g'}</p>
      <p className="muted small">{t('Empty days are not treated as a complete food log.')}</p>
      <div aria-hidden="true"><LineChart points={points} series={series} unit={metric === 'kcal' ? 'kcal' : 'g'} /></div></section>
      <ul className="nutrition-list">{days.map(d => <li className="card" key={d.d}><div className="nutrition-row"><Button size="sm" onClick={() => openDay(d.d)}>{fmtDate(d.d, true, true)}</Button>
        <span>{d.count ? t('{0} entries', d.count) : t('No food logged')}</span></div>
        {d.count > 0 && <NutrientValues values={d.totals} />}
        <GoalStatus target={d.goal?.targets[metric]} remaining={d.remaining[metric]} overlapping={d.overlapping} />
      </li>)}</ul></>}
  </>
}
