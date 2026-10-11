import { useState } from 'react'
import { Button, TextField } from '../../components/ui.jsx'
import { t } from '../../lib/i18n.js'
import { NUTRIENTS } from '../../lib/nutrition/contracts.js'
import { nutritionNumber, newNutritionId, editedQuantity } from '../../lib/nutrition/ui-service.js'
import { createRecipeSnapshot, recipeNutrients } from '../../lib/nutrition/recipe.js'
import { nutrientsForQuantity } from '../../lib/nutrition/calculate.js'
import { Editor, Field, Decimal, Select, NutrientFields, QuantityFields, NutrientValues, formQuantity } from './common.jsx'

const blankValues = values => Object.fromEntries(NUTRIENTS.map(k => [k, values?.[k] == null ? '' : String(values[k])]))
const numericValues = values => Object.fromEntries(NUTRIENTS.map(k => [k, nutritionNumber(values[k], true)]))
export function FoodEditor({ source, service, status, close }) {
  const [id] = useState(() => source?.id ?? newNutritionId()), [name, setName] = useState(source?.name ?? ''), [brand, setBrand] = useState(source?.brand ?? '')
  const [amount, setAmount] = useState(String(source?.reference.amount ?? 100)), [unit, setUnit] = useState(source?.reference.unit ?? 'g')
  const [density, setDensity] = useState(source?.densityGPerMl == null ? '' : String(source.densityGPerMl))
  const [values, setValues] = useState(() => blankValues(source?.nutrients)), [portions, setPortions] = useState(() => (source?.portions ?? []).map(p => ({ ...p, amount: String(p.amount) })))
  const [useDefault, setUseDefault] = useState(!!source?.defaultQuantity)
  const [defaultAmount, setDefaultAmount] = useState(String(source?.defaultQuantity?.amount ?? 100)), [defaultOption, setDefaultOption] = useState(source?.defaultQuantity ? formQuantity(source.defaultQuantity).option : unit)
  let draftDensity = null
  try { draftDensity = nutritionNumber(density, true) } catch { /* incomplete draft: no cross-unit conversion offered */ }
  const save = () => service.save('customFoods', { ...(source ?? {}), schemaVersion: 1, kind: 'food', id, name: name.trim(), brand: brand.trim(),
    reference: { ...(source?.reference ?? {}), amount: nutritionNumber(amount), unit }, nutrients: { ...(source?.nutrients ?? {}), ...numericValues(values) },
    densityGPerMl: nutritionNumber(density, true), portions: portions.map(p => ({ ...p, label: p.label.trim(), amount: nutritionNumber(p.amount) })),
    defaultQuantity: useDefault ? editedQuantity(source?.defaultQuantity, defaultAmount, defaultOption) : null,
    source: source?.source ?? { kind: 'custom' } }, source ?? null)
  return <Editor title={source ? 'Edit food' : 'Create food'} close={close} onSave={save} busy={status.busy}>
    <Field label="Name"><TextField value={name} onChange={e => setName(e.target.value)} required maxLength={200} /></Field>
    <Field label="Brand"><TextField value={brand} onChange={e => setBrand(e.target.value)} maxLength={200} /></Field>
    <div className="nutrition-grid"><Decimal label="Reference amount" value={amount} onChange={setAmount} required />
      <Select label="Reference unit" value={unit} onChange={setUnit} options={['g', 'ml'].map(value => ({ value, label: value }))} /></div>
    <NutrientFields values={values} setValues={setValues} /><Decimal label="Density (g/ml, optional)" value={density} onChange={setDensity} />
    <h3>{t('Portions')}</h3>{portions.map((p, i) => <div className="nutrition-ingredient" key={p.id}>
      <Field label="Portion name"><TextField value={p.label} required maxLength={100} onChange={e => setPortions(rows => rows.map((row, index) => index === i ? { ...row, label: e.target.value } : row))} /></Field>
      <div className="nutrition-grid"><Decimal label="Portion amount" value={p.amount} onChange={v => setPortions(rows => rows.map((row, index) => index === i ? { ...row, amount: v } : row))} required />
        <Select label="Unit" value={p.unit} onChange={v => setPortions(rows => rows.map((row, index) => index === i ? { ...row, unit: v } : row))} options={['g', 'ml'].map(value => ({ value, label: value }))} /></div>
      <Button type="button" onClick={() => setPortions(rows => rows.filter((_, index) => index !== i))}>{t('Remove portion')}</Button>
    </div>)}<Button type="button" onClick={() => setPortions(rows => [...rows, { id: newNutritionId(), label: '', amount: '100', unit }])}>{t('Add portion')}</Button>
    <label className="nutrition-check"><input type="checkbox" checked={useDefault} onChange={e => setUseDefault(e.target.checked)} />{t('Default logging quantity')}</label>
    {useDefault && <QuantityFields snapshot={{ kind: 'food', reference: { unit }, portions, densityGPerMl: draftDensity }} amount={defaultAmount} setAmount={setDefaultAmount} option={defaultOption} setOption={setDefaultOption} />}
  </Editor>
}

