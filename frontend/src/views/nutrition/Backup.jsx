import { useEffect, useRef, useState } from 'react'
import { Button } from '../../components/ui.jsx'
import { t } from '../../lib/i18n.js'
import { saveNutritionBackup } from '../../lib/nutrition/backup-file.js'
import { check, contentHash } from '../../lib/nutrition/persistence-contract.js'
import { sha256Hex } from '../../../../api/shared/sha256.js'
import { ErrorNotice, Field, Select, useRead, fmt } from './common.jsx'

const actions = { 'keep-local': 'Keep current data', 'use-backup': 'Use backup version', 'copy-backup': 'Import as a separate copy' }
const modes = { merge: 'Merge', empty: 'Restore into empty storage', replace: 'Replace known local data' }
export default function Backup({ service, status }) {
  const [file, setFile] = useState(null), [mode, setMode] = useState('merge'), [replace, setReplace] = useState(false), [preview, setPreview] = useState(null)
  const [choices, setChoices] = useState({}), [error, setError] = useState(null), [message, setMessage] = useState(''), [busy, setBusy] = useState(false), pending = useRef(false), alive = useRef(true)
  const [needsPreview, setNeedsPreview] = useState(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const recovery = useRead(service, status.revision, { recovery: true }, () => service.recovery())
  const work = async fn => {
    if (pending.current || status.busy) return
    pending.current = true; setBusy(true); setError(null); setMessage('')
    try { await fn() } catch (e) { if (alive.current) setError(e) } finally { pending.current = false; if (alive.current) setBusy(false) }
  }
  const inspect = () => work(async () => {
    check(file && file.size <= 33 * 1024 * 1024, 'backup', 'backup_too_large')
    const fileHash = await sha256Hex(new Uint8Array(await file.arrayBuffer()))
    const restoreId = `ui-${await contentHash({ fileHash, mode, choices })}`
    const result = await service.preview(file, { restoreId, mode, choices, allowReplace: replace, datasets: 'nutrition' })
    if (alive.current) { setPreview(result); setNeedsPreview(false) }
  })
  const disabled = busy || status.busy
  return <><section className="card"><h2>{t('Nutrition backup')}</h2><p className="muted">{t('Nutrition only. Training backups remain in Settings. Global restoration is unavailable.')}</p>
    <Button variant="primary" disabled={disabled} onClick={() => work(async () => {
      const result = await service.export()
      if (!alive.current) return
      const saved = await saveNutritionBackup(result, { guard: () => { check(alive.current, 'backup', 'backup_cancelled'); service.assertCurrent() } })
      if (alive.current) setMessage(t(saved.status === 'shared' ? 'Share opened. Check that your backup was saved externally.' : 'Download requested. Check that your backup file was saved.'))
    })}>{t('Export Nutrition')}</Button>
  </section><section className="card"><h2>{t('Restore Nutrition')}</h2>
    <Field label="Backup file"><input className="field" type="file" accept=".zip,.json,application/zip,application/json" disabled={disabled} onChange={e => { setFile(e.target.files?.[0] ?? null); setPreview(null); setChoices({}); setReplace(false); setError(null) }} /></Field>
    <Select disabled={disabled} label="Restore mode" value={mode} onChange={v => { setMode(v); setPreview(null); setChoices({}); setReplace(false) }} options={Object.entries(modes).map(([value, label]) => ({ value, label: t(label) }))} />
    {mode === 'replace' && <label className="nutrition-check"><input type="checkbox" checked={replace} disabled={disabled} onChange={e => { setReplace(e.target.checked); setPreview(null) }} />{t('I explicitly authorize replacing known local Nutrition data. Server-only data and pending operations are preserved.')}</label>}
    <p className="muted small">{t('Preview does not change data. Restore creates local changes awaiting synchronization.')}</p>
    <Button disabled={disabled || !file || mode === 'replace' && !replace} onClick={inspect}>{t('Verify and preview')}</Button>
    {preview && <div className="nutrition-preview"><h3>{t('Backup preview')}</h3>
      <p>{t('Nutrition')}: {preview.sections.nutrition ? t('Present') : t('Absent')} · {t('Workouts')}: {preview.sections.workouts ? t('Present') : t('Absent')}</p>
      <dl>{Object.entries(preview.counts).map(([key, count]) => <div key={key}><dt>{t(({ foodEntries: 'Food entries', customFoods: 'Personal foods', savedFoods: 'Saved foods', recipes: 'Recipes', mealTemplates: 'Meal templates', nutritionGoals: 'Nutrition goals', nutritionSettings: 'Nutrition settings', workouts: 'Workouts', routines: 'Routines' })[key] ?? 'Records')}</dt><dd>{fmt(count)}</dd></div>)}</dl>
      {preview.operations && <p>{t('Additions: {0}; replacements: {1}; deletions: {2}', preview.operations.additions, preview.operations.replacements, preview.operations.deletions)}</p>}
      {preview.pendingOperations > 0 && <p>{t('{0} pending operations will be preserved', preview.pendingOperations)}</p>}
      {preview.space && <p>{t('Estimated write size')}: {fmt(preview.space.estimatedWriteBytes / 1024)} KiB · {t('Available space')}: {preview.space.available === null ? t('Unknown') : `${fmt(preview.space.available / 1024)} KiB`}</p>}
      {preview.space?.sufficient === false && <p role="alert">{t('Storage is full. Export a backup before freeing space.')}</p>}
      {preview.sections.workouts && <p role="alert">{t('Only Nutrition will be restored. Training data is unchanged.')}</p>}
      {!!preview.retainedPartitions && <p>{t('Retained versions are preserved as conflict archives.')}</p>}
      {!preview.sections.nutrition && <p>{t('Use the existing training import in Settings for this file.')}</p>}
      {preview.conflicts?.map(conflict => <Select disabled={disabled} key={conflict.key} label="Restore conflict" value={choices[conflict.key]?.action ?? ''} onChange={async action => {
        const choice = action === 'copy-backup' ? { action, newId: `copy-${(await contentHash({ digest: preview.digest, key: conflict.key })).slice(0, 40)}` } : { action }
        if (alive.current) { setChoices(v => ({ ...v, [conflict.key]: choice })); setNeedsPreview(true) }
      }} options={[{ value: '', label: t('Choose an action') }, ...conflict.actions.map(action => ({ value: action, label: `${t(actions[action])} · ${conflict.collection} · ${conflict.id}` }))]} />)}
      {!!preview.conflicts?.length && <p>{t('Resolve the conflicts, then verify the preview again.')}</p>}
      <Button variant="primary" disabled={disabled || needsPreview || !preview.applicable || mode === 'replace' && !replace} onClick={() => work(async () => {
        await service.restore(preview)
        if (alive.current) { setPreview(null); setMessage(t('Nutrition restored locally. Synchronization is pending.')) }
      })}>{t('Confirm Nutrition restoration')}</Button>
    </div>}
  </section>
    {busy && <p role="status">{t('Working…')}</p>}<ErrorNotice error={error} />{message && <p role="status">{message}</p>}
    <ErrorNotice error={recovery.error} />{recovery.data?.restores.some(row => row.status !== 'completed') && <section className="card"><h3>{t('Interrupted restoration')}</h3><p>{t('An unfinished restoration is preserved. Select the same backup and options to retry; if data changed, review a new preview. No pending operation was removed.')}</p></section>}
  </>
}
