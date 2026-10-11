import { useState } from 'react'
import { Button } from '../../components/ui.jsx'
import { t } from '../../lib/i18n.js'
import { fmtDate } from '../../lib/format.js'
import { GoalEditor } from './Editors.jsx'
import { DeleteAction, NutrientValues } from './common.jsx'

const modes = { custom: 'Custom', maintenance: 'Maintenance', bulk: 'Bulk', cut: 'Cut' }
export default function Goals({ data, date, service, status }) {
  const [editor, setEditor] = useState(null), rows = data.library.flatMap(p => p.records.nutritionGoals ?? []).sort((a, b) => b.start.localeCompare(a.start))
  if (editor) return <GoalEditor source={editor.id ? editor : null} date={date} service={service} status={status} close={() => setEditor(null)} />
  return <><div className="nutrition-row"><h2>{t('Nutrition goals')}</h2><Button variant="primary" disabled={status.busy} onClick={() => setEditor({})}>{t('Create nutrition goal')}</Button></div>
    {!rows.length && <p className="card">{t('No goal for this day')}</p>}
    {rows.map(goal => <section className="card" key={goal.id}><h3>{t(modes[goal.mode])}</h3><p>{fmtDate(goal.start, true, true)} — {goal.end ? fmtDate(goal.end, true, true) : t('No end date')}</p>
      <NutrientValues values={goal.targets} /><div className="nutrition-actions"><Button size="sm" disabled={status.busy} onClick={() => setEditor(goal)}>{t('Edit')}</Button>
        <DeleteAction name={t('Nutrition goal')} busy={status.busy} remove={() => service.remove('nutritionGoals', goal)} /></div></section>)}
  </>
}
