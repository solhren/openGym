import assert from 'node:assert/strict'
import { test } from 'vitest'
import { environment, markedDomain, marker, entry, gate, scope } from './sync.test-util.js'
import { hasCode } from './persistence.test-util.js'
import { Readable } from 'node:stream'
import { nutritionRoutes } from '../../../../api/nutrition/routes.js'

for (const kind of ['idb', 'fs']) {
  test(`Nutrition ${kind}: local writes precede network, exact receipts drain the outbox and pull to another device`, async () => {
    const f = await environment(), a = await f.client('a', kind), b = await f.client('b', kind)
    await a.commit(); assert.equal(f.calls.length, 0)
    assert.equal((await a.makeSync().run()).status, 'synced')
    assert.equal((await a.store.read()).pendingOperations.length, 0)
    assert.equal((await b.makeSync().run()).status, 'synced')
    assert.deepEqual((await b.store.read()).domains[0].records.foodEntries, [entry()])
    const before = (await b.store.read()).head
    assert.equal((await b.makeSync().run()).status, 'synced')
    assert.deepEqual((await b.store.read()).head, before) // no empty local publications on polls
  })
  test(`Nutrition ${kind}: lost publication response, restart, GC and later edits retain the exact request`, async () => {
    const f = await environment(), a = await f.client('a', kind)
    await a.commit()
    let lost = true
    f.hooks.after = call => { if (call.method === 'POST' && lost) { lost = false; throw new Error('response lost') } }
    assert.equal((await a.makeSync().run()).status, 'offline')
    const delivery = (await a.store.syncState()).delivery
    assert.ok(delivery); await a.store.collect()
    await a.reopen()
    assert.deepEqual((await a.store.syncState()).delivery, delivery)
    await a.edit(row => { row.quantity.amount = 90 })
    assert.deepEqual((await a.store.syncState()).delivery, delivery)
    const b = await f.client('b'); await b.makeSync().run(); await b.edit(row => { row.meal = 'dinner' }, 11)
    assert.equal((await b.makeSync().run()).status, 'synced')
    assert.equal((await a.makeSync().run()).status, 'synced')
    const posts = f.calls.filter(c => c.method === 'POST')
    assert.deepEqual(posts[0].body, posts.find((p, i) => i > 0 && p.body.head.commitId === posts[0].body.head.commitId).body)
    assert.equal((await a.store.read()).pendingOperations.length, 0)
    assert.equal((await a.store.read()).domains[0].records.foodEntries[0].meal, 'dinner')
    assert.ok((await a.store.read()).domains[0].extensions.nutritionSyncConflicts)
  })
  test(`Nutrition ${kind}: incomplete staging never acknowledges or purges the frozen operation`, async () => {
    const f = await environment(), a = await f.client('a', kind)
    await a.commit()
    f.hooks.before = call => { if (call.method === 'PUT') throw new Error('offline during staging') }
    assert.equal((await a.makeSync().run()).status, 'offline')
    const frozen = await a.store.beginPending(), delivery = (await a.store.syncState()).delivery
    assert.equal((await f.server.store.head()).head, null)
    await a.store.collect(); await a.reopen()
    assert.deepEqual(await a.store.beginPending(), frozen)
    assert.deepEqual((await a.store.syncState()).delivery, delivery)
    f.hooks.before = null
    assert.equal((await a.makeSync().run()).status, 'synced')
  })
}

test('Nutrition rebases an actual stale-head HTTP 409 without losing either device additions', async () => {
  const f = await environment(), a = await f.client('a'), b = await f.client('b'), pause = gate()
  await a.commit(); await b.commit(markedDomain({ id: 'journal-2026-10-device-b-0', records: { foodEntries: [entry({ id: 'entry-b' })] },
    sync: { revision: 0, writeId: null, edits: [marker('entry-b', 1, 'b')], tombstones: [] } }))
  let once = true
  f.hooks.before = async call => { if (call.method === 'POST' && call.body.head.commitId.includes('a-') && once) { once = false; await pause.wait() } }
  // Distinct devices run concurrently (different JS realms in production); bypass the
  // module-wide optimization through different lock keys, leaving actual durable CAS intact.
  const proxy = { ...b.store, scopeId: `${b.store.scopeId}-device-b`, scope: b.store.scope }
  const { createNutritionSync } = await import('./sync.js')
  const runA = a.makeSync().run(); await pause.entered
  const runB = createNutritionSync({ store: proxy, getSession: () => b.session.value, transport: f.transport, newId: () => 'b-concurrent' }).run()
  assert.equal((await runB).status, 'synced'); pause.release()
  assert.equal((await runA).status, 'synced')
  const state = await a.store.read()
  assert.deepEqual(state.domains.flatMap(p => p.records.foodEntries ?? []).map(e => e.id).sort(), ['entry-a', 'entry-b'])
  assert.equal(state.pendingOperations.length, 0)
  assert.equal(f.calls.filter(c => c.method === 'POST' && c.body.head.commitId.includes('a-')).length, 2)
})

