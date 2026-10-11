import assert from 'node:assert/strict'
import { test, vi } from 'vitest'
import { backupFixture, revised } from './backup.test-util.js'
import { journal, library, hasCode } from './persistence.test-util.js'
import { entry } from './fixtures.test-util.js'
import { keyOf, RECEIPTS } from './backup-contract.js'
import { readNutritionBackup } from './backup.js'
const key = keyOf('foodEntries', 'entry-1')
const rows = state => state.domains.flatMap(p => p.records.foodEntries ?? [])
const variants = state => state.domains.flatMap(p => Object.values(p.extensions?.nutritionSyncConflicts?.records ?? {}))
async function source(value = journal()) { const f = await backupFixture(); await f.commit(value); return (await f.service().export()).blob }
for (const kind of ['idb', 'fs']) {
  test(`empty restore, immutable preview and receipts survive reopen/later edits (${kind})`, async () => {
    const blob = await source(), f = await backupFixture(kind), service = f.service()
    const preview = await service.preview(blob, { restoreId: 'restore-one', mode: 'empty' })
    assert.equal((await f.store.read()).status, 'empty'); assert.equal(preview.applicable, true)
    preview.counts.foodEntries = 99; preview.mode = 'replace'; preview.operations.additions = 999
    assert.equal((await service.restore(preview)).status, 'restored'); assert.deepEqual(rows(await f.store.read()), journal().records.foodEntries)
    assert.equal((await service.restore(preview)).repeated, true)
    await f.reopen()
    const latest = await f.store.read(), domain = revised(latest.domains.find(p => p.kind === 'journal'), 2, 100)
    domain.records.foodEntries[0].quantity.amount = 99; await f.commit(domain, 'later-edit')
    const again = f.service(), replay = await again.preview(blob, { restoreId: 'restore-one', mode: 'empty' })
    assert.equal((await again.restore(replay)).repeated, true); assert.equal(rows(await f.store.read())[0].quantity.amount, 99)
    await assert.rejects(again.preview(blob, { restoreId: 'restore-one', mode: 'merge' }), hasCode('reused_restore_id'))
    assert.equal((await readNutritionBackup((await again.export()).blob)).current.some(p => p.extensions?.[RECEIPTS]), false)
  })
  test(`frozen operations survive merge, collection and reopen (${kind})`, async () => {
    const blob = await source(journal({ records: { foodEntries: [entry({ id: 'imported' })] } })), f = await backupFixture(kind)
    await f.commit(); const frozen = await f.store.beginPending(), service = f.service()
    const preview = await service.preview(blob, { restoreId: 'with-offline' }); assert.equal(preview.pendingOperations, 1)
    await service.restore(preview); await f.store.collect(); await f.reopen()
    assert.deepEqual(await f.store.beginPending(), frozen)
    assert.equal((await f.store.read()).pendingOperations.length, 2); assert.equal(rows(await f.store.read()).length, 2)
  })
  test(`divergent data requires explicit choice; all variants are retained (${kind})`, async () => {
    const blob = await source(), f = await backupFixture(kind), local = journal(); local.records.foodEntries[0].quantity.amount = 70
    await f.commit(local); const service = f.service(), preview = await service.preview(blob, { restoreId: 'conflict' })
    assert.equal(preview.conflicts.length, 1); await assert.rejects(service.restore(preview), hasCode('restore_conflicts_require_resolution'))
    const originalHead = (await f.store.read()).head
    preview.conflicts.length = 0; preview.applicable = true
    await assert.rejects(service.restore(preview), hasCode('restore_conflicts_require_resolution'))
    assert.deepEqual((await f.store.read()).head, originalHead)
    assert.equal(rows(await f.store.read())[0].quantity.amount, 70)
    const allowed = await service.preview(blob, { restoreId: 'conflict-chosen', choices: { [key]: { action: 'use-backup' } } })
    await service.restore(allowed); const result = await f.store.read()
    assert.equal(rows(result)[0].quantity.amount, 50)
    assert.equal(variants(result).some(v => v.record.quantity.amount === 70), true)
  })
  test(`stale preview and forged preview cannot publish (${kind})`, async () => {
    const f = await backupFixture(kind), blob = await source(), service = f.service(), preview = await service.preview(blob, { restoreId: 'stale' })
    await f.commit(journal({ records: { foodEntries: [entry({ id: 'new' })] } }))
    await assert.rejects(service.restore(preview), hasCode('stale_restore_preview'))
    await assert.rejects(service.restore({ ...preview }), hasCode('unknown_restore_preview'))
    assert.equal(rows(await f.store.read())[0].id, 'new')
  })
}

test('complete library, recipes, templates, goals and explicit empty arrays reconstruct faithfully', async () => {
  const blob = await source(library()), f = await backupFixture(), service = f.service()
  await service.restore(await service.preview(blob, { restoreId: 'all-library', mode: 'empty' }))
  assert.deepEqual((await f.store.read()).domains.find(p => p.id === library().id).records, library().records)
})

