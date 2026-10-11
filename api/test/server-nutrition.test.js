import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';
import { fixture, part, plan, request, scope, origin } from './nutrition-fixtures.mjs';
import { createNutritionLocalStore } from '../../frontend/src/lib/nutrition/local-store.js';
import { nutritionIdbBackend } from '../../frontend/src/lib/nutrition/local-store-idb.js';
import { transactionalIdb } from '../../frontend/src/lib/nutrition/local-storage.test-util.js';
import { createNutritionSync } from '../../frontend/src/lib/nutrition/sync.js';
import { encodePartition } from '../nutrition/core/serialization.js';

let missing;
try { for (const name of ['@simplewebauthn/server', 'web-push', 'undici']) import.meta.resolve(name); }
catch (error) { missing = 'Locked API npm dependencies are unavailable: ' + error.code; }
const requireHttp = process.env.NUTRITION_REQUIRE_HTTP_TESTS === '1';
const testOptions = { skip: !requireHttp && missing };

async function serverFixture(t) {
  // Skip only known environment restrictions. An unexpected boot/HTTP/assertion failure
  // still fails this suite; injected factory sessions do not replace these real-server checks.
  if (missing) throw new Error(missing);
  const probe = http.createServer();
  try {
    await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
    await new Promise(resolve => probe.close(resolve));
  } catch (error) {
    if (!requireHttp && ['EPERM', 'EACCES'].includes(error.code)) { t.skip(`Loopback sockets unavailable: ${error.code}`); return null; }
    throw error;
  }
  const f = await fixture(t), secret = 'nutrition-real-server-secret'; fs.writeFileSync(path.join(f.dataDir, 'secret'), secret);
  const child = spawn(process.execPath, ['server.js'], { cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: { ...process.env, PORT: '0', DATA_DIR: f.dataDir, ORIGIN: origin, RP_ID: 'gym.example.com' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  let log = ''; child.stdout.on('data', d => { log += d; }); child.stderr.on('data', d => { log += d; });
  const base = `http://127.0.0.1:${await boundPort(child, () => log)}`;
  const token = (uid = 'alice', exp = Date.now() + 86400000, version = 0) => {
    const payload = `${uid}:${exp}:${version}`;
    return payload + '.' + crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  };
  const headers = { cookie: `__Host-gymsid=${token()}`, origin, 'content-type': 'application/json' }, query = `?generation=${scope.generation}`;
  const call = (method, route, body, overrides = {}) => fetch(base + route, { method, headers: { ...headers, ...overrides },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const upload = a => call('PUT', `/api/nutrition/partitions/${a.integrity.digest}${query}`, a);
  const commit = p => call('POST', '/api/nutrition/publications' + query, request(p));
  return { ...f, base, token, headers, query, call, upload, commit };
}

test('real server: Nutrition uses existing cookie/Bearer auth, account isolation and CSRF protections', testOptions, async t => {
  const f = await serverFixture(t); if (!f) return;
  const { base, query, headers, token, call } = f;
  assert.equal((await fetch(base + '/api/nutrition/head' + query)).status, 401);
  for (const value of ['forged', token('alice', Date.now() - 1), token('alice', Date.now() + 10000, 1), token('absent')]) {
    assert.equal((await call('GET', '/api/nutrition/head' + query, undefined, { cookie: `__Host-gymsid=${value}` })).status, 401);
  }
  const a = await part(), p = await plan('first', [a]);
  const route = base + `/api/nutrition/partitions/${a.integrity.digest}${query}`;
  assert.equal((await fetch(route, { method: 'PUT', headers: { ...headers, origin: 'https://hostile.example.com' }, body: JSON.stringify(a) })).status, 403);
  const publicationRoute = '/api/nutrition/publications' + query;
  for (const site of ['same-site', 'cross-site']) {
    assert.equal((await call('POST', publicationRoute, request(p), { 'sec-fetch-site': site })).status, 403);
  }
  assert.equal((await call('PUT', `/api/nutrition/partitions/${a.integrity.digest}${query}`, a,
    { cookie: '', authorization: `Bearer ${token()}`, origin: 'capacitor://localhost' })).status, 200);
  assert.equal((await f.commit(p)).status, 200);
  const manifestPath = `/api/nutrition/manifests/${p.manifest.integrity.digest}${query}`;
  const partitionPath = `/api/nutrition/partitions/${a.integrity.digest}${query}&manifest=${p.manifest.integrity.digest}`;
  for (const path of [manifestPath, partitionPath]) {
    assert.equal((await call('GET', path, undefined, { cookie: `__Host-gymsid=${token('bob')}` })).status, 404);
  }
  assert.equal((await call('PUT', `/api/nutrition/partitions/${a.integrity.digest}${query}`, a,
    { cookie: `__Host-gymsid=${token('bob')}` })).status, 400);
  assert.equal((await call('POST', publicationRoute, request(p), { cookie: `__Host-gymsid=${token('bob')}` })).status, 400);
  const bobHead = await (await call('GET', '/api/nutrition/head' + query, undefined,
    { cookie: `__Host-gymsid=${token('bob')}` })).json();
  assert.equal(bobHead.status, 'uninitialized'); assert.equal(bobHead.head, null);
  assert.deepEqual(await (await call('GET', partitionPath)).json(), a);
});

test('real server: Nutrition keeps exact receipts and resolves concurrent publications with 409', testOptions, async t => {
  const f = await serverFixture(t); if (!f) return;
  const first = await plan('first', [await part()]); assert.equal((await f.upload(first.writes[0])).status, 200);
  assert.equal((await (await f.upload(first.writes[0])).json()).repeated, true);
  const committed = await f.commit(first); assert.equal(committed.status, 200);
  const saved = await committed.json();
  assert.equal((await (await f.commit(first)).json()).repeated, true);
  const left = await plan('left', [await part(1)], first.manifest), right = await plan('right', [await part(2)], first.manifest);
  assert.equal((await f.upload(left.writes[0])).status, 200); assert.equal((await f.upload(right.writes[0])).status, 200);
  const results = await Promise.all([f.commit(left), f.commit(right)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  const state = await (await f.call('GET', '/api/nutrition/head' + f.query)).json();
  assert.ok(['left', 'right'].includes(state.head.commitId));
  const repeat = await (await f.commit(first)).json();
  assert.equal(repeat.repeated, true); assert.deepEqual(repeat.receipt, saved.receipt);
  assert.equal((await f.call('POST', '/api/nutrition/publications' + f.query,
    { ...request(first), expectedHead: state.head })).status, 409);
  assert.equal((await (await f.call('GET', '/api/nutrition/head' + f.query)).json()).head.commitId, state.head.commitId);
});

test('real server: Nutrition leaves workout revision, write ids and legacy saves independent', testOptions, async t => {
  const f = await serverFixture(t); if (!f) return;
  const { base, query, headers, call } = f;
  const a = await part(), p = await plan('first', [a]);
  assert.equal((await f.upload(a)).status, 200); assert.equal((await f.commit(p)).status, 200);
  assert.deepEqual(await (await fetch(base + '/api/data/rev', { headers })).json(), { rev: 0 });
  assert.equal((await call('PUT', '/api/data', { state: { workouts: [], routines: [] }, baseRev: 0 })).status, 200);
  const before = await (await call('GET', '/api/data/rev')).json(); assert.equal(before.rev, 1); assert.equal(typeof before.wid, 'string');
  const second = await plan('second', [await part(1)], p.manifest);
  assert.equal((await f.upload(second.writes[0])).status, 200); assert.equal((await f.commit(second)).status, 200);
  assert.deepEqual(await (await call('GET', '/api/data/rev')).json(), before);
  assert.equal((await call('PUT', '/api/data', { state: { workouts: [], routines: [] }, baseRev: 0 })).status, 409);
  assert.equal((await call('PUT', '/api/data', { state: { workouts: [], routines: [] }, baseRev: 1, baseWid: 'stale-wid' })).status, 409);
  assert.equal((await (await call('GET', '/api/nutrition/head' + query)).json()).head.commitId, 'second');
  // An older app has no conditional revision. Its existing save behavior still works.
  assert.equal((await call('PUT', '/api/data', { state: { workouts: [], routines: [], restSec: 75 } })).status, 200);
  assert.equal((await (await call('GET', '/api/data/rev')).json()).rev, 2);
  assert.equal((await (await call('GET', '/api/nutrition/head' + query)).json()).head.commitId, 'second');
});

test('real server: client Nutrition coordinator replays a lost response, pulls and merges two devices', testOptions, async t => {
  const f = await serverFixture(t); if (!f) return;
  const calls = []; let sequence = 0, loseResponse = true;
  const transport = async (path, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ path, method: options.method || 'GET', body });
    const response = await f.call(options.method || 'GET', path, body), data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error), { status: response.status, data });
    if (options.method === 'POST' && loseResponse) { loseResponse = false; throw new Error('lost publication response'); }
    return data;
  };
  const makeClient = async device => {
    const memory = transactionalIdb();
    const open = () => createNutritionLocalStore({ ...scope, deviceId: device, backend: nutritionIdbBackend({ idb: memory.idb }) });
    let store = await open(); t.after(() => store.close());
    const coordinator = () => createNutritionSync({ store, transport, getSession: () => ({ userId: 'alice', serverOrigin: origin, epoch: 1 }),
      newId: () => `${device}-${++sequence}` });
    return { get store() { return store; }, coordinator, async reopen() { store.close(); store = await open(); } };
  };
  const a = await makeClient('a'), b = await makeClient('b');
  await a.store.commit({ commitId: 'first-client-write', partitions: [await part()] });
  assert.equal((await a.coordinator().run()).status, 'offline');
  assert.equal((await a.store.read()).pendingOperations.length, 1);
  const delivery = (await a.store.syncState()).delivery;
  await a.store.collect(); await a.reopen();
  assert.deepEqual((await a.store.syncState()).delivery, delivery);
  assert.equal((await a.coordinator().run()).status, 'synced');
  assert.deepEqual(calls.filter(c => c.method === 'POST').map(c => c.body), [delivery.request, delivery.request]);
  assert.equal((await b.coordinator().run()).status, 'synced');
  for (const [client, device, meal, counter] of [[a, 'a', 'lunch', 10], [b, 'b', 'dinner', 11]]) {
    const value = (await client.store.read()).domains[0]; value.records.foodEntries[0].meal = meal;
    value.sync.revision++; value.sync.writeId = `edit-${device}`;
    value.sync.edits[0].stamp = { counter, deviceId: device };
    await client.store.commit({ commitId: `edit-${device}`, partitions: [await encodePartition(value)] });
    assert.equal((await client.coordinator().run()).status, 'synced');
  }
  assert.equal((await a.coordinator().run()).status, 'synced');
  assert.equal((await a.store.read()).domains[0].records.foodEntries[0].meal, 'dinner');
  assert.ok((await a.store.read()).domains[0].extensions.nutritionSyncConflicts);
  assert.deepEqual(await (await f.call('GET', '/api/data/rev')).json(), { rev: 0 });
});