test('Nutrition deletion survives an edit from a device offline for years and keeps the losing snapshot', async () => {
  const f = await environment(), a = await f.client('a'), b = await f.client('b')
  await a.commit(); await a.makeSync().run(); await b.makeSync().run()
  await a.edit(row => { row.quantity.amount = 150 }, 1000)
  await b.edit((row, part) => { part.records.foodEntries = [] }, 20)
  assert.equal((await b.makeSync().run()).status, 'synced')
  await b.store.collect(); await b.reopen()
  assert.equal((await a.makeSync().run()).status, 'synced')
  const state = await a.store.read()
  assert.equal(state.domains[0].records.foodEntries?.length ?? 0, 0)
  assert.equal(state.domains[0].sync.tombstones[0].stamp.counter, 1000)
  assert.ok(Object.values(state.domains[0].extensions.nutritionSyncConflicts.records).some(v => v.record.quantity.amount === 150))
})

test('Nutrition session switch and late response cannot acknowledge or import into a new account', async () => {
  const f = await environment(), a = await f.client(), pause = gate()
  await a.commit()
  f.hooks.after = async call => { if (call.method === 'POST') await pause.wait() }
  const sync = a.makeSync(), run = sync.run(); await pause.entered
  a.session.value = { ...a.session.value, userId: 'bob', epoch: 2 }; sync.cancel()
  assert.equal((await run).status, 'session-changed')
  assert.equal((await a.store.read()).pendingOperations.length, 1)
  pause.release(); await Promise.resolve()
  assert.equal((await a.store.read()).pendingOperations.length, 1)
  assert.equal((await sync.run()).status, 'blocked')
  a.session.value = { userId: 'alice', serverOrigin: scope.namespace.serverOrigin, epoch: 3 }
  assert.equal((await a.makeSync().run()).status, 'synced')
})

test('Nutrition detects another-tab cookie owner mismatch before any Nutrition request', async () => {
  const f = await environment(), a = await f.client(); await a.commit()
  const sync = a.makeSync({ transport: async () => ({ user: { id: 'bob' } }) })
  const result = await sync.run()
  assert.equal(result.status, 'blocked'); assert.equal(result.error.issues[0].code, 'authenticated_owner_mismatch')
  assert.equal((await a.store.read()).pendingOperations.length, 1)
  assert.equal(f.calls.length, 0)
})

for (const [status, code, expected] of [[404, 'missing', 'unsupported'], [401, 'auth', 'auth-required'], [403, 'csrf', 'auth-required'],
  [429, 'nutrition-rate-limited', 'deferred'], [409, 'nutrition-busy', 'deferred'], [503, 'nutrition-server-busy', 'deferred'],
  [409, 'nutrition-commit-id-conflict', 'blocked'], [507, 'nutrition-capacity', 'blocked']]) {
  test(`Nutrition ${status}/${code} keeps all unacknowledged operations and the durable request`, async () => {
    const f = await environment(), a = await f.client(); await a.commit()
    f.hooks.before = call => { if (call.method === 'POST') throw Object.assign(new Error(code), { status, data: { code } }) }
    assert.equal((await a.makeSync().run()).status, expected)
    assert.ok((await a.store.syncState()).delivery)
    assert.equal((await a.store.read()).pendingOperations.length, 1)
    await a.store.collect(); await a.reopen(); f.hooks.before = null
    assert.equal((await a.makeSync().run()).status, 'synced')
  })
}

test('Nutrition refuses a forged or wrong-scope receipt; legacy acknowledgements cannot bypass it', async () => {
  const f = await environment(), a = await f.client(); await a.commit()
  f.hooks.after = (call, response) => { if (call.method === 'POST') response.receipt.namespace.profileId = 'bob' }
  assert.equal((await a.makeSync().run()).status, 'blocked')
  const frozen = await a.store.beginPending()
  await assert.rejects(a.store.acknowledge({ operationId: frozen.operation.id, operationDigest: frozen.operationDigest }), hasCode('durable_delivery_receipt_required'))
  assert.equal((await a.store.read()).pendingOperations.length, 1)
  f.hooks.after = null; assert.equal((await a.makeSync().run()).status, 'synced')
})

test('Nutrition concurrent runs in one coordinator share the same promise and publication', async () => {
  const f = await environment(), a = await f.client(); await a.commit()
  const sync = a.makeSync(), first = sync.run(), second = sync.run()
  assert.equal(first, second); assert.equal((await first).status, 'synced')
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1)
})