function Ingredient({ item, setItem, remove }) {
  return <div className="nutrition-ingredient"><h3>{item.value.food.name}</h3>
    <QuantityFields snapshot={item.value.food} amount={item.amount} option={item.option} setAmount={amount => setItem({ ...item, amount })} setOption={option => setItem({ ...item, option })} />
    <Button type="button" onClick={remove} aria-label={t('Remove {0}', item.value.food.name)}>{t('Remove ingredient')}</Button></div>
}
export function RecipeEditor({ source, foods, service, status, close }) {
  const [id] = useState(() => source?.id ?? newNutritionId()), [name, setName] = useState(source?.name ?? '')
  const [servings, setServings] = useState(String(source?.yield.servings ?? 1)), [grams, setGrams] = useState(source?.yield.grams == null ? '' : String(source.yield.grams)), [ml, setMl] = useState(source?.yield.ml == null ? '' : String(source.yield.ml))
  const [items, setItems] = useState(() => (source?.ingredients ?? []).map(p => ({ value: p, ...formQuantity(p.quantity) }))), [selected, setSelected] = useState(foods[0]?.id ?? '')
  const record = () => ({ ...(source ?? {}), schemaVersion: 1, id, name: name.trim(),
    ingredients: items.map(({ value, amount, option }) => ({ ...value, quantity: editedQuantity(value.quantity, amount, option) })),
    yield: { ...(source?.yield ?? {}), servings: nutritionNumber(servings), grams: nutritionNumber(grams, true), ml: nutritionNumber(ml, true) } })
  let totals = null, perServing = null
  try { const recipe = record(); totals = recipeNutrients(recipe).totals; perServing = nutrientsForQuantity(createRecipeSnapshot(recipe), { amount: 1, unit: 'serving' }) } catch { /* incomplete drafts are not valid recipe calculations */ }
  return <Editor title={source ? 'Edit recipe' : 'Create recipe'} close={close} onSave={() => service.save('recipes', record(), source ?? null)} busy={status.busy}>
    <Field label="Name"><TextField value={name} onChange={e => setName(e.target.value)} required maxLength={200} /></Field>
    {items.map((item, i) => <Ingredient key={item.value.id} item={item} setItem={value => setItems(rows => rows.map((row, n) => n === i ? value : row))} remove={() => setItems(rows => rows.filter((_, n) => n !== i))} />)}
    {foods.length ? <><Select label="Ingredient" value={selected} onChange={setSelected} options={foods.map(f => ({ value: f.id, label: f.name }))} />
      <Button type="button" onClick={() => { const food = foods.find(f => f.id === selected); if (food) setItems(rows => [...rows, { value: { id: newNutritionId(), food }, ...formQuantity(food.defaultQuantity ?? { amount: food.reference.amount, unit: food.reference.unit }) }]) }}>{t('Add ingredient')}</Button></> : <p>{t('Create a personal food first.')}</p>}
    <Decimal label="Servings" value={servings} onChange={setServings} required /><p className="muted small">{t('Cooked weight and volume are measured yields, not raw ingredient totals.')}</p>
    <div className="nutrition-grid"><Decimal label="Cooked weight (g, optional)" value={grams} onChange={setGrams} /><Decimal label="Cooked volume (ml, optional)" value={ml} onChange={setMl} /></div>
    {totals && <><h3>{t('Recipe total')}</h3><NutrientValues values={totals} /><h3>{t('Per serving')}</h3><NutrientValues values={perServing} /></>}
  </Editor>
}

export function GoalEditor({ source, date, service, status, close }) {
  const [id] = useState(() => source?.id ?? newNutritionId()), [start, setStart] = useState(source?.start ?? date), [end, setEnd] = useState(source?.end ?? '')
  const [mode, setMode] = useState(source?.mode ?? 'custom'), [values, setValues] = useState(() => blankValues(source?.targets))
  return <Editor title={source ? 'Edit nutrition goal' : 'Create nutrition goal'} close={close} onSave={() => service.save('nutritionGoals', {
    ...(source ?? {}), schemaVersion: 1, id, start, end: end || null, mode, targets: { ...(source?.targets ?? {}), ...numericValues(values) },
  }, source ?? null)} busy={status.busy}>
    <div className="nutrition-grid"><Field label="Start date"><input className="field" type="date" value={start} onChange={e => setStart(e.target.value)} required /></Field>
      <Field label="End date (optional)"><input className="field" type="date" value={end} onChange={e => setEnd(e.target.value)} /></Field></div>
    <Select label="Goal mode" value={mode} onChange={setMode} options={[['custom', 'Custom'], ['maintenance', 'Maintenance'], ['bulk', 'Bulk'], ['cut', 'Cut']].map(([value, label]) => ({ value, label: t(label) }))} />
    <NutrientFields values={values} setValues={setValues} /><p className="muted small">{t('Goal periods are inclusive. Overlapping goals require editing their dates.')}</p>
  </Editor>
}
