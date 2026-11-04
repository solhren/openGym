import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';
import { publicInstallAuthenticator } from './public-install-auth.mjs';
import { encodePartition, decodePartition } from '../nutrition/core/serialization.js';
import { prepareCommit } from '../nutrition/core/persistence-commit.js';

const API = fileURLToPath(new URL('../', import.meta.url));
const runtime = fileURLToPath(new URL('../../scripts/nutrition-local-catalog/runtime/', import.meta.url));
const ORIGIN = 'https://accounts.example.org', GENERATION = 'account-mode-tests';

async function fixture(t, { mode = 'personal', policy = 'invite', max, env = {}, users = [], invites } = {}) {
  fs.mkdirSync(runtime, { recursive: true });
  const directory = fs.mkdtempSync(path.join(runtime, 'account-mode-'));
  fs.chmodSync(directory, 0o700);
  const codes = invites ?? ['BOOTSTRAP-FIXTURE-A', 'BOOTSTRAP-FIXTURE-B'];
  fs.writeFileSync(path.join(directory, 'db.json'), JSON.stringify({ users, creds: [], subs: [], invites: codes.map(code => ({ code })) }), { mode: 0o600 });
  const environment = { PATH: process.env.PATH, NODE_ENV: 'production', DATA_DIR: directory, PORT: '0', ORIGIN: ORIGIN, RP_ID: 'accounts.example.org',
    MEDIA_UPLOADS: '0', COACH_DISABLED: '1', PASSWORD_LOGIN: '0', INVITE_ONLY: '1', ALLOW_GUEST: '0', FIRST_USER_ADMIN: '1', TRUST_PROXY: '0',
    ...(mode ? { OPENGYM_INSTANCE_MODE: mode, OPENGYM_SIGNUP_POLICY: policy, OPENGYM_LISTEN_HOST: '127.0.0.1' } : {}),
    ...(max ? { OPENGYM_MAX_USERS: String(max) } : {}), ...env };
  let child, base, log = '';
  const stop = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const ended = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000); await ended; clearTimeout(timer);
  };
  const start = async (changes = {}) => {
    Object.assign(environment, changes); log = '';
    child = spawn(process.execPath, ['server.js'], { cwd: API, stdio: ['ignore', 'pipe', 'pipe'], env: environment });
    child.stdout.on('data', bytes => log += bytes); child.stderr.on('data', bytes => log += bytes);
    base = 'http://127.0.0.1:' + await boundPort(child, () => log);
  };
  t.after(async () => { await stop(); fs.rmSync(directory, { recursive: true, force: true }); });
  const request = async (method, route, { actor, body, headers = {} } = {}) => {
    const result = await fetch(base + route, { method, headers: { Origin: ORIGIN, 'Content-Type': 'application/json', ...(actor?.cookie ? { Cookie: actor.cookie } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const cookie = result.headers.getSetCookie().find(value => value.startsWith('__Host-gymsid=') && !value.startsWith('__Host-gymsid=;'))?.split(';')[0];
    return { status: result.status, body: await result.json(), cookie, headers: result.headers };
  };
  const prepare = async (name, code) => {
    const key = publicInstallAuthenticator(ORIGIN), options = await request('POST', '/api/register/options', { body: { name, code } });
    assert.equal(options.status, 200, JSON.stringify(options.body));
    return { key, body: { cid: options.body.cid, credential: key.attestation(options.body.options.challenge) } };
  };
  const finish = async prepared => {
    const result = await request('POST', '/api/register/verify', { body: prepared.body });
    return { ...result, key: prepared.key, user: result.body.user };
  };
  const register = async (name, code) => { const result = await finish(await prepare(name, code)); assert.equal(result.status, 200, JSON.stringify(result.body)); return result; };
  const proof = async actor => {
    const options = await request('POST', '/api/login/options', { body: {} });
    return { cid: options.body.cid, credential: actor.key.assertion(options.body.options.challenge) };
  };
  const login = async actor => {
    const result = await request('POST', '/api/login/verify', { body: await proof(actor) });
    assert.equal(result.status, 200); return { ...actor, cookie: result.cookie };
  };
  return { directory, environment, codes, start, stop, request, prepare, finish, register, proof, login,
    db: () => JSON.parse(fs.readFileSync(path.join(directory, 'db.json'), 'utf8')) };
}

async function nutrition(h, actor, label) {
  const scope = { namespace: { serverOrigin: ORIGIN, profileId: actor.user.id }, generation: GENERATION };
  const partition = await encodePartition({ ...scope, id: 'journal-2026-11-modes-0', kind: 'journal',
    records: { foodEntries: [{ schemaVersion: 1, id: 'meal-' + label, d: '2026-11-04', meal: 'breakfast',
      snapshot: { schemaVersion: 1, kind: 'food', id: 'food-' + label, name: 'Private food ' + label, reference: { amount: 100, unit: 'g' },
        nutrients: { kcal: 380, protein: 13, carbs: 60, fat: 7 }, portions: [], source: { kind: 'custom' } }, quantity: { amount: 50, unit: 'g' } }] },
    sync: { revision: 0, writeId: null, edits: [], tombstones: [] } });
  const plan = await prepareCommit({ ...scope, commitId: 'first-' + label, baseManifest: null, partitions: [partition] });
  assert.equal((await h.request('PUT', `/api/nutrition/partitions/${partition.integrity.digest}?generation=${GENERATION}`, { actor, body: partition })).status, 200);
  assert.equal((await h.request('POST', `/api/nutrition/publications?generation=${GENERATION}`, { actor, body: { expectedHead: plan.expectedHead, manifest: plan.manifest, head: plan.head } })).status, 200);
  return { partition, manifestPath: `/api/nutrition/manifests/${plan.manifest.integrity.digest}?generation=${GENERATION}`,
    partitionPath: `/api/nutrition/partitions/${partition.integrity.digest}?generation=${GENERATION}&manifest=${plan.manifest.integrity.digest}` };
}

test('personal mode atomically binds one owner despite two valid prepared invitations, and stays closed after restart', async t => {
  const h = await fixture(t, { env: { PASSWORD_LOGIN: '1' } }); await h.start();
  const config = (await h.request('GET', '/api/config')).body;
  assert.equal(config.instance_mode, 'personal'); assert.equal(config.max_users, 1); assert.equal(config.registration_open, true); assert.equal(config.invite_only, true); assert.equal(config.allow_guest, false);
  assert.equal((await h.request('POST', '/api/register/options', { body: { name: 'No invitation' } })).status, 403);
  const prepared = await Promise.all([h.prepare('Owner A', h.codes[0]), h.prepare('Owner B', h.codes[1])]);
  const results = await Promise.all(prepared.map(h.finish));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 403]);
  const owner = results.find(result => result.status === 200);
  assert.equal(owner.user.admin, true); assert.equal(h.db().users.length, 1); assert.equal(h.db().instanceOwner, owner.user.id);
  assert.equal((await h.request('POST', '/api/admin/invites/new', { actor: owner, body: {} })).status, 403);
  assert.equal((await h.request('POST', '/api/register/password', { body: { name: 'Second', code: h.codes[1], password: 'correct horse battery staple' } })).status, 403);
  assert.equal((await h.request('GET', '/api/config')).body.registration_open, false);
  await h.stop(); await h.start();
  assert.equal((await h.request('GET', '/api/me', { actor: owner })).body.user.id, owner.user.id);
  assert.equal((await h.request('POST', '/api/register/options', { body: { name: 'Second', code: h.codes[1] } })).body.code, 'registration-closed');
});

test('multi-user invitations are admin-only, one-use and rechecked after options; admin gets account metadata only', async t => {
  const h = await fixture(t, { mode: 'multi-user' }); await h.start();
  const admin = await h.register('Admin', h.codes[0]);
  assert.equal((await h.request('GET', '/api/config')).body.signup_policy, 'invite');
  const invitation = await h.request('POST', '/api/admin/invites/new', { actor: admin, body: { note: 'Member invitation' } });
  assert.equal(invitation.status, 200);
  const staged = await h.prepare('Revoked member', invitation.body.invite.code);
  assert.equal((await h.request('POST', '/api/admin/invites/revoke', { actor: admin, body: { code: invitation.body.invite.code } })).status, 200);
  assert.equal((await h.finish(staged)).status, 403);
  const code = (await h.request('POST', '/api/admin/invites/new', { actor: admin, body: {} })).body.invite.code;
  const member = await h.register('Member', code); assert.equal(member.user.admin, false);
  assert.equal((await h.request('POST', '/api/register/options', { body: { name: 'Replay', code } })).status, 403);
  assert.equal((await h.request('POST', '/api/admin/invites/new', { actor: member, body: {} })).status, 403);
  assert.equal((await h.request('GET', '/api/admin/users', { actor: member })).status, 403);
  for (const [actor, label] of [[admin, 'admin'], [member, 'member']]) {
    assert.equal((await h.request('PUT', '/api/data', { actor, body: { state: { workouts: [{ id: label, name: 'Private workout ' + label, d: '2026-11-04', entries: [] }], routines: [], bodyweight: [{ d: '2026-11-04', w: label === 'admin' ? 70 : 80 }] } } })).status, 200);
  }
  for (const [actor, other, label] of [[member, admin, 'member'], [admin, member, 'admin']])
    assert.equal((await h.request('GET', '/api/data?id=' + other.user.id, { actor })).body.state.workouts[0].id, label);
  const list = await h.request('GET', '/api/admin/users', { actor: admin });
  assert.equal(list.body.account_only, true);
  for (const row of list.body.users) for (const key of ['workouts', 'lastWorkout', 'lastSync', 'hasPush', 'live']) assert.equal(key in row, false);
  const detail = await h.request('GET', '/api/admin/user?id=' + member.user.id, { actor: admin });
  assert.equal(detail.body.account_only, true); assert.deepEqual(Object.keys(detail.body).sort(), ['account_only', 'user']);
  const a = await nutrition(h, admin, 'admin'), b = await nutrition(h, member, 'member');
  for (const [actor, other] of [[member, a], [admin, b]]) {
    assert.equal((await h.request('GET', other.manifestPath, { actor })).status, 404);
    assert.equal((await h.request('GET', other.partitionPath, { actor })).status, 404);
    assert.equal((await h.request('PUT', `/api/nutrition/partitions/${other.partition.integrity.digest}?generation=${GENERATION}`, { actor, body: other.partition })).status, 400);
  }
  assert.equal((await decodePartition((await h.request('GET', a.partitionPath, { actor: admin })).body)).records.foodEntries[0].id, 'meal-admin');
  assert.equal((await decodePartition((await h.request('GET', b.partitionPath, { actor: member })).body)).records.foodEntries[0].id, 'meal-member');
  assert.equal(fs.statSync(h.directory).mode & 0o777, 0o700);
  for (const file of ['secret', 'db.json', `state-${admin.user.id}.json`, `state-${member.user.id}.json`]) assert.equal(fs.statSync(path.join(h.directory, file)).mode & 0o777, 0o600);
  const pair = await h.request('POST', '/api/pair/create', { actor: member, body: {} });
  const paired = await h.request('POST', '/api/pair/redeem', { body: { code: pair.body.code } });
  assert.equal(paired.status, 200);
  assert.equal((await h.request('POST', '/api/admin/user/disable', { actor: member, body: { id: admin.user.id, disabled: true } })).status, 403);
  assert.equal((await h.request('POST', '/api/admin/user/disable', { actor: admin, body: { id: member.user.id, disabled: true } })).status, 200);
  for (const auth of [{ actor: member }, { headers: { Authorization: 'Bearer ' + paired.body.token } }]) {
    assert.equal((await h.request('GET', '/api/me', auth)).status, 401);
    assert.equal((await h.request('GET', b.partitionPath, auth)).status, 401);
  }
  assert.equal((await h.request('POST', '/api/admin/user/disable', { actor: admin, body: { id: member.user.id, disabled: false } })).status, 200);
  assert.equal((await h.login(member)).user.id, member.user.id);
  await h.stop(); const before = fs.readFileSync(path.join(h.directory, 'db.json'));
  await assert.rejects(h.start({ OPENGYM_INSTANCE_MODE: 'personal' }), /personal-account-state-invalid/);
  assert.ok(fs.readFileSync(path.join(h.directory, 'db.json')).equals(before), 'mode change never deletes or promotes accounts');
  await h.start({ OPENGYM_INSTANCE_MODE: 'multi-user', OPENGYM_MAX_USERS: '2' });
  assert.equal((await h.request('GET', '/api/me', { actor: member })).status, 200);
});

test('explicit password recovery remains admin-controlled, single-use and audited without its secret', async t => {
  const h = await fixture(t, { mode: 'multi-user', env: { PASSWORD_LOGIN: '1', AUDIT_LOG: '1' } }); await h.start();
  const admin = await h.register('Admin', h.codes[0]), member = await h.register('Member', h.codes[1]);
  const reset = (actor, id) => h.request('POST', '/api/admin/user/password-reset', { actor, body: { id } });
  assert.equal((await reset(member, admin.user.id)).status, 403);
  assert.equal((await reset(admin, admin.user.id)).status, 400);
  const issued = await reset(admin, member.user.id); assert.equal(issued.status, 200);
  assert.equal((await h.request('GET', '/api/me', { actor: member })).status, 401);
  const redeem = () => h.request('POST', '/api/login/password-reset', { body: { name: member.user.name, code: issued.body.code, next: 'synthetic recovery passphrase only' } });
  const recovered = await redeem(); assert.equal(recovered.status, 200);
  assert.equal((await h.request('GET', '/api/me', { actor: recovered })).body.user.id, member.user.id);
  assert.equal((await redeem()).body.code, 'reset-invalid');
  const raw = fs.readFileSync(path.join(h.directory, 'audit.log'), 'utf8');
  assert.equal(raw.includes(issued.body.code), false); assert.equal(JSON.stringify(h.db()).includes(issued.body.code), false);
  const events = raw.trim().split('\n').map(line => JSON.parse(line));
  assert.ok(events.some(event => event.ev === 'admin.password.reset' && event.tgt === member.user.id && event.uid === admin.user.id));
  assert.ok(events.some(event => event.ev === 'auth.password.reset' && event.ok && event.uid === member.user.id));
});

test('password signup checks the public bootstrap and rechecks the cap after concurrent hashes', async t => {
  const h = await fixture(t, { mode: 'multi-user', policy: 'public', max: 2, env: { PASSWORD_LOGIN: '1' } }); await h.start();
  const signup = name => h.request('POST', '/api/register/password', { body: { name, password: 'synthetic correct horse battery staple' } });
  assert.equal((await signup('Bootstrap attacker')).body.code, 'invite');
  const owner = await h.register('Owner', h.codes[0]);
  const results = await Promise.all([signup('Public password A'), signup('Public password B')]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 403]);
  assert.equal(h.db().users.length, 2); assert.equal(h.db().users.filter(user => user.admin).length, 1);
  assert.equal((await h.request('GET', '/api/me', { actor: owner })).status, 200);
});

