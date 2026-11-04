import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';
import { publicCatalogFixture } from './public-catalog-fixtures.mjs';
import { publicInstallAuthenticator } from './public-install-auth.mjs';
import { createFoodCatalog } from '../../frontend/src/lib/nutrition/catalog/client.js';
import { createNutritionLocalStore } from '../../frontend/src/lib/nutrition/local-store.js';
import { nutritionFsBackend } from '../../frontend/src/lib/nutrition/local-store-fs.js';
import { diskBridge } from '../../frontend/src/lib/nutrition/local-storage.test-util.js';
import { createNutritionCommands, daySummary } from '../../frontend/src/lib/nutrition/ui-service.js';
import { createNutritionSync } from '../../frontend/src/lib/nutrition/sync.js';
import { createNutritionBackup } from '../../frontend/src/lib/nutrition/backup.js';

const API = fileURLToPath(new URL('../', import.meta.url)), origin = 'https://public-gym.example';

test('public production installation: first passkey account, paired catalogue, journal, restart and backup restoration', { timeout: 30000 }, async t => {
  const fixture = await publicCatalogFixture(t), dataDir = path.join(fixture.root, 'accounts');
  fs.mkdirSync(dataDir, { mode: 0o700 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ users: [], creds: [], subs: [],
    invites: [{ code: 'SYNTHETIC-BOOTSTRAP-INVITE', createdBy: 'local-bootstrap', note: 'synthetic installation test' }] }), { mode: 0o600 });
  let child, base, registry = null, log = '';
  const stop = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const ended = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await ended;
  };
  t.after(stop);
  const start = async () => {
    log = '';
    child = spawn(process.execPath, ['--import', './test/public-install-loader.mjs', 'server.js'], { cwd: API, stdio: ['ignore', 'pipe', 'pipe'], env: {
      PATH: process.env.PATH, NODE_ENV: 'production', PORT: '0', DATA_DIR: dataDir, ORIGIN: origin, RP_ID: 'public-gym.example',
      FIRST_USER_ADMIN: '1', INVITE_ONLY: '1', ALLOW_GUEST: '0', PASSWORD_LOGIN: '0', MEDIA_UPLOADS: '0', COACH_DISABLED: '1',
      OPENGYM_SELF_HOSTED_CATALOG: '1', NUTRITION_LOCAL_CATALOG: '1', NUTRITION_LOCAL_CATALOG_KIND: registry ? 'public-registry' : 'ciqual-local', OPENGYM_CATALOG_DIR: fixture.directory,
      OPENGYM_CATALOG_LISTEN_HOST: '127.0.0.1',
      ...(registry ? { OPENGYM_CATALOG_REGISTRY: registry } : {})
    } });
    child.stdout.on('data', chunk => log += chunk); child.stderr.on('data', chunk => log += chunk);
    base = 'http://127.0.0.1:' + await boundPort(child, () => log);
  };
  await start();
  let cookie = '', bearer = '';
  const call = (method, route, body, headers = {}) => fetch(base + route, { method,
    headers: { 'Content-Type': 'application/json', Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  for (const route of ['/api/nutrition/catalog/capabilities', '/api/nutrition/catalog/search?q=rice', '/api/nutrition/catalog/product?id=ciqual:99900001']) {
    assert.equal((await call('GET', route)).status, 401);
  }
  assert.equal((await call('POST', '/api/register/options', { name: 'Fixture owner', code: 'wrong' })).status, 403);
  const authenticator = publicInstallAuthenticator(origin);
  const registration = await (await call('POST', '/api/register/options', { name: 'Fixture owner', code: 'SYNTHETIC-BOOTSTRAP-INVITE' })).json();
  const registered = await call('POST', '/api/register/verify', { cid: registration.cid, credential: authenticator.attestation(registration.options.challenge) });
  assert.equal(registered.status, 200);
  const owner = (await registered.json()).user; assert.equal(owner.admin, true);
  cookie = registered.headers.getSetCookie().find(value => value.startsWith('__Host-gymsid=')).split(';')[0];
  await call('POST', '/api/logout'); cookie = '';
  const options = await (await call('POST', '/api/login/options', {})).json();
  const loggedIn = await call('POST', '/api/login/verify', { cid: options.cid, credential: authenticator.assertion(options.options.challenge) });
  assert.equal(loggedIn.status, 200);
  cookie = loggedIn.headers.getSetCookie().find(value => value.startsWith('__Host-gymsid=')).split(';')[0];
  const pairing = await (await call('POST', '/api/pair/create', {})).json();
  const paired = await (await call('POST', '/api/pair/redeem', { code: pairing.code }, { Cookie: '' })).json();
  bearer = paired.token; assert.equal(paired.user.id, owner.id);
  assert.equal((await call('GET', '/api/nutrition/catalog/capabilities', undefined, { Cookie: '', Authorization: 'Bearer ' + bearer, Origin: 'https://localhost', 'Sec-Fetch-Site': 'cross-site' })).status, 200);
  assert.equal((await call('GET', '/api/nutrition/catalog/search?q=rice', undefined, { Origin: 'https://foreign.example' })).status, 403);
  assert.equal((await call('GET', '/api/nutrition/catalog/product?code=99900001')).status, 404);

  const catalogRead = (route, options = {}) => call('GET', route, undefined, { Cookie: '', Authorization: 'Bearer ' + bearer });
  const catalog = createFoodCatalog({ localOnlyV1: true, transport: () => { throw Error('external provider forbidden'); },
    capabilitiesTransport: catalogRead, localTransport: catalogRead });
  t.after(() => catalog.close());
  assert.equal((await catalog.capabilities()).provider, 'ciqual');
  const found = await catalog.search('test milk', { language: 'en' }); assert.equal(found.products.length, 1);
  const selected = (await catalog.localProduct(found.products[0].id, { language: 'en' })).product;
  assert.equal(selected.food.name, 'Test milk'); assert.equal(selected.food.source.publicCatalogImport.provider, 'ciqual');
  const session = { userId: owner.id, serverOrigin: origin, epoch: 1 }, scope = { namespace: { profileId: owner.id, serverOrigin: origin }, generation: 'public-installation-1' };
  const transport = async (route, options = {}) => {
    const response = await call(options.method || 'GET', route, options.body ? JSON.parse(options.body) : undefined), data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error || data.code), { status: response.status, data });
    return data;
  };
  let sequence = 0;
  const makeDevice = async name => {
    const disk = await diskBridge({ baseDirectory: path.join(fixture.root, name) }); t.after(() => disk.cleanup());
    const open = () => createNutritionLocalStore({ ...scope, deviceId: name, backend: nutritionFsBackend({ loadPlugin: async () => disk.plugin }) });
    let store = await open(); t.after(() => store.close());
    return { get store() { return store; }, async reopen() { store.close(); store = await open(); },
      sync: () => createNutritionSync({ store, getSession: () => session, transport, newId: () => 'sync-' + ++sequence }),
      backup: () => createNutritionBackup({ store, getSession: () => session }) };
  };
  const a = await makeDevice('first-device');
  const entry = { schemaVersion: 1, id: 'public-entry', d: '2026-11-04', meal: 'breakfast', snapshot: selected.food, quantity: { amount: 50, unit: 'g' } };
  await createNutritionCommands({ store: a.store, newId: () => 'intent-' + ++sequence }).save('foodEntries', entry);
  assert.equal((await a.sync().run()).status, 'synced');
  assert.equal(daySummary((await a.store.readDay(entry.d)).entries, [], entry.d).totals.kcal, 30);
  const exported = await a.backup().export(); assert.ok(exported.blob.size > 0);
  await a.reopen(); assert.deepEqual((await a.store.readDay(entry.d)).entries[0].snapshot, selected.food);
  await stop(); await start();
  const b = await makeDevice('second-device'); assert.equal((await b.sync().run()).status, 'synced');
  assert.deepEqual((await b.store.readDay(entry.d)).entries[0], entry);
  const c = await makeDevice('restore-device'), backup = c.backup();
  const preview = await backup.preview(exported.blob, { restoreId: 'public-install-restore', datasets: 'nutrition' });
  assert.equal(preview.applicable, true); assert.equal((await backup.restore(preview)).status, 'restored');
  assert.equal((await c.store.readDay(entry.d)).entries.length, 1);
  assert.equal((await c.sync().run()).status, 'synced');
  registry = path.join(path.dirname(fixture.directory), 'registry.json');
  const publishRegistry = catalogues => {
    fs.writeFileSync(registry + '.tmp', JSON.stringify({ format: 'opengym-public-catalogue-registry', version: 1, catalogues }));
    fs.renameSync(registry + '.tmp', registry);
  };
  publishRegistry([{ id: 'ciqual-test', kind: 'ciqual-local', directory: 'catalogue', enabled: true, catalogueSha256: fixture.sha256 }]);
  await stop(); await start();
  assert.equal((await call('GET', '/api/nutrition/catalog/capabilities')).status, 200);
  assert.equal((await call('GET', '/api/nutrition/catalog/search?q=milk&lc=en')).status, 200);
  publishRegistry([]); await stop(); await start();
  assert.equal((await call('GET', '/api/nutrition/catalog/capabilities', undefined, { Cookie: '' })).status, 401);
  for (const route of ['/api/nutrition/catalog/capabilities', '/api/nutrition/catalog/search?q=milk', '/api/nutrition/catalog/product?id=ciqual:99900002']) {
    assert.equal((await call('GET', route)).status, 503, 'last source removed never enables an external provider');
  }
  assert.equal((await c.sync().run()).status, 'synced');
  assert.equal((await c.store.readDay(entry.d)).entries.length, 1, 'personal Nutrition survives the catalogue removal');
  assert.equal((await call('POST', '/api/logout/all', {})).status, 200);
  assert.equal((await call('GET', '/api/nutrition/catalog/search?q=rice', undefined, { Cookie: '', Authorization: 'Bearer ' + bearer })).status, 401);
});
