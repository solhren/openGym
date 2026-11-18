import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Icon from '../../components/Icon.jsx'
import { Button, SearchField, TextField } from '../../components/ui.jsx'
import { t, dateLocale } from '../../lib/i18n.js'
import { MEALS } from '../../lib/nutrition/contracts.js'
import { nutrientsForQuantity, macroEnergy, sumFoodEntries } from '../../lib/nutrition/calculate.js'
import {
  isWaterEntry,
  isQuickAddEntry,
  createWaterEntry,
  createQuickAddEntry,
  buildMealCopyCommands,
  rankMealCandidates,
} from '../../lib/nutrition/meal-helpers.js'
import { daySummary, newNutritionId, nutritionNumber, editedQuantity } from '../../lib/nutrition/ui-service.js'
import { Editor, Field, Select, QuantityFields, NutrientValues, formQuantity, quantityValue, fmt, meals, labels, quantityText, DeleteAction, useRead, ErrorNotice, GoalStatus, FoodSource } from './common.jsx'
import { shiftDay } from './History.jsx'
import FoodCatalog from './FoodCatalog.jsx'

export function IntakeIndicators({ summary }) {
  const distribution = macroEnergy(summary.totals)
  const activeTargets = summary.activeTargets ?? summary.goal?.targets ?? null
  const hasFiberTarget = activeTargets?.fiber != null
  const indicatorKeys = hasFiberTarget ? ['kcal', 'protein', 'carbs', 'fat', 'fiber'] : ['kcal', 'protein', 'carbs', 'fat']
  const hasTrainingTargets = Boolean(summary.goal?.trainingTargets && Object.values(summary.goal.trainingTargets).some(v => v != null))

  return <section className="card nutrition-summary" aria-label={t('Daily nutrition')}>
    {summary.overlapping && <p role="alert">{t('Several goals cover this day. Edit their periods to choose one.')}</p>}
    {summary.goal && !summary.overlapping && (
      <div className="nutrition-summary-context">
        <span className={`nutrition-day-badge${summary.isTrainingDay ? ' is-training' : ''}${hasTrainingTargets ? ' has-dual-targets' : ''}`}>
          {t(summary.isTrainingDay ? 'Training day' : 'Rest day')}
        </span>
      </div>
    )}
    <div className={`nutrition-indicators${hasFiberTarget ? ' has-fiber' : ''}`}>{indicatorKeys.map(k => {
      const value = summary.totals[k], target = activeTargets?.[k], remaining = summary.remaining[k]
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

export function HydrationBar({ summary, date, service, status }) {
  const waterMl = summary.waterMl ?? 0
  const targetMl = summary.waterTargetMl
  const waterEntries = summary.waterEntries ?? []
  const lastMsRef = useRef(0)
  const addWater = ml => {
    const now = Math.max(Date.now(), lastMsRef.current + 1)
    lastMsRef.current = now
    return service.save('foodEntries', createWaterEntry({ date, ml, consumedAt: new Date(now).toISOString() }), null)
  }
  const undoWater = () => {
    const last = waterEntries.at(-1)
    if (last) return service.remove('foodEntries', last)
    return undefined
  }
  return <section className="card nutrition-hydration" aria-label={t('Hydration')}>
    <div className="nutrition-hydration-top">
      <h2>{t('Hydration')}</h2>
      <strong>{fmt(waterMl)}{targetMl != null ? <small> / {fmt(targetMl)} ml</small> : <small> ml</small>}</strong>
    </div>
    {targetMl > 0 && <progress max={targetMl} value={Math.min(targetMl, waterMl)} aria-label={t('Hydration')} />}
    <div className="nutrition-hydration-actions">
      <Button size="sm" variant="tinted" disabled={status.busy} onClick={() => addWater(250)}>{t('+250 ml')}</Button>
      <Button size="sm" variant="tinted" disabled={status.busy} onClick={() => addWater(500)}>{t('+500 ml')}</Button>
      {waterEntries.length > 0 && (
        <Button size="sm" disabled={status.busy} onClick={undoWater} aria-label={t('Undo last water entry')}>{t('Undo')}</Button>
      )}
    </div>
  </section>
}

export function QuickAddEditor({ existing = null, inline = false, date, meal, onMealChange = null, service, status, close, onSaved = null, onAddedContinue = null }) {
  const [name, setName] = useState(() => existing?.snapshot?.name ?? '')
  const [kcal, setKcal] = useState(() => existing?.snapshot?.nutrients?.kcal != null ? String(existing.snapshot.nutrients.kcal) : '')
  const [protein, setProtein] = useState(() => existing?.snapshot?.nutrients?.protein != null ? String(existing.snapshot.nutrients.protein) : '')
  const [carbs, setCarbs] = useState(() => existing?.snapshot?.nutrients?.carbs != null ? String(existing.snapshot.nutrients.carbs) : '')
  const [fat, setFat] = useState(() => existing?.snapshot?.nutrients?.fat != null ? String(existing.snapshot.nutrients.fat) : '')
  const [fiber, setFiber] = useState(() => existing?.snapshot?.nutrients?.fiber != null ? String(existing.snapshot.nutrients.fiber) : '')
  const [localMeal, setLocalMeal] = useState(() => existing?.meal ?? meal)
  const [note, setNote] = useState(() => existing?.note ?? '')
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)
  const submittingRef = useRef(false)
  const kcalRef = useRef(null)

  const activeMeal = inline && onMealChange ? meal : localMeal
  const changeMeal = value => {
    setLocalMeal(value)
    if (inline && onMealChange) onMealChange(value)
  }

  const submit = async keepOpen => {
    if (submittingRef.current || status.busy) return
    submittingRef.current = true
    setSaving(true)
    setError(null)
    try {
      const kcalNum = nutritionNumber(kcal, false)
      const p = nutritionNumber(protein, true)
      const c = nutritionNumber(carbs, true)
      const fa = nutritionNumber(fat, true)
      const fi = nutritionNumber(fiber, true)
      const entry = createQuickAddEntry({
        existing,
        date: existing?.d ?? date,
        meal: activeMeal,
        name: name.trim() || t('Quick add'),
        kcal: kcalNum,
        protein: p,
        carbs: c,
        fat: fa,
        fiber: fi,
        note,
      })
      await service.save('foodEntries', entry, existing ?? null)
      if (keepOpen && onAddedContinue) {
        onAddedContinue(entry)
        setName('')
        setKcal('')
        setProtein('')
        setCarbs('')
        setFat('')
        setFiber('')
        setNote('')
        kcalRef.current?.focus()
      } else {
        onSaved?.(entry)
      }
    } catch (failure) {
      setError(failure)
    } finally {
      submittingRef.current = false
      setSaving(false)
    }
  }

  return <form
    className={inline ? 'nutrition-quick-add' : 'card nutrition-editor nutrition-quick-add'}
    aria-label={t(existing ? 'Edit quick add' : 'Quick add')}
    onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close() } }}
    onSubmit={e => { e.preventDefault(); submit(false) }}
  >
    <h3>{t(existing ? 'Edit quick add' : 'Quick add')}</h3>
    <ErrorNotice error={error} />
    <div className="nutrition-grid">
      <Field label="Name"><TextField placeholder={t('Quick add')} value={name} onChange={e => setName(e.target.value)} maxLength={120} /></Field>
      <Field label="Calories"><TextField ref={kcalRef} autoFocus inputMode="decimal" value={kcal} onChange={e => setKcal(e.target.value)} /></Field>
    </div>
    <div className="nutrition-quick-add-macros">
      <Field label="Protein"><TextField inputMode="decimal" value={protein} onChange={e => setProtein(e.target.value)} /></Field>
      <Field label="Carbohydrates"><TextField inputMode="decimal" value={carbs} onChange={e => setCarbs(e.target.value)} /></Field>
      <Field label="Fat"><TextField inputMode="decimal" value={fat} onChange={e => setFat(e.target.value)} /></Field>
      <Field label={labels.fiber ?? 'Fiber'}><TextField inputMode="decimal" value={fiber} onChange={e => setFiber(e.target.value)} /></Field>
    </div>
    <Select label="Meal" value={activeMeal} onChange={changeMeal} options={MEALS.map(value => ({ value, label: t(meals[value]) }))} />
    <Field label="Note"><TextField value={note} onChange={e => setNote(e.target.value)} maxLength={1000} /></Field>
    <div className="nutrition-actions">
      <Button type="submit" variant="primary" disabled={status.busy || saving}>{t('Save')}</Button>
      {!existing && onAddedContinue && (
        <Button type="button" variant="tinted" disabled={status.busy || saving} onClick={() => submit(true)}>{t('Add & continue')}</Button>
      )}
      <Button type="button" disabled={status.busy || saving} onClick={close}>{t('Cancel')}</Button>
    </div>
  </form>
}

