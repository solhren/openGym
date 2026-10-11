import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Button } from '../components/ui.jsx'
import { t, useLang, dateLocale } from '../lib/i18n.js'
import { todayISO } from '../lib/format.js'
import { useNutrition } from '../lib/nutrition/use-nutrition.jsx'
import { isNutritionDate } from '../lib/nutrition/validate.js'
import { readNutritionView } from '../lib/nutrition/ui-service.js'
import { ErrorNotice, useRead } from './nutrition/common.jsx'
import Journal from './nutrition/Journal.jsx'
import Library from './nutrition/Library.jsx'
import Goals from './nutrition/Goals.jsx'
import History, { shiftDay } from './nutrition/History.jsx'
import Backup from './nutrition/Backup.jsx'
import Conflicts from './nutrition/Conflicts.jsx'
import '../nutrition.css'

const views = { journal: 'Journal', foods: 'Personal foods', recipes: 'Recipes', goals: 'Nutrition goals', history: 'History', backup: 'Backup', conflicts: 'Preserved versions' }
const statuses = { loading: 'Loading…', local: 'Nutrition is saved on this device only', pending: 'Nutrition synchronization pending', syncing: 'Synchronizing Nutrition…', synced: 'Nutrition synchronized', offline: 'Offline: Nutrition changes remain on this device', 'auth-required': 'Sign in again to synchronize Nutrition', unsupported: 'This server does not support Nutrition synchronization', deferred: 'Nutrition synchronization deferred', blocked: 'Nutrition synchronization needs attention', 'session-changed': 'Your session changed. Reopen Nutrition for this account.' }

/** Captures library and journal at the same logical head. Progressive readers verify their
 * selected partitions; a concurrent publication causes retry, never mixed-day totals. */
export async function loadNutritionView(service, date, journal) {
  return readNutritionView(service, { date, includeEntries: journal })
}

export function NutritionScreen({ service, status, startupError }) {
  useLang()
  const nav = useNavigate(), [params, setParams] = useSearchParams(), requested = params.get('view'), view = Object.hasOwn(views, requested) ? requested : 'journal'
  const requestedDate = params.get('date'), date = isNutritionDate(requestedDate) ? requestedDate : todayISO()
  const [createFood, setCreateFood] = useState(false), [actionError, setActionError] = useState(null)
  const needsLibrary = view !== 'backup' && view !== 'conflicts'
  const content = useRead(needsLibrary ? service : null, status.revision, { date, view }, () => loadNutritionView(service, date, view === 'journal'))
  const go = (target, day = date) => { setCreateFood(false); setActionError(null); setParams({ view: target, date: day }) }
  const retry = async () => { setActionError(null); try { await service.refresh(); content.reload() } catch (error) { setActionError(error) } }
  const props = { date, data: content.data, service, status }
  return <div className="narrow nutrition">
    <header className="hdr"><div><h1 tabIndex={-1}>{t('Nutrition')}</h1><p className="sub">{new Date(`${date}T12:00:00`).toLocaleDateString(dateLocale(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</p></div><Button size="sm" onClick={() => nav('/home')}>{t('Home')}</Button></header>
    <nav className="nutrition-nav" aria-label={t('Nutrition navigation')}>{Object.entries(views).map(([key, label]) => <Button size="sm" key={key} variant={view === key ? 'tinted' : 'plain'} aria-current={view === key ? 'page' : undefined} onClick={() => go(key)}>{t(label)}</Button>)}</nav>
    <div className="nutrition-date"><Button size="sm" disabled={date === '0001-01-01'} aria-label={t('Previous day')} onClick={() => go(view, shiftDay(date, -1))}>{t('Prev')}</Button>
      <label><span className="sr-only">{t('Date')}</span><input className="field" type="date" min="0001-01-01" max="9999-12-31" value={date} onChange={e => { if (isNutritionDate(e.target.value)) go(view, e.target.value) }} /></label>
      <Button size="sm" disabled={date === '9999-12-31'} aria-label={t('Next day')} onClick={() => go(view, shiftDay(date, 1))}>{t('Next')}</Button><Button size="sm" onClick={() => go(view, todayISO())}>{t('Today')}</Button></div>
    <section className="nutrition-sync" aria-label={t('Nutrition synchronization')}><p role="status">{t(statuses[status.syncStatus] ?? statuses.blocked)}{status.pending > 0 ? ` · ${t('{0} pending operations', status.pending)}` : ''}{status.busy ? ` · ${t('Saving…')}` : ''}</p>
      {status.conflicts > 0 && <p role="alert">{t('Divergent versions were preserved. Open Preserved versions to review them.')}</p>}
      {service && status.syncStatus !== 'local' && <Button size="sm" disabled={status.busy || status.syncStatus === 'syncing'} onClick={retry}>{t('Retry synchronization')}</Button>}
    </section>
    <ErrorNotice error={startupError ?? actionError ?? status.error ?? content.error} />
    {content.error && <Button onClick={content.reload}>{t('Reload')}</Button>}
    {!service && !startupError && <p role="status">{t('Opening Nutrition storage…')}</p>}
    {service && needsLibrary && !content.data && !content.error && <p role="status">{t('Loading…')}</p>}
    {service && view === 'backup' && <Backup service={service} status={status} />}
    {service && view === 'conflicts' && <Conflicts service={service} status={status} />}
    {content.data?.status === 'recovery-required' ? <p role="alert">{t('Storage needs recovery. Your data has not been erased.')}</p> : service && content.data && <>
      {view === 'journal' && <Journal key={date} {...props} onCreateFood={() => { go('foods'); setCreateFood(true) }} />}
      {(view === 'foods' || view === 'recipes') && <Library key={`${view}:${createFood}`} {...props} kind={view === 'recipes' ? 'recipes' : 'foods'} create={createFood} />}
      {view === 'goals' && <Goals {...props} />}
      {view === 'history' && <History {...props} openDay={day => go('journal', day)} />}
    </>}
  </div>
}
export default function Nutrition() {
  const { service, status, error } = useNutrition()
  return <NutritionScreen key={service?.store.scopeId ?? 'opening'} service={service} status={status} startupError={error} />
}
