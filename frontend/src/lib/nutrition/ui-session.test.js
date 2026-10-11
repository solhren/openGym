import { afterEach, test, expect, vi } from 'vitest'
import { createNutritionUISession } from './ui-session.js'
import { backupFixture } from './backup.test-util.js'
import { entry, food } from './fixtures.test-util.js'
import { environment, gate, entry as remoteEntry } from './sync.test-util.js'
const cleanups = []
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); vi.useRealTimers() })
const session = client => {
  const ui = createNutritionUISession({ store: client.store, session: client.session.value, getSession: () => client.session.value, transport: client.transport, online: () => false })
  cleanups.push(() => ui.close()); return ui
}
test('offline UI status never reports server success; remount/reopen retains real data and outbox', async () => {
  const f = await backupFixture(), ui = session(f)
  await ui.save('foodEntries', entry())
  expect(ui.getSnapshot().syncStatus).toBe('local'); expect(ui.getSnapshot().pending).toBe(1)
  expect((await ui.day(entry().d)).entries).toHaveLength(1)
  await f.reopen(); expect((await f.store.read()).pendingOperations).toHaveLength(1)
})
test('a successful publication remains a successful save if subsequent status inspection fails', async () => {
  const f = await backupFixture(), ui = session(f)
  f.store.inspect = async () => { throw Error('read failure') }
  await ui.save('customFoods', food())
  expect(ui.getSnapshot().error).toBeTruthy(); expect(ui.getSnapshot().revision).toBe(1)
  expect((await f.store.readLibrary()).domains[0].records.customFoods).toHaveLength(1)
})
test('ABA session changes reject reads, exports and writes without erasing pending operations', async () => {
  const f = await backupFixture(), ui = session(f)
  await ui.save('foodEntries', entry()); f.session.value = { ...f.session.value, epoch: 3 }
  await expect(ui.day(entry().d)).rejects.toThrow()
  await expect(ui.export()).rejects.toThrow()
  await expect(ui.save('customFoods', food())).rejects.toThrow()
  expect((await f.store.read()).pendingOperations).toHaveLength(1)
})
test('two UI devices synchronize real records, reconnect, preserve concurrent variants and deletions', async () => {
  const f = await environment(), a = await f.client('a'), b = await f.client('b')
  let connected = false
  const make = c => { const ui = createNutritionUISession({ store: c.store, session: c.session.value, getSession: () => c.session.value, transport: f.transport, online: () => connected }); cleanups.push(() => ui.close()); return ui }
  const ua = make(a), ub = make(b), original = remoteEntry()
  await ua.save('foodEntries', original)
  expect((await ua.synchronize()).status).toBe('offline'); expect(ua.getSnapshot().pending).toBe(1)
  connected = true; expect((await ua.synchronize()).status).toBe('synced'); await ub.synchronize()
  await ua.save('foodEntries', { ...original, quantity: { amount: 90, unit: 'g' } }, original)
  await ub.save('foodEntries', { ...original, quantity: { amount: 120, unit: 'g' } }, original)
  await ua.synchronize(); await ub.synchronize(); await ua.synchronize()
  expect((await ua.conflicts()).length).toBeGreaterThan(0)
  const live = (await ua.day(original.d)).entries[0]
  await ua.remove('foodEntries', live); expect(await ua.synchronize()).toMatchObject({ status: 'synced' }); expect(await ub.synchronize()).toMatchObject({ status: 'synced' })
  expect((await ub.day(original.d)).entries).toEqual([]); expect(ub.getSnapshot().pending).toBe(0)
})
test('restore during a lost/late publication retains frozen operations; stale status cannot overwrite restore', async () => {
  const f = await environment(), a = await f.client('a'), b = await f.client('b'), pause = gate()
  const make = c => { const ui = createNutritionUISession({ store: c.store, session: c.session.value, getSession: () => c.session.value, transport: f.transport }); cleanups.push(() => ui.close()); return ui }
  const ua = make(a), ub = make(b)
  await ua.save('foodEntries', remoteEntry()); await ub.save('foodEntries', remoteEntry({ id: 'backup-entry' }))
  const exported = await ub.export()
  f.hooks.after = async call => { if (call.method === 'POST') await pause.wait() }
  const sending = ua.synchronize(); await pause.entered
  const preview = await ua.preview(exported.blob, { restoreId: 'late-ui', datasets: 'nutrition' })
  await ua.restore(preview)
  expect((await sending).status).toBe('session-changed'); expect(ua.getSnapshot().syncStatus).toBe('pending')
  expect((await a.store.read()).pendingOperations).toHaveLength(2)
  pause.release(); f.hooks.after = null
  expect((await ua.synchronize()).status).toBe('synced'); expect((await ua.day(remoteEntry().d)).entries).toHaveLength(2)
})