export function EntryEditor({ source, snapshot, initialQuantity = null, date, meal, service, status, close, onSavedContinue = null }) {
  const [id] = useState(() => source?.id ?? newNutritionId()), food = source?.snapshot ?? snapshot
  const initial = formQuantity(source?.quantity ?? initialQuantity ?? food.defaultQuantity ?? { amount: food.kind === 'recipe' ? 1 : food.reference.amount, unit: food.kind === 'recipe' ? 'serving' : food.reference.unit })
  const [amount, setAmount] = useState(initial.amount), [option, setOption] = useState(initial.option), [targetMeal, setMeal] = useState(source?.meal ?? meal)
  const keepOpenRef = useRef(false)
  const saveEntry = entry => {
    const catalogFood = food.source?.kind === 'open-food-facts' || ['wger', 'ciqual'].includes(food.source?.publicCatalogImport?.provider)
    if (source || !catalogFood) return service.save('foodEntries', entry, source ?? null)
    // Identical saved revisions are no-ops; durable food + intake are one publication.
    return service.batch([{ collection: 'savedFoods', id: food.id, value: food, base: null }, { collection: 'foodEntries', id: entry.id, value: entry, base: null }])
  }
  const [note, setNote] = useState(source?.note ?? '')
  let values = null
  try { values = nutrientsForQuantity(food, quantityValue(amount, option)) } catch { /* draft */ }
  return <Editor title={source ? 'Edit food entry' : 'Add food to journal'} close={close} busy={status.busy} onSave={async () => {
    const keepOpen = keepOpenRef.current
    keepOpenRef.current = false
    const entry = {
      ...(source ?? {}), schemaVersion: 1, id, d: source?.d ?? date, meal: targetMeal, snapshot: food,
      quantity: editedQuantity(source?.quantity, amount, option), note,
    }
    await saveEntry(entry)
    if (keepOpen && onSavedContinue) onSavedContinue(entry, values)
  }}>
    <h3>{food.name}</h3><FoodSource food={food} /><QuantityFields snapshot={food} amount={amount} setAmount={setAmount} option={option} setOption={setOption} />
    <Select label="Meal" value={targetMeal} onChange={setMeal} options={MEALS.map(value => ({ value, label: t(meals[value]) }))} />
    <Field label="Note"><TextField value={note} onChange={e => setNote(e.target.value)} maxLength={1000} /></Field>
    {values && <NutrientValues values={values} />}
    {!source && onSavedContinue && (
      <div className="nutrition-actions nutrition-editor-continue">
        <Button type="submit" variant="tinted" disabled={status.busy} onClick={() => { keepOpenRef.current = true }}>{t('Save & add another')}</Button>
      </div>
    )}
  </Editor>
}