test('prepared bootstrap ceremonies cannot create a second admin, and a reduced cap keeps existing accounts accessible', async t => {
  const h = await fixture(t, { mode: 'multi-user', policy: 'public', max: 3 }); await h.start();
  const staged = await Promise.all([h.prepare('First', h.codes[0]), h.prepare('Second', h.codes[1])]);
  const first = await h.finish(staged[0]), second = await h.finish(staged[1]);
  assert.equal(first.status, 200); assert.equal(second.status, 200);
  assert.equal(first.user.admin, true); assert.equal(second.user.admin, false);
  const third = await h.register('Third');
  await h.stop(); const before = fs.readFileSync(path.join(h.directory, 'db.json'));
  await h.start({ OPENGYM_MAX_USERS: '2' });
  assert.ok(fs.readFileSync(path.join(h.directory, 'db.json')).equals(before));
  assert.equal((await h.request('GET', '/api/config')).body.registration_open, false);
  for (const actor of [first, second, third]) assert.equal((await h.request('GET', '/api/me', { actor })).status, 200);
  assert.equal((await h.request('POST', '/api/register/options', { body: { name: 'Fourth' } })).body.code, 'registration-full');
});

test('public multi-user signup still needs a private bootstrap, respects origin and caps concurrent completions', async t => {
  const h = await fixture(t, { mode: 'multi-user', policy: 'public', max: 2 }); await h.start();
  assert.equal((await h.request('GET', '/api/config')).body.invite_only, true);
  assert.equal((await h.request('POST', '/api/register/options', { body: { name: 'Take first admin' } })).status, 403);
  const admin = await h.register('Owner', h.codes[0]);
  const config = (await h.request('GET', '/api/config')).body;
  assert.equal(config.invite_only, false); assert.equal(config.max_users, 2);
  assert.equal((await h.request('POST', '/api/register/options', { body: { name: 'Cross-site' }, headers: { Origin: 'https://foreign.example' } })).status, 403);
  const prepared = await Promise.all([h.prepare('Public A'), h.prepare('Public B')]);
  assert.equal((await h.request('POST', '/api/register/verify', { body: prepared[0].body, headers: { Origin: 'https://foreign.example' } })).status, 403);
  const completed = await Promise.all(prepared.map(h.finish));
  assert.deepEqual(completed.map(result => result.status).sort(), [200, 403]);
  assert.equal(h.db().users.length, 2); assert.equal(h.db().users.filter(user => user.admin).length, 1);
  assert.equal((await h.request('GET', '/api/config')).body.registration_open, false);
  assert.equal((await h.request('GET', '/api/me', { actor: admin })).status, 200);
  assert.equal((await h.request('POST', '/api/register/options', { body: { name: 'Full' } })).body.code, 'registration-full');
});