test('an imported library sharing the preparation journal identity retains its user records', async () => {
  const original = library({ id: 'library-backup-preparations' })
  const blob = await source(original), f = await backupFixture(), service = f.service()
  await service.restore(await service.preview(blob, { restoreId: 'journal-identity', mode: 'empty' }))
  await f.reopen()
  assert.deepEqual((await f.store.read()).domains.find(p => p.id === original.id).records, original.records)
  assert.equal((await f.service().recoveryStatus()).restores[0].status, 'completed')
})

test('keep-local and copy-backup resolve conflicts without recycling identity', async () => {
  const blob = await source(), f = await backupFixture(), local = journal(); local.records.foodEntries[0].quantity.amount = 88; await f.commit(local)
  const service = f.service(); await service.restore(await service.preview(blob, { restoreId: 'keep', choices: { [key]: { action: 'keep-local' } } }))
  assert.equal(rows(await f.store.read())[0].quantity.amount, 88)
  await service.restore(await service.preview(blob, { restoreId: 'copy', choices: { [key]: { action: 'copy-backup', newId: 'copy-one' } } }))
  assert.equal(rows(await f.store.read()).length, 2)
  await assert.rejects(service.preview(blob, { restoreId: 'collision', choices: { [key]: { action: 'copy-backup', newId: 'copy-one' } } }), hasCode('restore_id_collision'))
})

test('replace requires explicit intent, archives known removed rows and keeps pending operations', async () => {
  const blob = await source(journal({ records: { foodEntries: [] } })), f = await backupFixture(); await f.commit(revised(journal(), 0, 12)); await f.store.beginPending()
  const service = f.service(); await assert.rejects(service.preview(blob, { restoreId: 'replace', mode: 'replace' }), hasCode('replace_requires_explicit_intent'))
  const preview = await service.preview(blob, { restoreId: 'replace', mode: 'replace', allowReplace: true }); assert.equal(preview.operations.deletions, 1)
  await service.restore(preview); const state = await f.store.read()
  assert.equal(rows(state).length, 0); assert.equal(state.pendingOperations.length, 2)
  assert.equal(state.domains.flatMap(p => p.sync.tombstones).some(m => m.id === 'entry-1'), true)
  assert.equal(variants(state).some(v => v.id === 'entry-1'), true)
})

test('permanent deleted ids require a new id, imported tombstones do not delete target rows', async () => {
  const blob = await source(), f = await backupFixture(), deleted = revised(journal(), 0, 20)
  deleted.records.foodEntries = []; deleted.sync.edits = []; deleted.sync.tombstones = [{ collection: 'foodEntries', id: 'entry-1', stamp: { counter: 20, deviceId: 'target-device' } }]
  await f.commit(deleted); const service = f.service(), preview = await service.preview(blob, { restoreId: 'deleted' })
  assert.equal(preview.conflicts[0].kind, 'permanently-deleted-id')
  await service.restore(await service.preview(blob, { restoreId: 'new-id', choices: { [key]: { action: 'copy-backup', newId: 'resurrected-copy' } } }))
  assert.equal(rows(await f.store.read())[0].id, 'resurrected-copy')
  const deletionArchive = await source(deleted), recipient = await backupFixture(); await recipient.commit()
  const importer = recipient.service(); await importer.restore(await importer.preview(deletionArchive, { restoreId: 'informational' }))
  assert.equal(rows(await recipient.store.read()).length, 1)
  assert.equal((await recipient.store.read()).domains.some(p => p.extensions?.nutritionBackupTombstones), true)
})

test('field erasure and singleton copy are refused rather than silently changed', async () => {
  const blob = await source(), f = await backupFixture(), local = journal(); local.records.foodEntries[0].notes = 'saved'; await f.commit(local)
  const service = f.service(), p = await service.preview(blob, { restoreId: 'no-erase', mode: 'replace', allowReplace: true })
  assert.equal(p.conflicts[0].kind, 'field-erasure-requires-new-id')
  await assert.rejects(service.restore(p), hasCode('restore_conflicts_require_resolution'))
})

test('unknown and unused choices fail closed, nonempty storage rejects empty mode', async () => {
  const f = await backupFixture(), blob = await source(); await f.commit()
  await assert.rejects(f.service().preview(blob, { restoreId: 'empty', mode: 'empty' }), hasCode('restore_requires_empty_storage'))
  await assert.rejects(f.service().preview(blob, { restoreId: 'choice', choices: { missing: { action: 'keep-local' } } }), hasCode('unused_restore_choice'))
})

test('global restoration is blocked before writes; Nutrition-only intent is operational', async () => {
  const origin = await backupFixture(); await origin.commit()
  const blob = (await origin.service({ getWorkouts: () => ({ workouts: [{ id: 'w' }], routines: [] }) }).export()).blob
  const f = await backupFixture(), service = f.service(), global = await service.preview(blob, { restoreId: 'global' })
  assert.equal(global.applicable, false); await assert.rejects(service.restore(global), hasCode('global_restore_not_atomic')); assert.equal((await f.store.read()).status, 'empty')
  await service.restore(await service.preview(blob, { restoreId: 'nutrition-only', datasets: 'nutrition' })); assert.equal(rows(await f.store.read()).length, 1)
  const old = await service.preview(new Blob(['{"workouts":[],"routines":[]}']), { restoreId: 'legacy' })
  assert.equal(old.sections.nutrition, false); assert.equal(rows(await f.store.read()).length, 1)
})