test('Nutrition missing server history never erases a previously acknowledged local journal', async () => {
  const f = await environment(), a = await f.client(); await a.commit(); await a.makeSync().run()
  const before = await a.store.read(), real = f.transport
  const transport = async (path, options) => path.includes('/nutrition/head') ?
    { ...scope, status: 'uninitialized', head: null, manifest: null, issues: [] } : real(path, options)
  assert.equal((await a.makeSync({ transport }).run()).status, 'blocked')
  assert.deepEqual(await a.store.read(), before)
})

test('Nutrition independent tabs without Web Locks publish the same first durable request', async () => {
  const f = await environment(), a = await f.client(), b = await f.client('b', 'idb', a.idb), pause = gate()
  await a.commit()
  let posts = 0
  f.hooks.before = async call => {
    if (call.method !== 'POST') return
    if (++posts === 1) await pause.wait()
    else pause.release()
  }
  const { createNutritionSync } = await import('./sync.js')
  const runA = a.makeSync({ locks: null }).run(); await pause.entered
  const runB = createNutritionSync({ store: { ...b.store, scope: b.store.scope, scopeId: `${b.store.scopeId}-other-realm` },
    getSession: () => b.session.value, transport: f.transport, locks: null, newId: () => 'tab-b' }).run()
  const results = await Promise.all([runA, runB])
  assert.deepEqual(results.map(r => r.status), ['synced', 'synced'])
  const requests = f.calls.filter(c => c.method === 'POST')
  assert.equal(requests.length, 2); assert.deepEqual(requests[0].body, requests[1].body)
  assert.equal((await a.store.read()).pendingOperations.length, 0)
})

for (const kind of ['idb', 'fs']) for (const phase of ['stage', 'ack']) {
  test(`Nutrition ${kind}: ${phase} write failure preserves operations and resumes after reopening`, async () => {
    const f = await environment(), a = await f.client('a', kind); await a.commit()
    const control = a.idb.control
    let armed = false
    const fail = () => {
      if (armed) return
      armed = true
      if (kind === 'idb') control.failAt = control.operations + 1
      else a.disk.control.failAt = a.disk.control.phases + 1
    }
    if (phase === 'stage') f.hooks.after = call => { if (call.path.includes('/nutrition/head')) fail() }
    else f.hooks.after = call => { if (call.method === 'POST') fail() }
    const result = await a.makeSync().run()
    assert.equal(result.status, 'blocked')
    assert.equal((await a.store.read()).pendingOperations.length, 1)
    await a.reopen(); f.hooks.after = null; control.failAt = null
    if (a.disk) a.disk.control.failAt = null
    assert.equal((await a.makeSync().run()).status, 'synced')
  })
}

test('Nutrition a corrupt delivery graph cannot be treated as valid or collected', async () => {
  const f = await environment(), a = await f.client(); await a.commit()
  f.hooks.before = call => { if (call.method === 'PUT') throw new Error('offline') }
  await a.makeSync().run()
  const delivery = (await a.store.syncState()).delivery
  const database = [...a.idb.control.databases.values()][0]
  database.stores.get('documents').delete(`p-${delivery.partitions[0].integrity.digest}`)
  assert.equal((await a.store.syncState()).status, 'recovery-required')
  await assert.rejects(a.store.collect(), hasCode('recovery_required'))
  await assert.rejects(a.store.verify(), hasCode('missing_partition'))
  assert.equal((await a.makeSync().run()).status, 'blocked')
  assert.equal((await a.store.read()).pendingOperations.length, 1)
})

test('Nutrition period cache is invalidated by remote imports without losing pending operations', async () => {
  const f = await environment(), a = await f.client(), b = await f.client()
  await a.commit(); await a.makeSync().run(); await b.makeSync().run()
  assert.equal((await b.store.readDay('2026-10-10')).entries[0].quantity.amount, 50)
  await a.edit(row => { row.quantity.amount = 80 }, 20); await a.makeSync().run()
  assert.equal((await b.makeSync().run()).status, 'synced')
  assert.equal((await b.store.readDay('2026-10-10')).entries[0].quantity.amount, 80)
  assert.equal((await b.store.read()).pendingOperations.length, 0)
})

test('Nutrition a logout/login ABA session change invalidates an awaiting response', async () => {
  const f = await environment(), a = await f.client(), pause = gate(); await a.commit()
  f.hooks.after = async call => { if (call.path === '/api/me') await pause.wait() }
  const sync = a.makeSync(), run = sync.run(); await pause.entered
  a.session.value = { ...a.session.value, epoch: 3 }; pause.release()
  assert.equal((await run).status, 'session-changed')
  assert.equal(f.calls.length, 1)
  assert.equal((await a.store.read()).pendingOperations.length, 1)
})

