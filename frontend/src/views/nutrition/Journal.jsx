import { useMemo, useState } from 'react'
import Icon from '../../components/Icon.jsx'
import { Button, SearchField, TextField } from '../../components/ui.jsx'
import { t, dateLocale } from '../../lib/i18n.js'
import { MEALS } from '../../lib/nutrition/contracts.js'
import { nutrientsForQuantity, macroEnergy, sumFoodEntries } from '../../lib/nutrition/calculate.js'
import { createRecipeSnapshot } from '../../lib/nutrition/recipe.js'
import { daySummary, newNutritionId, nutritionSearchText, editedQuantity } from '../../lib/nutrition/ui-service.js'
import { Editor, Field, Select, QuantityFields, NutrientValues, formQuantity, quantityValue, fmt, meals, labels, quantityText, DeleteAction, useRead, ErrorNotice, GoalStatus, FoodSource } from './common.jsx'
import { shiftDay } from './History.jsx'
import FoodCatalog from './FoodCatalog.jsx'

export function IntakeIndicators({ summary }) {
  const distribution = macroEnergy(summary.totals)
  return <section className="card nutrition-summary" aria-label={t('Daily nutrition')}>
    {summary.overlapping && <p role="alert">{t('Several goals cover this day. Edit their periods to choose one.')}</p>}
    <div className="nutrition-indicators">{['kcal', 'protein', 'carbs', 'fat'].map(k => {
      const value = summary.totals[k], target = summary.goal?.targets[k], remaining = summary.remaining[k]
      return <div key={k} className={`nutrition-indicator nutrition-indicator-${k}`}><div className="nutrition-metric-label"><h2>{t(labels[k])}</h2>{k === 'kcal' && <Icon name="flame" />}</div><strong>{fmt(value)} <small>{k === 'kcal' ? 'kcal' : 'g'}</small></strong>
        <GoalStatus target={target} remaining={remaining} overlapping={summary.overlapping}>
          {target > 0 && value != null && <progress max={target} value={Math.min(target, value)} aria-label={t(labels[k])} />}
        </GoalStatus>
        {summary.missing[k] > 0 && <p className="muted small">{t('{0} entries have unknown values; known subtotal: {1}', summary.missing[k], fmt(summary.knownTotals[k]))}</p>}
      </div>
    })}</div>
    {distribution.totalKcal != null && distribution.totalKcal > 0 && <details className="nutrition-breakdown"><summary>{t('Details')}</summary><p className="muted small">{t('Macro energy distribution (4/4/9)')}: {['protein', 'carbs', 'fat'].map(k => `${t(labels[k])} ${fmt(distribution.percent[k])}%`).join(' · ')}</p></details>}
  </section>
}

export function EntryEditor({ source, snapshot, date, meal, service, status, close }) {
  const [id] = useState(() => source?.id ?? newNutritionId()), food = source?.snapshot ?? snapshot
  const initial = formQuantity(source?.quantity ?? food.defaultQuantity ?? { amount: food.kind === 'recipe' ? 1 : food.reference.amount, unit: food.kind === 'recipe' ? 'serving' : food.reference.unit })
  const [amount, setAmount] = useState(initial.amount), [option, setOption] = useState(initial.option), [targetMeal, setMeal] = useState(source?.meal ?? meal)
  const saveEntry = entry => {
    const catalogFood = food.source?.kind === 'open-food-facts' || ['wger','ciqual'].includes(food.source?.publicCatalogImport?.provider)
    if (source || !catalogFood) return service.save('foodEntries', entry, source ?? null)
    // Identical saved revisions are no-ops; durable food + intake are one publication.
    return service.batch([{ collection: 'savedFoods', id: food.id, value: food, base: null }, { collection: 'foodEntries', id: entry.id, value: entry, base: null }])
  }
  const [note, setNote] = useState(source?.note ?? '')
  let values = null
  try { values = nutrientsForQuantity(food, quantityValue(amount, option)) } catch { /* draft */ }
  return <Editor title={source ? 'Edit food entry' : 'Add food to journal'} close={close} busy={status.busy} onSave={() => saveEntry({
    ...(source ?? {}), schemaVersion: 1, id, d: source?.d ?? date, meal: targetMeal, snapshot: food,
    quantity: editedQuantity(source?.quantity, amount, option), note,
  })}>
    <h3>{food.name}</h3><FoodSource food={food} /><QuantityFields snapshot={food} amount={amount} setAmount={setAmount} option={option} setOption={setOption} />
    <Select label="Meal" value={targetMeal} onChange={setMeal} options={MEALS.map(value => ({ value, label: t(meals[value]) }))} />
    <Field label="Note"><TextField value={note} onChange={e => setNote(e.target.value)} maxLength={1000} /></Field>
    {values && <NutrientValues values={values} />}
  </Editor>
}