test('public signup address budget ignores untrusted forwarding headers and never pauses sign-in', async t => {
  const h = await fixture(t, { mode: 'multi-user', policy: 'public' }); await h.start();
  const admin = await h.register('Owner', h.codes[0]);
  for (let i = 0; i < 10; i++) assert.equal((await h.request('POST', '/api/register/options', { body: { name: 'Attempt ' + i }, headers: { 'X-Forwarded-For': '192.0.2.' + i } })).status, 200);
  const limited = await h.request('POST', '/api/register/options', { body: { name: 'Over budget' }, headers: { 'X-Forwarded-For': '198.51.100.99' } });
  assert.equal(limited.status, 429); assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.equal((await h.login(admin)).user.id, admin.user.id);
  assert.equal((await h.request('POST', '/api/pair/create', { actor: admin, body: {} })).status, 200);
});

test('personal recovery adds a passkey to the same owner; pairing/recovery codes are one-use and revoked with sessions', async t => {
  const h = await fixture(t); await h.start(); const owner = await h.register('Owner', h.codes[0]);
  assert.equal((await h.request('POST', '/api/account/device-link', { actor: owner, body: {} })).status, 403);
  const link = await h.request('POST', '/api/account/device-link', { actor: owner, body: await h.proof(owner) });
  assert.equal(link.status, 200); assert.ok(link.body.expires > Date.now());
  const options = await h.request('POST', '/api/device-link/options', { body: { code: link.body.code } });
  assert.equal(options.body.id, owner.user.id);
  const replacementKey = publicInstallAuthenticator(ORIGIN);
  const recovered = await h.request('POST', '/api/device-link/verify', { body: { code: link.body.code, cid: options.body.cid,
    credential: replacementKey.attestation(options.body.options.challenge), userId: 'cannot-select-another-profile' } });
  assert.equal(recovered.status, 200); assert.equal(recovered.body.user.id, owner.user.id); assert.equal(h.db().users.length, 1);
  assert.equal((await h.request('POST', '/api/device-link/options', { body: { code: link.body.code } })).status, 400);
  const recoveredActor = { user: recovered.body.user, cookie: recovered.cookie, key: replacementKey };
  assert.equal((await h.login(recoveredActor)).user.id, owner.user.id);
  const pair = await h.request('POST', '/api/pair/create', { actor: owner, body: {} });
  const paired = await h.request('POST', '/api/pair/redeem', { body: { code: pair.body.code }, headers: { Origin: 'https://localhost' } });
  assert.equal(paired.status, 200); assert.equal(paired.body.user.id, owner.user.id);
  assert.equal((await h.request('POST', '/api/pair/redeem', { body: { code: pair.body.code } })).status, 400);
  const pendingPair = await h.request('POST', '/api/pair/create', { actor: owner, body: {} });
  const pendingLink = await h.request('POST', '/api/account/device-link', { actor: owner, body: await h.proof(owner) });
  assert.equal((await h.request('POST', '/api/logout/all', { actor: owner, body: {} })).status, 200);
  assert.equal((await h.request('GET', '/api/me', { actor: recoveredActor })).status, 401);
  assert.equal((await h.request('GET', '/api/me', { headers: { Authorization: 'Bearer ' + paired.body.token } })).status, 401);
  assert.equal((await h.request('POST', '/api/pair/redeem', { body: { code: pendingPair.body.code } })).status, 400);
  assert.equal((await h.request('POST', '/api/device-link/options', { body: { code: pendingLink.body.code } })).status, 400);
  assert.equal((await h.request('POST', '/api/admin/user/password-reset', { actor: owner, body: { id: owner.user.id } })).status, 404);
  assert.equal((await h.login(recoveredActor)).user.id, owner.user.id);
  assert.equal((await h.request('GET', '/api/config')).body.registration_open, false);
});

