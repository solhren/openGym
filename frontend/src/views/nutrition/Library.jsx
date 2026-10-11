import { useState } from 'react'
import { Button, SearchField } from '../../components/ui.jsx'
import { t, dateLocale } from '../../lib/i18n.js'
import { createRecipeSnapshot } from '../../lib/nutrition/recipe.js'
import { nutrientsForQuantity } from '../../lib/nutrition/calculate.js'
import { nutritionSearchText } from '../../lib/nutrition/ui-service.js'
import { FoodEditor, RecipeEditor } from './Editors.jsx'
import { EntryEditor } from './Journal.jsx'
import { DeleteAction, NutrientValues } from './common.jsx'

export default function Library({ kind, data, date, service, status, create = false }) {
  const [query, setQuery] = useState(''), [editor, setEditor] = useState(create ? {} : null), [logging, setLogging] = useState(null)
  const recipe = kind === 'recipes', collection = recipe ? 'recipes' : 'customFoods', foods = data.library.flatMap(p => [...(p.records.customFoods ?? []), ...(p.records.savedFoods ?? [])])
  const rows = data.library.flatMap(p => p.records[collection] ?? []).filter(f => nutritionSearchText(`${f.name} ${f.brand ?? ''}`, dateLocale()).includes(nutritionSearchText(query.trim(), dateLocale())))
  if (editor) {
    const props = { source: editor.id ? editor : null, service, status, close: () => setEditor(null) }
    return recipe ? <RecipeEditor {...props} foods={foods} /> : <FoodEditor {...props} />
  }
  if (logging) return <EntryEditor snapshot={logging} date={date} meal="breakfast" service={service} status={status} close={() => setLogging(null)} />
  return <><div className="nutrition-row"><h2>{t(recipe ? 'Recipes' : 'Personal foods')}</h2><Button variant="primary" disabled={status.busy} onClick={() => setEditor({})}>{t(recipe ? 'Create recipe' : 'Create food')}</Button></div>
    <SearchField aria-label={t('Search')} value={query} onChange={e => setQuery(e.target.value)} onClear={() => setQuery('')} placeholder={t('Search')} />
    {!rows.length && <div className="card empty">{t(recipe ? 'No recipes yet' : 'No personal foods yet')}</div>}
    {rows.slice(0, 100).map(row => { const snapshot = recipe ? createRecipeSnapshot(row) : row, q = { amount: recipe ? 1 : snapshot.reference.amount, unit: recipe ? 'serving' : snapshot.reference.unit }
      return <section className="card" key={row.id}><h3>{row.name}</h3>{row.brand && <p className="muted">{row.brand}</p>}
        <p className="muted small">{recipe ? t('Per serving') : `${snapshot.reference.amount} ${snapshot.reference.unit}`}</p><NutrientValues values={nutrientsForQuantity(snapshot, q)} />
        {recipe && <p className="muted small">{row.ingredients.map(i => i.food.name).join(' · ')}</p>}
        <div className="nutrition-actions"><Button size="sm" disabled={status.busy} onClick={() => setLogging(snapshot)}>{t('Add to journal')}</Button>
          <Button size="sm" disabled={status.busy} onClick={() => setEditor(row)} aria-label={t('Edit {0}', row.name)}>{t('Edit')}</Button>
          <DeleteAction name={row.name} busy={status.busy} remove={() => service.remove(collection, row)} /></div>
      </section>
    })}{rows.length > 100 && <p>{t('Refine your search to see more results.')}</p>}
  </>
}
