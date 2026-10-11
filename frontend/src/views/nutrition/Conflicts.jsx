import { useRef, useState } from 'react'
import { Button } from '../../components/ui.jsx'
import { t } from '../../lib/i18n.js'
import { newNutritionId } from '../../lib/nutrition/ui-service.js'
import { nutrientsForQuantity } from '../../lib/nutrition/calculate.js'
import { createRecipeSnapshot } from '../../lib/nutrition/recipe.js'
import { ErrorNotice, useRead, NutrientValues, quantityText, meals } from './common.jsx'

export default function Conflicts({ service, status }) {
  const result = useRead(service, status.revision, { conflicts: true }, () => service.conflicts()), [error, setError] = useState(null), [message, setMessage] = useState(''), pending = useRef(false), copyIds = useRef(new Map())
  return <section className="card"><h2>{t('Preserved versions')}</h2><p>{t('Concurrent versions are retained permanently. Inspect them before deciding whether to import a separate copy. This does not mark a conflict as resolved.')}</p>
    <ErrorNotice error={result.error ?? error} />{!result.data && !result.error && <p role="status">{t('Loading…')}</p>}
    {result.error && <Button onClick={result.reload}>{t('Retry')}</Button>}
    {result.data?.length === 0 && <p>{t('No preserved divergent versions')}</p>}
    {result.data?.map(variant => <article className="nutrition-ingredient" key={variant.hash}><h3>{variant.record.name ?? variant.record.snapshot?.name ?? t('Nutrition goal')}</h3>
      {variant.record.snapshot && <><p>{variant.record.d} · {t(meals[variant.record.meal])} · {quantityText(variant.record.snapshot, variant.record.quantity)}</p><NutrientValues values={nutrientsForQuantity(variant.record.snapshot, variant.record.quantity)} /></>}
      {variant.record.nutrients && <NutrientValues values={variant.record.nutrients} />}
      {variant.record.ingredients && <><p>{variant.record.ingredients.map(i => `${i.food.name} (${quantityText(i.food, i.quantity)})`).join(' · ')}</p><NutrientValues values={createRecipeSnapshot(variant.record).nutrients} /></>}
      {variant.record.targets && <><p>{variant.record.start} — {variant.record.end ?? t('No end date')}</p><NutrientValues values={variant.record.targets} /></>}
      {variant.record.note && <p>{variant.record.note}</p>}
      {['customFoods', 'recipes', 'foodEntries', 'nutritionGoals'].includes(variant.collection) && <Button disabled={status.busy} onClick={async () => {
        if (pending.current) return; pending.current = true; setError(null)
        // Keep the same id after an unknown local write outcome, so retry uses the
        // command service's already-achieved check instead of duplicating the record.
        const id = copyIds.current.get(variant.hash) ?? newNutritionId()
        copyIds.current.set(variant.hash, id)
        try { await service.save(variant.collection, { ...variant.record, id }); copyIds.current.delete(variant.hash); setMessage(t('A separate copy was saved locally. Original versions remain preserved.')) } catch (e) { setError(e) } finally { pending.current = false }
      }}>{t('Import as a separate copy')}</Button>}
    </article>)}{message && <p role="status">{message}</p>}
  </section>
}