test('ambiguous restores and unsafe modes fail without promotion', async t => {
  const noAdmin = await fixture(t, { mode: 'multi-user', users: [{ id: 'old-user', name: 'Existing user' }] });
  await assert.rejects(noAdmin.start(), /public-account-state-invalid/);
  assert.equal(noAdmin.db().users[0].admin, undefined);
  const invalid = await fixture(t, { policy: 'public' }); await assert.rejects(invalid.start(), /invalid-public-account-mode/);
  const permissions = await fixture(t); fs.chmodSync(permissions.directory, 0o755);
  await assert.rejects(permissions.start(), /public-account-data-directory-private-required/);
});

test('an expired recovery link cannot add credentials or reopen personal registration after restart', async t => {
  const h = await fixture(t); await h.start(); const owner = await h.register('Owner', h.codes[0]);
  const link = await h.request('POST', '/api/account/device-link', { actor: owner, body: await h.proof(owner) });
  assert.equal(link.status, 200);
  await h.stop(); const db = h.db(); db.deviceLinks[0].exp = Date.now() - 1;
  fs.writeFileSync(path.join(h.directory, 'db.json'), JSON.stringify(db), { mode: 0o600 });
  await h.start();
  assert.equal((await h.request('POST', '/api/device-link/options', { body: { code: link.body.code } })).status, 400);
  assert.equal(h.db().creds.length, 1); assert.equal(h.db().users.length, 1);
  assert.equal((await h.request('GET', '/api/config')).body.registration_open, false);
  assert.equal((await h.login(owner)).user.id, owner.user.id);
});