export default function Journal({ date, data, service, status, onCreateFood, initialMeal = 'breakfast' }) {
  const locale = dateLocale()
  const [addMeal, setAddMeal] = useState(null), [selected, setSelected] = useState(null), [editing, setEditing] = useState(null), [query, setQuery] = useState(''), [catalog, setCatalog] = useState(() => service.catalog.localOnly)
  const recent = useRead(addMeal ? service : null, status.revision, { date }, () => service.period({ start: date >= '0001-02-01' ? shiftDay(date, -30) : '0001-01-01', end: date }))
  const foods = data.library.flatMap(p => [...(p.records.customFoods ?? []), ...(p.records.savedFoods ?? [])])
  const recipes = data.library.flatMap(p => p.records.recipes ?? []), goals = data.library.flatMap(p => p.records.nutritionGoals ?? [])
  const summary = useMemo(() => daySummary(data.entries, goals, date), [data.entries, data.library, date])
  const candidates = useMemo(() => {
    const values = new Map(foods.map(f => [`food:${f.id}`, f]))
    for (const recipe of recipes) values.set(`recipe:${recipe.id}`, createRecipeSnapshot(recipe))
    // Recently used snapshots are real data, including foods removed from the library.
    for (const row of [...data.entries, ...(recent.data?.entries ?? [])]) if (![...values.values()].some(f => f.kind === row.snapshot.kind && f.id === row.snapshot.id)) values.set(`recent:${row.id}`, row.snapshot)
    return [...values.entries()].filter(([, f]) => nutritionSearchText(`${f.name} ${f.brand ?? ''}`, dateLocale()).includes(nutritionSearchText(query.trim(), dateLocale())))
  }, [data.library, data.entries, recent.data, query, locale])
  const close = () => { setSelected(null); setEditing(null); setAddMeal(null) }
  if (editing || selected) return <EntryEditor key={editing?.id ?? selected.id} source={editing} snapshot={selected} date={date} meal={addMeal ?? initialMeal} service={service} status={status} close={close} />
  const cancelPicker = event => {
    const pane = event.currentTarget.closest('.nutrition')
    setAddMeal(null)
    // The original add control unmounts with the journal; restore focus after
    // its replacement is rendered, without moving focus into an unrelated view.
    requestAnimationFrame(() => { if (pane?.isConnected) pane.querySelector('.nutrition-journal-heading button')?.focus() })
  }
  // A focused picker replaces the day body while choosing, keeping the selected
  // date/meal and returning to the same journal after a durable save or cancel.
  if (addMeal) return <section className="card nutrition-picker" aria-label={t('Choose food')}>
    <div className="nutrition-picker-heading"><h2>{t('Choose food')}</h2><Button size="sm" onClick={cancelPicker}>{t('Cancel')}</Button></div>
    <Select label="Meal" value={addMeal} onChange={setAddMeal} options={MEALS.map(value => ({ value, label: t(meals[value]) }))} />
    <div className="nutrition-actions nutrition-picker-sources"><Button variant={!catalog ? 'tinted' : 'plain'} aria-pressed={!catalog} onClick={() => setCatalog(false)}>{t('Local foods and recipes')}</Button><Button variant={catalog ? 'tinted' : 'plain'} aria-pressed={catalog} onClick={() => setCatalog(true)}>{t(service.catalog.localOnly ? 'Food catalogue' : 'Open Food Facts')}</Button></div>
    {catalog ? <FoodCatalog service={service} onChoose={setSelected} autoFocus /> : <>
      <SearchField autoFocus aria-label={t('Search foods and recipes')} placeholder={t('Search foods and recipes')} value={query} onChange={e => setQuery(e.target.value)} onClear={() => setQuery('')} />
      <ErrorNotice error={recent.error} />
      {!candidates.length && <p>{t('No matching foods. Create a personal food to begin.')}</p>}
      <div className="nutrition-results">{candidates.slice(0, 100).map(([key, food]) => <button className="nutrition-result" key={key} onClick={() => setSelected(food)}><strong>{food.name}</strong><span>{food.brand}{food.source?.kind === 'open-food-facts' ? ' · Open Food Facts' : ''}</span><span>{fmt(food.nutrients.kcal)} kcal / {fmt(food.reference.amount)} {food.reference.unit === 'serving' ? t('Servings') : food.reference.unit}</span></button>)}</div>
      {candidates.length > 100 && <p>{t('Refine your search to see more results.')}</p>}
    </>}
    <div className="nutrition-picker-footer"><Button onClick={onCreateFood} icon="plus">{t('Create food')}</Button></div>
  </section>
  return <><div className="nutrition-journal-heading"><h2>{t('Journal')}</h2><Button variant="primary" icon="plus" disabled={status.busy} onClick={() => { setAddMeal(initialMeal); setQuery('') }}>{t('Add food')}</Button></div>
    <IntakeIndicators summary={summary} />
    <div className="nutrition-meals">{MEALS.map(meal => { const entries = data.entries.filter(e => e.meal === meal), totals = sumFoodEntries(entries).totals
      return <section className="card nutrition-meal" key={meal} aria-label={t(meals[meal])}>
        <div className="nutrition-meal-heading"><div><h2>{t(meals[meal])}</h2><p className="muted small">{entries.length ? `${fmt(totals.kcal)} kcal · ${t('{0} entries', entries.length)}` : t('No food logged in this meal')}</p></div>
          <Button size="sm" icon="plus" disabled={status.busy} onClick={() => { setAddMeal(meal); setQuery('') }} aria-label={t('Add food to {0}', t(meals[meal]))}>{t('Add')}</Button></div>
        {entries.length > 0 && <><ul className="nutrition-list">{entries.map(e => { const values = nutrientsForQuantity(e.snapshot, e.quantity)
          return <li key={e.id}>
            <div className="nutrition-entry-heading"><div><strong>{e.snapshot.name}</strong><p className="muted small">{quantityText(e.snapshot, e.quantity)} · {fmt(values.kcal)} kcal{e.note ? ` · ${e.note}` : ''}</p></div>
              <Button size="sm" icon="pencil" className="nutrition-icon-action" disabled={status.busy} onClick={() => setEditing(e)} aria-label={t('Edit {0}', e.snapshot.name)} title={t('Edit {0}', e.snapshot.name)}><span className="sr-only">{t('Edit')}</span></Button>
              <DeleteAction compact name={e.snapshot.name} busy={status.busy} remove={() => service.remove('foodEntries', e)} /></div>
            <div className="nutrition-entry-footer"><details className="nutrition-entry-details"><summary>{t('Details')}</summary><NutrientValues values={values} /></details><div className="nutrition-entry-source"><FoodSource food={e.snapshot} /></div></div>
          </li>
        })}</ul><div className="nutrition-meal-totals"><NutrientValues values={totals} /></div></>}
      </section>
    })}</div>
  </>
}