test('account change after preview blocks writes and does not reveal previous account data', async () => {
  const namespace = { serverOrigin: 'https://gym.example', profileId: 'alice' }, f = await backupFixture('idb', { namespace }), blob = await source(), service = f.service()
  const preview = await service.preview(blob, { restoreId: 'account' }); f.session.value = { ...f.session.value, userId: 'bob', epoch: 2 }
  await assert.rejects(service.restore(preview), hasCode('backup_session_changed')); assert.equal((await f.store.read()).status, 'empty')
  await assert.rejects(service.export(), hasCode('backup_session_mismatch'))
})

test('storage estimate blocks known insufficient space without treating unavailable estimates as a guarantee', async () => {
  const f = await backupFixture(), blob = await source(), spy = vi.spyOn(f.store, 'storageStatus').mockResolvedValue({ estimate: { quota: 100, usage: 99 } })
  const service = f.service(), preview = await service.preview(blob, { restoreId: 'quota-preview' })
  assert.equal(preview.space.sufficient, false); await assert.rejects(service.restore(preview), hasCode('backup_insufficient_space')); spy.mockRestore()
})

test('frozen and delivery variants are exported and imported as archives, not device requests', async () => {
  const f = await backupFixture(); await f.commit(); await f.store.beginPending()
  const latest = revised(journal()); latest.records.foodEntries[0].quantity.amount = 90; await f.commit(latest, 'latest')
  const blob = (await f.service().export()).blob, archive = await readNutritionBackup(blob)
  assert.equal(archive.retained.length, 1)
  const b = await backupFixture(), service = b.service(); await service.restore(await service.preview(blob, { restoreId: 'retain' }))
  const state = await b.store.read(); assert.equal(rows(state)[0].quantity.amount, 90)
  assert.equal(variants(state).some(v => v.record.quantity.amount === 50), true); assert.equal(state.pendingOperations.length, 1)
})

test('ordinary local edits and clean remote pulls cannot drop restore receipts', async () => {
  const blob = await source(), f = await backupFixture(), s = f.service(); await s.restore(await s.preview(blob, { restoreId: 'protected-receipt' }))
  const state = await f.store.read(), receiptPart = structuredClone(state.domains.find(p => p.extensions?.[RECEIPTS]))
  delete receiptPart.extensions; receiptPart.sync.revision++; receiptPart.sync.writeId = 'drop'
  await assert.rejects(f.commit(receiptPart, 'drop-receipt'), hasCode('history_metadata_missing'))
  assert.equal((await s.restore(await s.preview(blob, { restoreId: 'protected-receipt' }))).repeated, true)
})

test('large frozen snapshots shard into v1 archives instead of overflowing their original month', async () => {
  const { food } = await import('./fixtures.test-util.js'), a = await backupFixture(), snapshot = food({ metadata: { padding: 'x'.repeat(3000) } })
  const original = journal({ records: { foodEntries: Array.from({ length: 200 }, (_, n) => entry({ id: `bulk-${n}`, snapshot })) } })
  await a.commit(original); await a.store.beginPending()
  const latest = revised(original, 1, 100); for (const row of latest.records.foodEntries) row.quantity.amount = 100
  await a.commit(latest, 'bulk-update')
  const blob = (await a.service().export()).blob, b = await backupFixture(), s = b.service()
  await s.restore(await s.preview(blob, { restoreId: 'large-frozen', mode: 'empty' }))
  const state = await b.store.read(), shards = state.domains.filter(p => p.id.startsWith('library-bv-'))
  assert.ok(shards.length >= 2); assert.equal(variants(state).length, 200)
  assert.equal(rows(state).length, 200); assert.ok(rows(state).every(row => row.quantity.amount === 100))
  assert.equal((await b.store.verify()).status, 'current')
}, 30000)

test('generated archive shard ids cannot overwrite an imported library partition', async () => {
  const { contentHash } = await import('./persistence-contract.js'), restoreId = 'reserved-partition'
  const restoreKey = await contentHash({ restoreId }), variant = { collection: 'foodEntries', id: 'entry-1', record: entry(), marker: null }
  const original = library({ id: `library-bv-${restoreKey.slice(0, 56)}-0`, extensions: { nutritionSyncConflicts: { version: 1, records: { [await contentHash(variant)]: variant } } } })
  const blob = await source(original), f = await backupFixture(), s = f.service()
  await s.restore(await s.preview(blob, { restoreId, mode: 'empty' }))
  assert.deepEqual((await f.store.read()).domains.find(p => p.id === original.id).records, original.records)
  assert.equal(variants(await f.store.read()).length, 1)
})
