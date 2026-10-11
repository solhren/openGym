import assert from 'node:assert/strict'
import { test } from 'vitest'
import { environment, markedDomain, marker, gate } from './sync.test-util.js'
import { createNutritionBackup, readNutritionBackup } from './backup.js'
import { keyOf } from './backup-contract.js'
const key = keyOf('foodEntries', 'entry-a')
const service = (client, sync) => createNutritionBackup({ store: client.store, getSession: () => client.session.value, sync })
const entries = state => state.domains.flatMap(p => p.records.foodEntries ?? [])
const archives = state => state.domains.flatMap(p => Object.values(p.extensions?.nutritionSyncConflicts?.records ?? {}))

test('A exports, B imports offline; publication and two-device edits preserve all variants', async () => {
  const f = await environment(), a = await f.client(), b = await f.client('b')
  await a.commit(); assert.equal((await a.makeSync().run()).status, 'synced')
  const blob = (await service(a).export()).blob, sb = service(b)
  await sb.restore(await sb.preview(blob, { restoreId: 'transfer', mode: 'empty' }))
  assert.equal((await b.store.read()).pendingOperations.length, 1)
  assert.equal((await b.makeSync().run()).status, 'synced')
  await a.edit(row => { row.quantity.amount = 70 }, 100)
  await b.edit(row => { row.quantity.amount = 90 }, 100)
  assert.equal((await a.makeSync().run()).status, 'synced'); assert.equal((await b.makeSync().run()).status, 'synced')
  await a.makeSync().run(); const final = await a.store.read()
  assert.equal(archives(final).some(v => v.record.quantity.amount === 70), true)
  assert.equal(archives(final).some(v => v.record.quantity.amount === 90), true)
})

test('older backup imported while server is newer preserves remote-only rows and both colliding values', async () => {
  const f = await environment(), a = await f.client(), b = await f.client('b')
  await a.commit(); await a.makeSync().run(); const old = (await service(a).export()).blob
  await b.makeSync().run(); await a.edit(row => { row.quantity.amount = 200 }, 100); await a.makeSync().run()
  const sb = service(b); await sb.restore(await sb.preview(old, { restoreId: 'older' }))
  const outcome = await b.makeSync().run(); assert.equal(outcome.status, 'synced')
  assert.equal(entries(await b.store.read())[0].quantity.amount, 200)
})

test('server deletion while another device restores requires new identity; old content stays archived', async () => {
  const f = await environment(), a = await f.client(), b = await f.client('b')
  await a.commit(); await a.makeSync().run(); await b.makeSync().run()
  const blob = (await service(a).export()).blob
  await a.edit((row, part) => { part.records.foodEntries = [] }, 50); await a.makeSync().run()
  const sb = service(b); await sb.restore(await sb.preview(blob, { restoreId: 'before-delete' }))
  assert.equal((await b.makeSync().run()).status, 'synced')
  const deleted = await b.store.read(); assert.equal(entries(deleted).length, 0)
  assert.equal(archives(deleted).some(v => v.id === 'entry-a'), true)
  const preview = await sb.preview(blob, { restoreId: 'after-delete' }); assert.equal(preview.conflicts[0].kind, 'permanently-deleted-id')
  await sb.restore(await sb.preview(blob, { restoreId: 'copy-deleted', choices: { [key]: { action: 'copy-backup', newId: 'entry-restored-new' } } }))
  assert.equal((await b.makeSync().run()).status, 'synced')
  assert.equal(entries(await b.store.read())[0].id, 'entry-restored-new')
})

test('lost publication response remains durable across restore and replays exact request before restored checkpoint', async () => {
  const f = await environment(), a = await f.client(), b = await f.client('b')
  await b.commit(markedDomain({ records: { foodEntries: [{ ...markedDomain().records.foodEntries[0], id: 'backup-new' }] },
    sync: { revision: 0, writeId: null, edits: [marker('backup-new')], tombstones: [] } }))
  const blob = (await service(b).export()).blob
  await a.commit(); let lost = false
  f.hooks.after = call => { if (!lost && call.method === 'POST') { lost = true; throw Error('lost response') } }
  const sync = a.makeSync(); assert.equal((await sync.run()).status, 'offline')
  const staged = (await a.store.syncState()).delivery
  const sa = service(a, sync); await sa.restore(await sa.preview(blob, { restoreId: 'lost-response' }))
  assert.equal((await a.store.syncState()).delivery.requestDigest, staged.requestDigest)
  f.hooks.after = null; assert.equal((await sync.run()).status, 'synced')
  const posts = f.calls.filter(c => c.method === 'POST')
  assert.deepEqual(posts[0].body, posts[1].body); assert.equal(entries(await a.store.read()).length, 2)
  assert.equal((await a.store.read()).pendingOperations.length, 0)
})

test('late HTTP response after restore is ignored; replay preserves frozen request and new records', async () => {
  const f = await environment(), a = await f.client(), b = await f.client('b'), pause = gate()
  await b.commit(markedDomain({ records: { foodEntries: [{ ...markedDomain().records.foodEntries[0], id: 'later-backup' }] },
    sync: { revision: 0, writeId: null, edits: [marker('later-backup')], tombstones: [] } }))
  const blob = (await service(b).export()).blob
  await a.commit(); f.hooks.after = async call => { if (call.method === 'POST') await pause.wait() }
  const sync = a.makeSync(), running = sync.run(); await pause.entered
  const sa = service(a, sync); await sa.restore(await sa.preview(blob, { restoreId: 'late-http' }))
  assert.equal((await running).status, 'session-changed')
  pause.release(); f.hooks.after = null
  assert.equal((await a.store.read()).pendingOperations.length, 2)
  assert.equal((await sync.run()).status, 'synced'); assert.equal(entries(await a.store.read()).length, 2)
})

test('delivery-only remote values are included in backups without transplanting server receipts', async () => {
  const f = await environment(), a = await f.client(), b = await f.client('b')
  await a.commit(); await a.makeSync().run(); await b.makeSync().run()
  await a.edit(row => { row.quantity.amount = 250 }, 100); await a.makeSync().run()
  await b.edit(row => { row.quantity.amount = 90 }, 10)
  f.hooks.before = call => { if (call.method === 'PUT') throw Error('offline before upload') }
  assert.equal((await b.makeSync().run()).status, 'offline')
  assert.ok((await b.store.syncState()).delivery)
  const archive = await readNutritionBackup((await service(b).export()).blob)
  assert.ok(archive.retained.length > 0)
  assert.equal(archive.retained.some(p => p.records.foodEntries?.some(row => row.quantity.amount === 250)), true)
  assert.equal(JSON.stringify(archive.manifest).includes('requestDigest'), false)
})

test('two devices restore independently; additive receipts/markers survive reconciliation', async () => {
  const f = await environment(), a = await f.client(), b = await f.client('b'), c = await f.client('c')
  await c.commit(); const blob = (await service(c).export()).blob
  const sa = service(a), sb = service(b)
  await sa.restore(await sa.preview(blob, { restoreId: 'device-a' })); await sb.restore(await sb.preview(blob, { restoreId: 'device-b' }))
  assert.equal((await a.makeSync().run()).status, 'synced'); assert.equal((await b.makeSync().run()).status, 'synced')
  await a.makeSync().run()
  const receipts = (await a.store.read()).domains.flatMap(p => Object.keys(p.extensions?.nutritionBackupRestores?.records ?? {}))
  assert.equal(new Set(receipts).size, 2)
})
