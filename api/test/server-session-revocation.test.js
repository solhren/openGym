/* A session checked before readBody must still be current when the body arrives. An HTTP
   100 Continue proves the request has reached the server before another connection revokes
   it; no sleeps, production accounts or external network are involved. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

async function startServer(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-session-revocation-'));
  const secret = crypto.randomBytes(32).toString('hex');
  const state = { routines: [], workouts: [], bodyweight: [{ d: '2026-11-01', w: 75 }], _rev: 1 };
  fs.writeFileSync(path.join(dataDir, 'secret'), secret, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
    users: [{ id: 'owner', name: 'Owner' }, { id: 'admin', name: 'Admin', admin: true }],
    creds: [], subs: [], invites: []
  }));
  const stateFile = path.join(dataDir, 'state-owner.json');
  fs.writeFileSync(stateFile, JSON.stringify(state));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN: 'http://localhost:8080', RP_ID: 'localhost',
      COACH_DISABLED: '1', MEDIA_UPLOADS: '0', PASSWORD_LOGIN: '', INVITE_ONLY: '', ADMIN_UIDS: '', FIRST_USER_ADMIN: '',
      OPENGYM_PRIVATE_BETA: '', OPENGYM_PERSONAL_BETA: '', OPENGYM_BETA_DOCKER: '', NUTRITION_LOCAL_CATALOG: '' }
  });
  let log = '';
  child.stdout.on('data', d => log += d);
  child.stderr.on('data', d => log += d);
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${await boundPort(child, () => log)}`;
  const auth = (uid, bearer = false, sv = 0) => {
    const payload = `${uid}:${Date.now() + 86400000}:${sv}`;
    const token = payload + '.' + crypto.createHmac('sha256', secret).update(payload).digest('base64url');
    return bearer ? { Authorization: 'Bearer ' + token } : { Cookie: 'gymsid=' + token };
  };
  const request = async (method, route, headers, body = {}) => {
    const r = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...headers },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, body: await r.json() };
  };
  return { base, auth, request, state, stateFile, db: () => JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8')) };
}

async function pendingBody(t, h, method, route, headers, body) {
  const bytes = JSON.stringify(body);
  let req;
  let continued;
  const ready = new Promise(resolve => { continued = resolve; });
  const response = new Promise((resolve, reject) => {
    req = http.request(h.base + route, { method, headers: { ...headers, 'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(bytes), Expect: '100-continue' } }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', d => raw += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); } catch (e) { reject(e); }
      });
      res.on('error', reject);
    });
    req.once('continue', continued);
    req.once('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('pending body timed out')));
    req.flushHeaders();
  });
  t.after(() => req.destroy());
  await Promise.race([ready, response.then(r => { throw new Error(`answered before the body: ${r.status}`); })]);
  return () => { req.end(bytes); return response; };
}

test('a cookie write waiting for its body cannot outlive sign out everywhere', async t => {
  const h = await startServer(t);
  const finish = await pendingBody(t, h, 'PUT', '/api/data', h.auth('owner'), { state: { routines: [], workouts: [] }, baseRev: 1 });
  assert.equal((await h.request('POST', '/api/logout/all', h.auth('owner'))).status, 200);
  assert.equal((await finish()).status, 401);
  assert.deepEqual(JSON.parse(fs.readFileSync(h.stateFile, 'utf8')), h.state);
  assert.equal((await h.request('GET', '/api/me', h.auth('owner'))).status, 401);
});

test('a paired bearer write waiting for its body cannot outlive account disablement', async t => {
  const h = await startServer(t);
  const finish = await pendingBody(t, h, 'PUT', '/api/data', h.auth('owner', true), { state: { routines: [], workouts: [] }, baseRev: 1 });
  assert.equal((await h.request('POST', '/api/admin/user/disable', h.auth('admin'), { id: 'owner', disabled: true })).status, 200);
  assert.equal((await finish()).status, 401);
  assert.deepEqual(JSON.parse(fs.readFileSync(h.stateFile, 'utf8')), h.state);
});

test('an admin mutation waiting for its body cannot outlive its session', async t => {
  const h = await startServer(t);
  const finish = await pendingBody(t, h, 'POST', '/api/admin/invites/new', h.auth('admin'), { note: 'pending invite' });
  assert.equal((await h.request('POST', '/api/logout/all', h.auth('admin'))).status, 200);
  assert.equal((await finish()).status, 401);
  assert.deepEqual(h.db().invites, []);
});

test('current cookie and bearer sessions still write, and a current admin still creates invites', async t => {
  const h = await startServer(t);
  for (const [i, bearer] of [false, true].entries()) {
    const finish = await pendingBody(t, h, 'PUT', '/api/data', h.auth('owner', bearer), {
      state: { routines: [], workouts: [], bodyweight: h.state.bodyweight }, baseRev: i + 1
    });
    assert.equal((await finish()).status, 200);
  }
  const invite = await pendingBody(t, h, 'POST', '/api/admin/invites/new', h.auth('admin'), { note: 'current invite' });
  assert.equal((await invite()).status, 200);
  assert.equal(h.db().invites.length, 1);
});

test('anonymous registration options do not depend on an unrelated revoked cookie', async t => {
  const h = await startServer(t);
  const finish = await pendingBody(t, h, 'POST', '/api/register/options', h.auth('owner'), { name: 'New profile' });
  assert.equal((await h.request('POST', '/api/logout/all', h.auth('owner'))).status, 200);
  const result = await finish();
  assert.equal(result.status, 200);
  assert.equal(typeof result.body.cid, 'string');
  assert.equal(result.body.options.user.name, 'New profile');
});
