import { useState } from 'react'
import { Button } from '../../components/ui.jsx'
import { t } from '../../lib/i18n.js'
import { fmtDate } from '../../lib/format.js'
import { effectiveGoalTargets, goalForDay } from '../../lib/nutrition/ui-service.js'
import { DEFAULT_WATER_TARGET_ML } from '../../lib/nutrition/meal-helpers.js'
import { GoalEditor } from './Editors.jsx'
import { DeleteAction, ErrorNotice, NutrientValues, fmt, labels } from './common.jsx'
import './Bilan.css'

const modes = { custom: 'Custom', maintenance: 'Maintenance', bulk: 'Bulk', cut: 'Cut' }
const QUALITY_KEYS = ['fiber', 'sugar', 'saturatedFat', 'sodium']
const COMPARISON_KEYS = ['kcal', 'protein', 'carbs', 'fat', 'fiber']

function hasAnyTrainingOverride(goal) {
  return Boolean(goal?.trainingTargets && Object.values(goal.trainingTargets).some(v => v != null))
}

function GoalComparison({ goal }) {
  const effectiveTraining = effectiveGoalTargets(goal, true)
  const keys = COMPARISON_KEYS.filter(
    k => k !== 'fiber' || goal.targets?.fiber != null || goal.trainingTargets?.fiber != null
  )
  return (
    <div className="bilan-goal-comparison" data-goal-comparison="true">
      <div className="bilan-goal-comp-row" data-goal-day="rest">
        <span className="bilan-goal-comp-title">{t('Rest day')}</span>
        <div className="bilan-goal-comp-values">
          {keys.map(k => (
            <span key={k} className="bilan-goal-comp-cell">
              {t(labels[k])}: <strong>{fmt(goal.targets?.[k])}</strong> {k === 'kcal' ? 'kcal' : 'g'}
            </span>
          ))}
        </div>
      </div>
      <div className="bilan-goal-comp-row" data-goal-day="training">
        <span className="bilan-goal-comp-title is-training">{t('Training day')}</span>
        <div className="bilan-goal-comp-values">
          {keys.map(k => {
            const overridden = goal.trainingTargets?.[k] != null
            return (
              <span key={k} className={`bilan-goal-comp-cell${overridden ? ' is-overridden' : ''}`}>
                {t(labels[k])}: <strong>{fmt(effectiveTraining?.[k])}</strong> {k === 'kcal' ? 'kcal' : 'g'}
              </span>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export default function Goals({ data, date, service, status, suggestedKcal = null, openBilan = null }) {
  const [editor, setEditor] = useState(null)
  const [actionError, setActionError] = useState(null)
  const rows = data.library
    .flatMap(p => p.records.nutritionGoals ?? [])
    .sort((a, b) => b.start.localeCompare(a.start))

  if (editor) {
    return (
      <GoalEditor
        source={editor.id ? editor : null}
        initialTargets={editor.initialTargets ?? null}
        date={date}
        service={service}
        status={status}
        close={() => setEditor(null)}
      />
    )
  }

  const { goal: activeGoal, overlapping } = goalForDay(rows, date)
  const validSuggestion = Number.isFinite(suggestedKcal) && suggestedKcal > 0 ? Math.round(suggestedKcal) : null
  const showSuggestion = validSuggestion != null && !overlapping && (!activeGoal || activeGoal.targets?.kcal !== validSuggestion)

  const applySuggestedKcal = async () => {
    if (!validSuggestion || status.busy) return
    if (!activeGoal) {
      setEditor({ initialTargets: { kcal: validSuggestion } })
      return
    }
    setActionError(null)
    try {
      await service.save('nutritionGoals', {
        ...activeGoal,
        targets: { ...activeGoal.targets, kcal: validSuggestion },
      }, activeGoal)
    } catch (err) {
      setActionError(err)
    }
  }

  return (
    <>
      <div className="nutrition-row">
        <h2>{t('Nutrition goals')}</h2>
        <div className="bilan-header-actions">
          {openBilan && (
            <Button size="sm" icon="chart" onClick={openBilan}>
              {t('Overview')}
            </Button>
          )}
          <Button variant="primary" disabled={status.busy} onClick={() => setEditor({})}>
            {t('Create nutrition goal')}
          </Button>
        </div>
      </div>

      <ErrorNotice error={actionError} />

      {showSuggestion && (
        <section className="card bilan-goal-suggestion" data-suggested-kcal={validSuggestion}>
          <p className="bilan-note">
            {t('Suggested daily target from Dynamic TDEE: {0} kcal', fmt(validSuggestion))}
          </p>
          <Button size="sm" variant="tinted" disabled={status.busy} onClick={applySuggestedKcal}>
            {activeGoal
              ? t('Adjust goal to {0} kcal', validSuggestion)
              : t('Use {0} kcal', fmt(validSuggestion))}
          </Button>
        </section>
      )}

      {!rows.length && <p className="card">{t('No goal for this day')}</p>}

      {rows.map(goal => {
        const hasTraining = hasAnyTrainingOverride(goal)
        const definedQuality = QUALITY_KEYS.filter(k => goal.targets?.[k] != null)
        return (
          <section className="card" key={goal.id}>
            <h3>{t(modes[goal.mode])}</h3>
            <p>{fmtDate(goal.start, true, true)} — {goal.end ? fmtDate(goal.end, true, true) : t('No end date')}</p>

            {hasTraining ? <GoalComparison goal={goal} /> : <NutrientValues values={goal.targets} />}

            <div className="bilan-goal-meta">
              <span className="bilan-goal-chip" data-water-target="true">
                💧 {t('Water target')}: <strong>{fmt(goal.waterTargetMl ?? DEFAULT_WATER_TARGET_ML)} ml</strong>
              </span>
              {definedQuality.map(k => {
                const isMax = k !== 'fiber'
                return (
                  <span className="bilan-goal-chip" key={k} data-quality-chip={k}>
                    {t(labels[k])}: <strong>{fmt(goal.targets[k])} g</strong>{isMax ? ` (${t('max')})` : ''}
                  </span>
                )
              })}
            </div>

            <div className="nutrition-actions">
              <Button size="sm" disabled={status.busy} onClick={() => setEditor(goal)}>{t('Edit')}</Button>
              <DeleteAction name={t('Nutrition goal')} busy={status.busy} remove={() => service.remove('nutritionGoals', goal)} />
            </div>
          </section>
        )
      })}
    </>
  )
}