test('Nutrition coordinator integrates with API route handlers, actual workers, flock and durable filesystem receipts', async () => {
  const f = await environment(), a = await f.client()
  const user = { id: 'alice' }, exp = Date.now() + 86400000
  const routes = nutritionRoutes({ dataDir: f.server.dataDir, origin: scope.namespace.serverOrigin,
    sessionOf: () => ({ user, exp }),
    json: (res, status, data) => { res.status = status; res.body = JSON.parse(JSON.stringify(data)) } })
  let lost = true
  const transport = async (path, options = {}) => {
    if (path === '/api/me') return { user }
    const method = options.method ?? 'GET', url = new URL(path, scope.namespace.serverOrigin)
    const match = /^\/api\/nutrition\/(partitions|manifests)\/([a-f0-9]{64})$/.exec(url.pathname)
    const key = method + ' ' + (match ? `/api/nutrition/${match[1]}/{digest}` : url.pathname)
    const req = Readable.from(options.body ? [Buffer.from(options.body)] : [])
    Object.assign(req, { method, url: path, headers: { 'content-type': 'application/json' }, ...(match ? { nutritionDigest: match[2] } : {}) })
    const res = {}; await routes[key](req, res)
    if (res.status !== 200) throw Object.assign(new Error(res.body.error), { status: res.status, data: res.body })
    if (method === 'POST' && lost) { lost = false; throw new Error('response lost after worker exit') }
    return res.body
  }
  await a.commit()
  assert.equal((await a.makeSync({ transport }).run()).status, 'offline')
  const delivery = (await a.store.syncState()).delivery
  await a.reopen()
  assert.deepEqual((await a.store.syncState()).delivery, delivery)
  assert.equal((await a.makeSync({ transport }).run()).status, 'synced')
  assert.equal((await a.store.read()).pendingOperations.length, 0)
  assert.deepEqual((await f.server.store.head()).head, delivery.head)
}, 20000)

test('Nutrition missing acknowledged clean partitions blocks a partial-server publication before acknowledgement', async () => {
  const f = await environment(), a = await f.client()
  await a.commit(); await a.makeSync().run()
  await a.commit(markedDomain({ id: 'journal-2026-11-device-a-0', records: { foodEntries: [entry({ id: 'november', d: '2026-11-01' })] },
    sync: { revision: 0, writeId: null, edits: [marker('november', 20, 'a')], tombstones: [] } }))
  const transport = async (path, options) => path.includes('/nutrition/head') ?
    { ...scope, status: 'uninitialized', head: null, manifest: null, issues: [] } : f.transport(path, options)
  const before = f.calls.filter(c => c.method === 'POST').length
  const result = await a.makeSync({ transport }).run()
  assert.equal(result.status, 'blocked')
  assert.equal(f.calls.filter(c => c.method === 'POST').length, before)
  assert.equal((await a.store.read()).pendingOperations.length, 1)
  assert.equal((await a.store.read()).domains.flatMap(p => p.records.foodEntries ?? []).length, 2)
})

test('Nutrition explicitly offline runs and an older server preserve the durable queue', async () => {
  const f = await environment(), a = await f.client(); await a.commit()
  assert.equal((await a.makeSync({ online: () => false }).run()).status, 'offline')
  assert.equal(f.calls.length, 0)
  const transport = async (path, options) => {
    if (path.includes('/nutrition/')) throw Object.assign(new Error('older API'), { status: 404, data: {} })
    return f.transport(path, options)
  }
  assert.equal((await a.makeSync({ transport }).run()).status, 'unsupported')
  assert.equal((await a.store.read()).pendingOperations.length, 1)
  assert.equal((await a.makeSync().run()).status, 'synced')
})

test('Nutrition cancelling before launch prevents any request under a later session', async () => {
  const f = await environment(), a = await f.client(); await a.commit()
  const sync = a.makeSync(), run = sync.run()
  sync.cancel()
  assert.equal((await run).status, 'session-changed')
  assert.equal(f.calls.length, 0)
  assert.equal((await a.store.read()).pendingOperations.length, 1)
})

test('Nutrition cancelling a coordinator queued behind another scope run prevents its late launch', async () => {
  const f = await environment(), a = await f.client(), pause = gate(); await a.commit()
  f.hooks.before = async call => { if (call.method === 'POST') await pause.wait() }
  const first = a.makeSync(), second = a.makeSync(), active = first.run()
  await pause.entered
  const queued = second.run(); second.cancel(); pause.release()
  assert.equal((await active).status, 'synced')
  assert.equal((await queued).status, 'session-changed')
  assert.equal(f.calls.filter(c => c.path === '/api/me').length, 1)
})