const emptySession = () => ({ count: 0, kcal: 0, byKey: {} })

export default function Journal({
  date,
  data,
  service,
  status,
  onCreateFood,
  initialMeal = 'breakfast',
  isTrainingDay = false,
  launchAction = null,
  onClearLaunchAction = null,
}) {
  const locale = dateLocale()
  const [addMeal, setAddMeal] = useState(null)
  const [selected, setSelected] = useState(null)
  const [editing, setEditing] = useState(null)
  const [query, setQuery] = useState('')
  const [quickAddOpen, setQuickAddOpen] = useState(false)
  const [dedicatedCatalog, setDedicatedCatalog] = useState(false)
  const [autoScanSeq, setAutoScanSeq] = useState(0)
  const [sessionAdded, setSessionAdded] = useState(emptySession)
  const [catalogState, setCatalogState] = useState({ provider: null, hasProducts: false, loading: false, cameraActive: false })
  const [duplicateState, setDuplicateState] = useState(null)
  const [duplicateError, setDuplicateError] = useState(null)
  const didSaveAndContinueRef = useRef(false)
  const searchInputRef = useRef(null)

  useEffect(() => {
    if (!launchAction) return
    setSelected(null)
    setEditing(null)
    setQuickAddOpen(false)
    setDedicatedCatalog(false)
    setQuery('')
    setSessionAdded(emptySession())
    if (launchAction === 'add') {
      setAddMeal(prev => prev ?? initialMeal)
      onClearLaunchAction?.()
    } else if (launchAction === 'scan') {
      setAddMeal(prev => prev ?? initialMeal)
      if (service.catalog.enabled !== false) setAutoScanSeq(n => n + 1)
      onClearLaunchAction?.()
    }
  }, [launchAction, initialMeal, onClearLaunchAction, service.catalog.enabled])

  const recent = useRead(
    addMeal && typeof service?.period === 'function' ? service : null,
    status.revision,
    { date },
    () => service.period({ start: date >= '0001-02-01' ? shiftDay(date, -30) : '0001-01-01', end: date })
  )

  const yesterdayDate = date > '0001-01-01' ? shiftDay(date, -1) : null
  const yesterday = useRead(
    !addMeal && yesterdayDate && typeof service?.day === 'function' ? service : null,
    status.revision,
    { yesterdayDate },
    () => service.day(yesterdayDate)
  )

  const foods = useMemo(() => data.library.flatMap(p => [...(p.records.customFoods ?? []), ...(p.records.savedFoods ?? [])]), [data.library])
  const recipes = useMemo(() => data.library.flatMap(p => p.records.recipes ?? []), [data.library])
  const goals = useMemo(() => data.library.flatMap(p => p.records.nutritionGoals ?? []), [data.library])
  const summary = useMemo(() => daySummary(data.entries, goals, date, { isTrainingDay }), [data.entries, goals, date, isTrainingDay])

  const candidates = useMemo(() => rankMealCandidates({
    foods,
    recipes,
    recentEntries: recent.data?.entries ?? [],
    todayEntries: data.entries,
    meal: addMeal ?? initialMeal,
    query,
    locale,
    referenceDate: date,
  }), [foods, recipes, recent.data, data.entries, addMeal, initialMeal, query, locale, date])

  const recordSessionAddition = useCallback((food, kcalAmount, explicitKey = null) => {
    const primaryKey = explicitKey ?? `${food.kind}:${food.id}`
    const barcodeKey = food.source?.barcode ? `barcode:${food.source.barcode}` : null
    setSessionAdded(prev => {
      const nextByKey = { ...prev.byKey, [primaryKey]: (prev.byKey[primaryKey] ?? 0) + 1 }
      if (barcodeKey) nextByKey[barcodeKey] = (nextByKey[barcodeKey] ?? 0) + 1
      return {
        count: prev.count + 1,
        kcal: prev.kcal + (kcalAmount ?? 0),
        byKey: nextByKey,
      }
    })
  }, [])

  const openPicker = meal => {
    setAddMeal(meal)
    setQuery('')
    setQuickAddOpen(false)
    setDedicatedCatalog(false)
    setAutoScanSeq(0)
    setSessionAdded(emptySession())
  }

  const closeAll = () => {
    didSaveAndContinueRef.current = false
    setSelected(null)
    setEditing(null)
    setAddMeal(null)
    setQuickAddOpen(false)
    setDedicatedCatalog(false)
    setAutoScanSeq(0)
    setSessionAdded(emptySession())
  }

  const handleEditorClose = () => {
    if (didSaveAndContinueRef.current) {
      didSaveAndContinueRef.current = false
      setSelected(null)
      setEditing(null)
      return
    }
    closeAll()
  }

  const handleEntrySavedContinue = (entry, values) => {
    didSaveAndContinueRef.current = true
    setAddMeal(entry.meal)
    const kcal = values?.kcal ?? nutrientsForQuantity(entry.snapshot, entry.quantity).kcal ?? 0
    recordSessionAddition(entry.snapshot, kcal)
  }

  const quickLogFood = async (food, quantity, explicitKey = null) => {
    if (status.busy) return
    const entry = {
      schemaVersion: 1,
      id: newNutritionId(),
      d: date,
      meal: addMeal ?? initialMeal,
      snapshot: food,
      quantity,
      note: '',
    }
    const catalogFood = food.source?.kind === 'open-food-facts' || ['wger', 'ciqual'].includes(food.source?.publicCatalogImport?.provider)
    const alreadyInLibrary = foods.some(f => f.id === food.id)
    if (catalogFood && !alreadyInLibrary) {
      await service.batch([
        { collection: 'savedFoods', id: food.id, value: food, base: null },
        { collection: 'foodEntries', id: entry.id, value: entry, base: null },
      ])
    } else {
      await service.save('foodEntries', entry, null)
    }
    const kcal = nutrientsForQuantity(food, quantity).kcal ?? 0
    recordSessionAddition(food, kcal, explicitKey)
  }

  const handleCatalogStateChange = useCallback(next => {
    setCatalogState(prev => (
      prev.provider === next.provider &&
      prev.hasProducts === next.hasProducts &&
      prev.loading === next.loading &&
      prev.cameraActive === next.cameraActive
        ? prev
        : next
    ))
  }, [])

  if (editing && isQuickAddEntry(editing)) {
    return <QuickAddEditor key={editing.id} existing={editing} date={date} meal={editing.meal} service={service} status={status} close={closeAll} onSaved={closeAll} />
  }

  if (editing || selected) {
    return <EntryEditor
      key={editing?.id ?? selected.food.id}
      source={editing}
      snapshot={selected?.food}
      initialQuantity={selected?.initialQuantity ?? null}
      date={date}
      meal={addMeal ?? initialMeal}
      service={service}
      status={status}
      close={handleEditorClose}
      onSavedContinue={!editing ? handleEntrySavedContinue : null}
    />
  }

  const finishOrCancelPicker = event => {
    const pane = event.currentTarget.closest('.nutrition')
    setAddMeal(null)
    setQuickAddOpen(false)
    setDedicatedCatalog(false)
    setAutoScanSeq(0)
    setSessionAdded(emptySession())
    // The original add control unmounts with the journal; restore focus after
    // its replacement is rendered, without moving focus into an unrelated view.
    requestAnimationFrame(() => { if (pane?.isConnected) pane.querySelector('.nutrition-journal-heading button')?.focus() })
  }

  const chooseCatalogFood = food => {
    const match = candidates.find(c => c.snapshot.kind === food.kind && c.snapshot.id === food.id)
    setSelected({ food, initialQuantity: match?.suggestedQuantity ?? null })
  }

  const quickAddCatalogFood = food => {
    const match = candidates.find(c => c.snapshot.kind === food.kind && c.snapshot.id === food.id)
    const qty = match?.suggestedQuantity ?? food.defaultQuantity ?? { amount: food.reference.amount, unit: food.reference.unit }
    return quickLogFood(food, qty)
  }

  if (addMeal) {
    const showEmptyMessage = !dedicatedCatalog && !catalogState.cameraActive && !candidates.length && !catalogState.hasProducts
    return <section className="card nutrition-picker" aria-label={t('Choose food')}>
      <div className="nutrition-picker-heading">
        <h2>{t('Choose food')}</h2>
        <Button size="sm" variant={sessionAdded.count > 0 ? 'primary' : undefined} onClick={finishOrCancelPicker}>
          {sessionAdded.count > 0 ? t('Done ({0})', sessionAdded.count) : t('Cancel')}
        </Button>
      </div>

      <div className="nutrition-picker-meal-bar">
        <div className="nutrition-meal-pills" role="group" aria-label={t('Meal')}>
          {MEALS.map(m => (
            <button
              key={m}
              type="button"
              className={`btn sm ${addMeal === m ? 'tinted' : 'plain'} nutrition-meal-pill`}
              aria-pressed={addMeal === m}
              onClick={() => setAddMeal(m)}
            >
              {t(meals[m])}
            </button>
          ))}
        </div>
        {!quickAddOpen && (
          <div className="nutrition-picker-meal-select">
            <Select label="Meal" value={addMeal} onChange={setAddMeal} options={MEALS.map(value => ({ value, label: t(meals[value]) }))} />
          </div>
        )}
      </div>

      {dedicatedCatalog ? (
        <>
          <div className="nutrition-actions">
            <Button size="sm" variant="plain" onClick={() => setDedicatedCatalog(false)}>{t('Local foods and recipes')}</Button>
          </div>
          <FoodCatalog
            service={service}
            autoFocus
            addedCounts={sessionAdded.byKey}
            onChoose={chooseCatalogFood}
            onQuickAdd={quickAddCatalogFood}
          />
        </>
      ) : (
        <>
          <div className="nutrition-picker-toolbar">
            <SearchField
              ref={searchInputRef}
              autoFocus={!quickAddOpen && !autoScanSeq}
              aria-label={t('Search foods and recipes')}
              placeholder={t('Search foods and recipes')}
              value={query}
              onChange={e => setQuery(e.target.value)}
              onClear={() => { setQuery(''); searchInputRef.current?.focus() }}
            />
            <div className="nutrition-picker-quick-actions">
              {service.catalog.enabled !== false && catalogState.provider !== 'ciqual' && (
                <Button
                  size="sm"
                  icon="camera"
                  className="nutrition-icon-action"
                  aria-label={t('Scan product barcode')}
                  title={t('Scan product barcode')}
                  disabled={catalogState.loading}
                  onClick={() => { setQuickAddOpen(false); setAutoScanSeq(n => n + 1) }}
                >
                  <span className="sr-only">{t('Scan product barcode')}</span>
                </Button>
              )}
              <Button
                size="sm"
                variant={quickAddOpen ? 'tinted' : undefined}
                icon="bolt"
                aria-pressed={quickAddOpen}
                onClick={() => setQuickAddOpen(v => !v)}
              >
                {t('Quick add')}
              </Button>
            </div>
          </div>

          {quickAddOpen && (
            <QuickAddEditor
              inline
              date={date}
              meal={addMeal}
              onMealChange={setAddMeal}
              service={service}
              status={status}
              close={() => setQuickAddOpen(false)}
              onSaved={closeAll}
              onAddedContinue={entry => recordSessionAddition(entry.snapshot, entry.snapshot.nutrients.kcal ?? 0, `quick:${entry.id}`)}
            />
          )}

          <ErrorNotice error={recent.error} />

          {!catalogState.cameraActive && (
            <>
              {showEmptyMessage && <p>{t('No matching foods. Create a personal food to begin.')}</p>}
              {candidates.length > 0 && (
                <div className="nutrition-results">
                  {candidates.slice(0, 100).map(candidate => {
                    const food = candidate.snapshot
                    const suggestedValues = nutrientsForQuantity(food, candidate.suggestedQuantity)
                    const addedCount = sessionAdded.byKey[candidate.key] ?? 0
                    return <div className="nutrition-result-row" key={candidate.key}>
                      <button
                        type="button"
                        className="nutrition-result"
                        onClick={() => setSelected({ food, initialQuantity: candidate.suggestedQuantity })}
                      >
                        <div className="nutrition-result-title">
                          <strong>{food.name}</strong>
                          {candidate.isHabit && (
                            <span className="nutrition-habit-badge">
                              {candidate.mealCount > 0 ? t('Habit') : t('Recent')}
                            </span>
                          )}
                          {addedCount > 0 && (
                            <span className="nutrition-added-badge" aria-label={t('{0} added', addedCount)}>
                              ✓ {addedCount}
                            </span>
                          )}
                        </div>
                        {(food.brand || food.source?.kind === 'open-food-facts') && (
                          <span>{food.brand}{food.source?.kind === 'open-food-facts' ? `${food.brand ? ' · ' : ''}Open Food Facts` : ''}</span>
                        )}
                        <span>{quantityText(food, candidate.suggestedQuantity)} · {fmt(suggestedValues.kcal)} kcal</span>
                      </button>
                      <Button
                        size="sm"
                        variant="tinted"
                        className="nutrition-quick-pick"
                        disabled={status.busy}
                        aria-label={t('Quick log {0}', food.name)}
                        title={t('Quick log {0}', food.name)}
                        onClick={() => quickLogFood(food, candidate.suggestedQuantity, candidate.key)}
                      >
                        {addedCount > 0 ? `✓${addedCount}` : '+'}
                      </Button>
                    </div>
                  })}
                </div>
              )}
              {candidates.length > 100 && <p>{t('Refine your search to see more results.')}</p>}
            </>
          )}

          {service.catalog.enabled !== false && (
            <FoodCatalog
              embedded
              service={service}
              externalQuery={query}
              onExternalQueryChange={setQuery}
              autoScan={autoScanSeq}
              addedCounts={sessionAdded.byKey}
              onStateChange={handleCatalogStateChange}
              onChoose={chooseCatalogFood}
              onQuickAdd={quickAddCatalogFood}
            />
          )}
        </>
      )}

      <div className="nutrition-picker-footer nutrition-actions">
        <Button onClick={onCreateFood} icon="plus">{t('Create food')}</Button>
        {!dedicatedCatalog && service.catalog.enabled !== false && (
          <Button size="sm" variant="plain" onClick={() => setDedicatedCatalog(true)}>
            {t(service.catalog.localOnly ? 'Food catalogue' : 'Open Food Facts')}
          </Button>
        )}
      </div>

      {sessionAdded.count > 0 && (
        <div className="nutrition-picker-session-bar" role="status" aria-live="polite">
          <span>{t('{0} added · +{1} kcal', sessionAdded.count, fmt(sessionAdded.kcal))}</span>
          <Button size="sm" variant="primary" onClick={finishOrCancelPicker}>{t('Done')}</Button>
        </div>
      )}
    </section>
  }

  const yesterdayEntries = (yesterday.data?.entries ?? []).filter(e => !isWaterEntry(e))
  const nonWaterTodayEntries = data.entries.filter(e => !isWaterEntry(e))

  const copyFromYesterday = async meal => {
    const cmds = buildMealCopyCommands({
      entries: yesterdayEntries,
      sourceMeal: meal,
      targetDate: date,
      targetMeal: meal,
    })
    if (cmds.length) await service.batch(cmds)
  }

  const confirmDuplicateMeal = async () => {
    if (!duplicateState) return
    setDuplicateError(null)
    try {
      const cmds = buildMealCopyCommands({
        entries: nonWaterTodayEntries,
        sourceMeal: duplicateState.sourceMeal,
        targetDate: duplicateState.targetDate,
        targetMeal: duplicateState.targetMeal,
      })
      if (cmds.length) await service.batch(cmds)
      setDuplicateState(null)
    } catch (failure) {
      setDuplicateError(failure)
    }
  }

  return <>
    <div className="nutrition-journal-heading">
      <h2>{t('Journal')}</h2>
      <Button variant="primary" icon="plus" disabled={status.busy} onClick={() => openPicker(initialMeal)}>{t('Add food')}</Button>
    </div>
    <IntakeIndicators summary={summary} />
    <HydrationBar summary={summary} date={date} service={service} status={status} />
    <div className="nutrition-meals">{MEALS.map(meal => {
      const entries = nonWaterTodayEntries.filter(e => e.meal === meal)
      const totals = sumFoodEntries(entries).totals
      const yesterdayMealEntries = yesterdayEntries.filter(e => e.meal === meal)
      const hasMenuActions = yesterdayMealEntries.length > 0 || entries.length > 0
      const isDuplicating = duplicateState?.sourceMeal === meal

      return <section className="card nutrition-meal" key={meal} aria-label={t(meals[meal])}>
        <div className="nutrition-meal-heading">
          <div>
            <h2>{t(meals[meal])}</h2>
            <p className="muted small">{entries.length ? `${fmt(totals.kcal)} kcal · ${t('{0} entries', entries.length)}` : t('No food logged in this meal')}</p>
          </div>
          <div className="nutrition-meal-actions">
            {hasMenuActions && (
              <details
                className="nutrition-meal-menu"
                onKeyDown={e => {
                  if (e.key === 'Escape' && e.currentTarget.open) {
                    e.preventDefault()
                    e.currentTarget.open = false
                    e.currentTarget.querySelector('summary')?.focus()
                  }
                }}
              >
                <summary aria-label={t('Meal actions for {0}', t(meals[meal]))} title={t('Meal actions')}>
                  <span aria-hidden="true">⋯</span>
                  <span className="sr-only">{t('Meal actions')}</span>
                </summary>
                <div className="nutrition-meal-menu-popover">
                  {yesterdayMealEntries.length > 0 && (
                    <Button
                      size="sm"
                      disabled={status.busy}
                      onClick={e => {
                        e.currentTarget.closest('details')?.removeAttribute('open')
                        copyFromYesterday(meal)
                      }}
                    >
                      {t('Copy from yesterday')}
                    </Button>
                  )}
                  {entries.length > 0 && (
                    <Button
                      size="sm"
                      disabled={status.busy}
                      onClick={e => {
                        e.currentTarget.closest('details')?.removeAttribute('open')
                        setDuplicateError(null)
                        setDuplicateState({
                          sourceMeal: meal,
                          targetDate: date < '9999-12-31' ? shiftDay(date, 1) : date,
                          targetMeal: meal,
                        })
                      }}
                    >
                      {t('Duplicate meal…')}
                    </Button>
                  )}
                </div>
              </details>
            )}
            <Button size="sm" icon="plus" disabled={status.busy} onClick={() => openPicker(meal)} aria-label={t('Add food to {0}', t(meals[meal]))}>{t('Add')}</Button>
          </div>
        </div>

        {entries.length === 0 && yesterdayMealEntries.length > 0 && (
          <div className="nutrition-meal-empty-actions">
            <Button size="sm" variant="tinted" disabled={status.busy} onClick={() => copyFromYesterday(meal)}>
              {t('Copy from yesterday ({0})', yesterdayMealEntries.length)}
            </Button>
          </div>
        )}

        {isDuplicating && (
          <div className="nutrition-meal-duplicate" role="region" aria-label={t('Duplicate meal')}>
            <ErrorNotice error={duplicateError} />
            <div className="nutrition-grid">
              <Field label="Target date">
                <input
                  className="field"
                  type="date"
                  value={duplicateState.targetDate}
                  onChange={e => setDuplicateState(s => ({ ...s, targetDate: e.target.value }))}
                />
              </Field>
              <Select
                label="Target meal"
                value={duplicateState.targetMeal}
                onChange={targetMeal => setDuplicateState(s => ({ ...s, targetMeal }))}
                options={MEALS.map(value => ({ value, label: t(meals[value]) }))}
              />
            </div>
            <div className="nutrition-actions">
              <Button size="sm" variant="primary" disabled={status.busy || !duplicateState.targetDate} onClick={confirmDuplicateMeal}>{t('Copy meal')}</Button>
              <Button size="sm" disabled={status.busy} onClick={() => { setDuplicateState(null); setDuplicateError(null) }}>{t('Cancel')}</Button>
            </div>
          </div>
        )}

        {entries.length > 0 && <><ul className="nutrition-list">{entries.map(e => {
          const values = nutrientsForQuantity(e.snapshot, e.quantity)
          const quick = isQuickAddEntry(e)
          return <li key={e.id}>
            <div className="nutrition-entry-heading"><div><strong>{e.snapshot.name}</strong><p className="muted small">{quick ? fmt(values.kcal) : `${quantityText(e.snapshot, e.quantity)} · ${fmt(values.kcal)}`} kcal{e.note ? ` · ${e.note}` : ''}</p></div>
              <Button size="sm" icon="pencil" className="nutrition-icon-action" disabled={status.busy} onClick={() => setEditing(e)} aria-label={t('Edit {0}', e.snapshot.name)} title={t('Edit {0}', e.snapshot.name)}><span className="sr-only">{t('Edit')}</span></Button>
              <DeleteAction compact name={e.snapshot.name} busy={status.busy} remove={() => service.remove('foodEntries', e)} /></div>
            <div className="nutrition-entry-footer"><details className="nutrition-entry-details"><summary>{t('Details')}</summary><NutrientValues values={values} /></details><div className="nutrition-entry-source"><FoodSource food={e.snapshot} /></div></div>
          </li>
        })}</ul><div className="nutrition-meal-totals"><NutrientValues values={totals} /></div></>}
      </section>
    })}</div>
  </>
}
