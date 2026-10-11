import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { nutritionRoutes } from '../nutrition/routes.js';
import { nutritionExecutor } from '../nutrition/executor.js';
import { readNutritionBody } from '../nutrition/protocol.js';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { fixture, origin, part, plan, request, scope, publish, status } from './nutrition-fixtures.mjs';

// Route-handler + real filesystem/worker/flock integration. The injected session fixture exercises
// the factory boundary, not WebAuthn/cookie hardening; server-nutrition.test.js covers those
// through the real server whenever its locked npm dependencies are installed.
async function httpFixture(t, { socket = false } = {}) {
  const f = await fixture(t), secret = 'nutrition-http-test-secret', users = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'db.json'))).users;
  const sessionOf = req => {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '') || String(req.headers.cookie || '').replace(/^gymsid=/, '');
    const at = token.lastIndexOf('.'), value = token.slice(0, at), signature = token.slice(at + 1);
    if (signature !== crypto.createHmac('sha256', secret).update(value).digest('base64url')) return null;
    const [uid, exp, sv] = value.split(':'), user = users.find(user => user.id === uid);
    return user && !user.disabled && Number(exp) > Date.now() && (user.sv || 0) === Number(sv) ? { user, exp: Number(exp) } : null;
  };
  const json = (res, code, body, extra) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra }); res.end(JSON.stringify(body)); };
  const routes = nutritionRoutes({ json, sessionOf, dataDir: f.dataDir, origin });
  const dispatch = async (req, res) => {
    const url = new URL(req.url, 'http://x'); let key = req.method + ' ' + url.pathname;
    const match = /^\/api\/nutrition\/(manifests|partitions)\/([a-f0-9]{64})$/.exec(url.pathname);
    if (match) { req.nutritionDigest = match[2]; key = req.method + ' /api/nutrition/' + match[1] + '/{digest}'; }
    try { if (!routes[key]) { req.resume(); return json(res, 404, {}); } await routes[key](req, res); }
    catch (error) { if (!error.clientGone) json(res, 500, { error: error.message }); }
  };
  let base;
  if (socket) {
    const server = http.createServer(dispatch);
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    } catch (error) {
      if (process.env.NUTRITION_REQUIRE_HTTP_TESTS !== '1' && (error.code === 'EPERM' || error.code === 'EACCES')) {
        t.skip(`Loopback sockets unavailable: ${error.code}`); return null;
      }
      throw error;
    }
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    base = `http://127.0.0.1:${server.address().port}`;
  }
  const token = (uid = 'alice', exp = Date.now() + 86400000, sv = 0) => {
    const value = `${uid}:${exp}:${sv}`; return value + '.' + crypto.createHmac('sha256', secret).update(value).digest('base64url');
  };
  const call = async (method, route, body, over = {}) => {
    const headers = { authorization: `Bearer ${token()}`, 'content-type': 'application/json', ...over };
    const bytes = body === undefined ? undefined : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    if (socket) return fetch(base + route, { method, headers, ...(bytes === undefined ? {} : { body: bytes }) });
    const req = Readable.from(bytes === undefined ? [] : [Buffer.from(bytes)]);
    Object.assign(req, { method, url: route, headers });
    let code, response, responseHeaders;
    const res = { writeHead(status, headers) { code = status; responseHeaders = headers; }, end(body) { response = body; } };
    await dispatch(req, res);
    return { status: code, headers: new Headers(responseHeaders), json: async () => JSON.parse(response) };
  };
  const query = `?generation=${scope.generation}`;
  const upload = a => call('PUT', `/api/nutrition/partitions/${a.integrity.digest}${query}`, a);
  const commit = p => call('POST', '/api/nutrition/publications' + query, request(p));
  return { ...f, base, users, token, call, query, upload, commit };
}
test('Nutrition routes reject anonymous, forged, expired, revoked and disabled sessions', async t => {
  const f = await httpFixture(t);
  for (const value of ['', 'Bearer forged', `Bearer ${f.token('alice', Date.now() - 1)}`, `Bearer ${f.token('alice', Date.now() + 10000, 2)}`]) {
    assert.equal((await f.call('GET', '/api/nutrition/head' + f.query, undefined, { authorization: value })).status, 401);
  }
  f.users[0].disabled = true;
  assert.equal((await f.call('GET', '/api/nutrition/head' + f.query)).status, 401);
  f.users[0].disabled = false;
  // Real worker rechecks the durable account record, independently of the injected fixture.
  fs.writeFileSync(path.join(f.dataDir, 'db.json'), JSON.stringify({ users: [{ id: 'alice', sv: 1 }] }));
  assert.equal((await f.call('GET', '/api/nutrition/head' + f.query)).status, 401);
});
test('Nutrition routes stage, publish, read and repeat using cookie/Bearer factory sessions', async t => {
  const f = await httpFixture(t), a = await part(), prepared = await plan('first', [a]);
  assert.equal((await f.upload(a)).status, 200);
  const saved = await (await f.commit(prepared)).json(); assert.equal(saved.head.commitId, 'first');
  const m = `/api/nutrition/manifests/${prepared.manifest.integrity.digest}${f.query}`;
  const p = `/api/nutrition/partitions/${a.integrity.digest}${f.query}&manifest=${prepared.manifest.integrity.digest}`;
  assert.deepEqual(await (await f.call('GET', m)).json(), prepared.manifest);
  assert.deepEqual(await (await f.call('GET', p, undefined, { authorization: '', cookie: `gymsid=${f.token()}` })).json(), a);
  assert.equal((await f.call('GET', m, undefined, { authorization: `Bearer ${f.token('bob')}` })).status, 404);
  assert.equal((await f.call('GET', p, undefined, { authorization: `Bearer ${f.token('bob')}` })).status, 404);
  assert.equal((await (await f.commit(prepared)).json()).repeated, true);
  assert.equal((await f.call('GET', m)).headers.get('cache-control'), 'no-store');
});
test('Nutrition routes reject malformed queries, paths, headers, UTF-8, JSON and oversized documents', async t => {
  const f = await httpFixture(t), a = await part();
  for (const query of ['', '?generation=g&generation=g', '?generation=g&uid=bob', '?generation=']) {
    assert.equal((await f.call('GET', '/api/nutrition/head' + query)).status, 400);
  }
  for (const hash of ['A'.repeat(64), '0'.repeat(63), '%2e%2e%2fhead', '0'.repeat(64) + '%2fhead']) {
    assert.equal((await f.call('PUT', '/api/nutrition/partitions/' + hash + f.query, a)).status, 404);
  }
  const route = `/api/nutrition/partitions/${a.integrity.digest}${f.query}`;
  assert.equal((await f.call('PUT', route, a, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await f.call('PUT', route, a, { 'content-encoding': 'gzip' })).status, 415);
  for (const body of ['{"x":1,"x":2}', 'null', '{', Buffer.from([123, 0xff, 125])]) assert.equal((await f.call('PUT', route, body)).status, 400);
  assert.equal((await f.call('PUT', route, '{"x":"' + 'a'.repeat(524288) + '"}')).status, 413);
  assert.equal((await f.call('GET', '/api/nutrition/head' + f.query)).status, 200);
  assert.equal(fs.existsSync(f.dir), false);
});
test('Nutrition routes serialize real concurrent workers and return 409 instead of losing updates', async t => {
  const f = await httpFixture(t), first = await plan('first', [await part()]);
  assert.equal((await f.upload(first.writes[0])).status, 200); assert.equal((await f.commit(first)).status, 200);
  const left = await plan('left', [await part(1)], first.manifest), right = await plan('right', [await part(2)], first.manifest);
  assert.equal((await f.upload(left.writes[0])).status, 200); assert.equal((await f.upload(right.writes[0])).status, 200);
  const results = await Promise.all([f.commit(left), f.commit(right)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  const state = await (await f.call('GET', '/api/nutrition/head' + f.query)).json();
  assert.ok(['left', 'right'].includes(state.head.commitId));
  assert.equal((await f.commit(first)).status, 200); // Earlier receipt retained across publication.
});
test('Nutrition real loopback HTTP upload, publication and read', async t => {
  const f = await httpFixture(t, { socket: true }); if (!f) return;
  const p = await plan('http', [await part()]);
  assert.equal((await f.upload(p.writes[0])).status, 200);
  assert.equal((await f.commit(p)).status, 200);
  assert.equal((await (await f.call('GET', '/api/nutrition/head' + f.query)).json()).head.commitId, 'http');
});
test('Nutrition limits body residency and slow transfers without starving the entire API', async () => {
  const executor = nutritionExecutor({ maxJobs: 1 }); let release;
  const first = executor.perform(() => new Promise(resolve => { release = resolve; }));
  await assert.rejects(executor.perform(() => {}), status(503, 'nutrition-server-busy')); release(); await first;
  const req = new Readable({ read() {} }); req.headers = { 'content-type': 'application/json' };
  await assert.rejects(readNutritionBody(req, 1000, { idleMs: 10, totalMs: 100 }), status(408, 'nutrition-body-timeout')); req.destroy();
});
test('Nutrition reports a preexisting real process lock as 409 without an IPC startup race', async t => {
  const f = await fixture(t), holder = spawn('flock', ['--exclusive', '--no-fork', path.join(f.owner, '.lock'),
    process.execPath, '-e', 'process.send({locked:true}); setInterval(() => {}, 1000)'],
  { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(() => holder.kill('SIGKILL'));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('lock holder never became ready')), 2000);
    holder.once('message', () => { clearTimeout(timer); resolve(); });
    holder.once('error', error => { clearTimeout(timer); reject(error); });
  });
  const executor = nutritionExecutor({ dataDir: f.dataDir, limits: f.options.limits }), job = { action: 'publish', scope,
    body: {}, authorization: { sv: 0, exp: Date.now() + 86400000 } };
  for (let attempt = 0; attempt < 6; attempt++) {
    await assert.rejects(executor.perform(execute => execute(job)), status(409, 'nutrition-busy'));
  }
  await assert.rejects(executor.perform(execute => execute({ ...job, action: 'head' })), status(503, 'nutrition-busy'));
  const closed = new Promise(resolve => holder.once('close', resolve)); holder.kill('SIGKILL'); await closed;
  assert.equal((await executor.perform(execute => execute({ ...job, action: 'head' }))).status, 200);
});
for (const phase of ['manifest:rename', 'head:rename', 'receipt:rename', 'confirmed:rename']) {
  test(`Nutrition recovers after actual worker SIGKILL at ${phase}`, async t => {
    const f = await fixture(t), first = await plan('first', [await part()]); await publish(f.store, first);
    const second = await plan('second', [await part(1)], first.manifest);
    await f.store.upload(second.writes[0].integrity.digest, second.writes[0]);
    const job = { action: 'publish', scope, body: request(second), authorization: { sv: 0, exp: Date.now() + 86400000 } };
    const faulty = nutritionExecutor({ dataDir: f.dataDir, limits: f.options.limits,
      workerPath: fileURLToPath(new URL('./nutrition-fault-worker.mjs', import.meta.url)) });
    await assert.rejects(faulty.perform(execute => execute({ ...job, testFault: phase })), status(503, 'nutrition-worker-interrupted'));
    const normal = nutritionExecutor({ dataDir: f.dataDir, limits: f.options.limits });
    const saved = await normal.perform(execute => execute(job));
    assert.equal(saved.status, 200); assert.equal(saved.body.head.commitId, 'second');
    assert.equal(saved.body.repeated, phase !== 'manifest:rename');
    assert.deepEqual(await f.store.partition(first.writes[0].integrity.digest, first.manifest.integrity.digest), first.writes[0]);
  });
}
