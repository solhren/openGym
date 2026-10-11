import { useEffect, useRef, useState } from 'react'
import { Button, TextField } from '../../components/ui.jsx'
import { dateLocale, t } from '../../lib/i18n.js'
import { NUTRIENTS } from '../../lib/nutrition/contracts.js'
import { quantityOptions, quantityValue } from '../../lib/nutrition/ui-service.js'
import { canonicalJson } from '../../lib/nutrition/persistence-contract.js'

export const labels = { kcal: 'Calories', protein: 'Protein', carbs: 'Carbohydrates', fat: 'Fat', fiber: 'Fiber', sugar: 'Sugar', saturatedFat: 'Saturated fat', sodium: 'Sodium' }
export const meals = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snack: 'Snacks' }
export const fmt = n => n == null ? t('Unknown') : new Intl.NumberFormat(dateLocale(), { maximumFractionDigits: 1 }).format(n)
/** Presentation only: remaining values come from the engine. Zero is a defined target;
 * unknown intake and overlapping goals must not become a false exceedance. */
export function GoalStatus({ target, remaining, overlapping = false, children }) {
  if (overlapping) return <p className="muted">{t('Overlapping goals')}</p>
  if (target == null) return <p className="muted">{t('No goal defined')}</p>
  return <><p>{t('Goal')}: {fmt(target)}</p>{children}
    <p className={remaining < 0 ? 'nutrition-goal-over' : undefined}>{remaining == null ? t('Remaining value unavailable') : remaining < 0 ? t('{0} over goal', fmt(-remaining)) : t('{0} remaining', fmt(remaining))}</p>
  </>
}
export function errorText(error) {
  const codes = error?.issues?.map(i => i.code) ?? []
  if (codes.includes('server_mount_scope_mismatch')) return t('This Nutrition storage belongs to another server installation. Open the original installation or use a separate account.')
  if (codes.includes('legacy_mount_scope_requires_transfer')) return t('Existing Nutrition data cannot be assigned safely to this server path. Keep it and request an explicit transfer.')
  if (codes.includes('target_required')) return t('Enter at least one nutrition target.')
  if (codes.includes('positive_number_required')) return t('Quantities, yields and density must be greater than zero.')
  if (codes.includes('exceeds_parent_nutrient')) return t('Sugar cannot exceed carbohydrates; saturated fat cannot exceed fat.')
  if (codes.includes('exceeds_reference_mass')) return t('Nutrient grams cannot exceed the reference weight.')
  if (error?.name === 'QuotaExceededError' || codes.some(c => c.includes('quota') || c.includes('space'))) return t('Storage is full. Export a backup before freeing space.')
  if (codes.some(c => ['record_changed', 'stale_root', 'stale_restore_preview', 'read_invalidated'].includes(c))) return t('Data changed elsewhere. Reload and review before saving.')
  if (codes.some(c => c.includes('session') || c.includes('auth'))) return t('Your session changed. Reopen Nutrition for this account.')
  if (codes.some(c => c.includes('recovery') || c.includes('checksum') || c.includes('missing_partition'))) return t('Storage needs recovery. Your data has not been erased.')
  if (codes.some(c => c.includes('large') || c.includes('limit'))) return t('The data exceeds the supported size. No changes were applied.')
  return t('Unable to complete this action. Check the values and try again.')
}
export const ErrorNotice = ({ error }) => error ? <p className="nutrition-error" role="alert">{errorText(error)}</p> : null
export const Field = ({ label, children }) => <label className="nutrition-field"><span>{t(label)}</span>{children}</label>
export function Decimal({ label, value, onChange, required = false }) {
  return <Field label={label}><TextField inputMode="decimal" value={value} onChange={e => onChange(e.target.value)} required={required} maxLength={24} /></Field>
}
export function Select({ label, value, onChange, options, disabled = false }) {
  return <Field label={label}><select className="field" value={value} disabled={disabled} onChange={e => onChange(e.target.value)}>{options.map(o => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}</select></Field>
}
export function NutrientFields({ values, setValues }) {
  return <><p className="muted small">{t('Empty nutrient values stay unknown. All nutrients except calories are in grams.')}</p>
    <div className="nutrition-grid">{NUTRIENTS.map(k => <Decimal key={k} label={labels[k]} value={values[k] ?? ''} onChange={v => setValues({ ...values, [k]: v })} />)}</div></>
}
export function NutrientValues({ values }) {
  return <dl className="nutrition-values">{['kcal', 'protein', 'carbs', 'fat'].map(k => <div key={k}><dt>{t(labels[k])}</dt><dd>{fmt(values[k])} {k === 'kcal' ? 'kcal' : 'g'}</dd></div>)}</dl>
}
export function QuantityFields({ snapshot, amount, setAmount, option, setOption }) {
  const options = quantityOptions(snapshot).map(value => ({ value,
    label: value.startsWith('portion:') ? snapshot.portions.find(p => `portion:${p.id}` === value)?.label : value === 'serving' ? t('Servings') : value }))
  // Removing a default portion or changing compatible units must not let a select
  // visually show its first valid option while the draft still has an invalid one.
  if (!options.some(item => item.value === option)) options.unshift({ value: option, label: t('Choose a compatible unit'), disabled: true })
  return <div className="nutrition-grid"><Decimal label="Quantity" value={amount} onChange={setAmount} required />
    <Select label="Unit" value={option} onChange={setOption} options={options} /></div>
}
export const quantityText = (snapshot, q) => `${fmt(q.amount)} ${q.unit === 'portion' ? snapshot.portions.find(p => p.id === q.portionId)?.label : q.unit === 'serving' ? t('Servings') : q.unit}`
export const formQuantity = q => ({ amount: String(q.amount), option: q.unit === 'portion' ? `portion:${q.portionId}` : q.unit })
export { quantityValue }

/** Inline editor: focus moves to its first field, Escape cancels, and closing restores
 * the invoker if it still exists. No hidden modal or focus trap is needed. */
export function Editor({ title, close, onSave, busy, children }) {
  const ref = useRef(null), saving = useRef(false), alive = useRef(true), [error, setError] = useState(null)
  useEffect(() => {
    const invoker = document.activeElement
    const pane = ref.current?.closest('.nutrition')
    ref.current?.querySelector('input, select, button')?.focus()
    alive.current = true
    return () => {
      alive.current = false
      if (invoker?.isConnected && invoker !== document.body) invoker.focus()
      else requestAnimationFrame(() => { if (pane?.isConnected) pane.querySelector('h1')?.focus({ preventScroll: true }) })
    }
  }, [])
  const submit = async e => {
    e.preventDefault()
    if (saving.current || busy) return
    saving.current = true; setError(null)
    try { await onSave(); if (alive.current) close() } catch (failure) { if (alive.current) setError(failure) }
    finally { saving.current = false }
  }
  return <section className="card nutrition-editor" aria-label={t(title)} ref={ref} onKeyDown={e => { if (e.key === 'Escape' && !busy && !saving.current) { e.stopPropagation(); close() } }}>
    <h2>{t(title)}</h2><form onSubmit={submit}><fieldset disabled={busy}>{children}
      <ErrorNotice error={error} /><div className="nutrition-actions"><Button variant="primary" type="submit" disabled={busy}>{busy ? t('Saving…') : t('Save')}</Button>
        <Button type="button" onClick={close} disabled={busy}>{t('Cancel')}</Button></div></fieldset></form></section>
}
export function DeleteAction({ name, remove, busy }) {
  const [confirm, setConfirm] = useState(false), [error, setError] = useState(null), pending = useRef(false)
  return <>{confirm ? <div className="nutrition-confirm"><p>{t('Delete {0}? Historical food snapshots are preserved.', name)}</p>
    <Button variant="danger" disabled={busy} onClick={async () => { if (pending.current) return; pending.current = true; setError(null); try { await remove(); setConfirm(false) } catch (e) { setError(e) } finally { pending.current = false } }}>{t('Delete')}</Button>
    <Button disabled={busy} onClick={() => setConfirm(false)}>{t('Cancel')}</Button></div> : <Button size="sm" disabled={busy} onClick={() => setConfirm(true)} aria-label={t('Delete {0}', name)}>{t('Delete')}</Button>}
    <ErrorNotice error={error} /></>
}
export function useRead(service, revision, descriptor, load) {
  const key = canonicalJson(descriptor), [result, setResult] = useState(null), [retry, setRetry] = useState(0)
  useEffect(() => {
    let active = true
    if (service) load().then(data => { if (active) setResult({ service, key, data }) }, error => { if (active) setResult({ service, key, error }) })
    return () => { active = false }
  }, [service, revision, key, retry])
  const owned = result?.service === service && result?.key === key ? result : null
  return { data: owned?.data ?? null, error: owned?.error ?? null, reload: () => setRetry(n => n + 1) }
}
