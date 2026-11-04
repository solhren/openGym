// Explicit, optional smoke against an operator-supplied PUBLIC read-only Ciqual generation.
// Accounts/authenticator/storage are disposable fixtures. Never called by npm test or Docker.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';
import { publicInstallAuthenticator } from './public-install-auth.mjs';
import { normalizeLocalProduct } from '../../frontend/src/lib/nutrition/catalog/local-product.js';
import { createNutritionLocalStore } from '../../frontend/src/lib/nutrition/local-store.js';
import { nutritionFsBackend } from '../../frontend/src/lib/nutrition/local-store-fs.js';
import { diskBridge } from '../../frontend/src/lib/nutrition/local-storage.test-util.js';
import { createNutritionCommands, daySummary } from '../../frontend/src/lib/nutrition/ui-service.js';
import { createNutritionSync } from '../../frontend/src/lib/nutrition/sync.js';
import { createNutritionBackup } from '../../frontend/src/lib/nutrition/backup.js';

const directory = process.argv[2];
assert.equal(process.argv.length, 3, 'provide one public generation directory');
assert.ok(path.isAbsolute(directory) && fs.realpathSync(directory) === directory);
const api = fileURLToPath(new URL('../', import.meta.url)), runtime = fileURLToPath(new URL('../../scripts/nutrition-local-catalog/runtime/', import.meta.url));
fs.mkdirSync(runtime, { recursive: true });
const root = fs.mkdtempSync(path.join(runtime, 'official-http-fixture-')), data = path.join(root, 'accounts');
fs.mkdirSync(data, { mode: 0o700 });
fs.writeFileSync(path.join(data, 'db.json'), JSON.stringify({ users: [], creds: [], subs: [], invites: [{ code: 'PUBLIC-SMOKE-FIXTURE' }] }), { mode: 0o600 });
const origin = 'https://public-gym.example';
let child, disk, store, output = '', summary;
try {
  child = spawn(process.execPath, ['server.js'], { cwd: api, stdio: ['ignore', 'pipe', 'pipe'], env: {
    PATH: process.env.PATH, NODE_ENV: 'production', PORT: '0', DATA_DIR: data, ORIGIN: origin, RP_ID: 'public-gym.example',
    INVITE_ONLY: '1', ALLOW_GUEST: '0', FIRST_USER_ADMIN: '1', MEDIA_UPLOADS: '0', COACH_DISABLED: '1',
    OPENGYM_SELF_HOSTED_CATALOG: '1', NUTRITION_LOCAL_CATALOG: '1', NUTRITION_LOCAL_CATALOG_KIND: 'ciqual-local', OPENGYM_CATALOG_DIR: directory,
    OPENGYM_CATALOG_LISTEN_HOST: '127.0.0.1'
  } });
  child.stdout.on('data', bytes => output += bytes); child.stderr.on('data', bytes => output += bytes);
  const base = 'http://127.0.0.1:' + await boundPort(child, () => output);
  let cookie = '';
  const call = (method, route, body) => fetch(base + route, { method, headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.equal((await call('GET', '/api/nutrition/catalog/capabilities')).status, 401);
  const key = publicInstallAuthenticator(origin), ceremony = await (await call('POST', '/api/register/options', { name: 'Smoke fixture', code: 'PUBLIC-SMOKE-FIXTURE' })).json();
  const registered = await call('POST', '/api/register/verify', { cid: ceremony.cid, credential: key.attestation(ceremony.options.challenge) });
  assert.equal(registered.status, 200);
  const user = (await registered.json()).user; assert.equal(user.admin, true);
  cookie = registered.headers.getSetCookie().find(value => value.startsWith('__Host-gymsid=')).split(';')[0];
  const capabilities = await (await call('GET', '/api/nutrition/catalog/capabilities')).json(); assert.equal(capabilities.provider, 'ciqual');
  const english = await (await call('GET', '/api/nutrition/catalog/search?q=milk&lc=en')).json();
  const french = await (await call('GET', '/api/nutrition/catalog/search?q=lait&lc=fr')).json();
  const found = english.products.map(normalizeLocalProduct).find(product => product.food && product.food.nutrients.kcal !== null);
  assert.ok(found && french.products.length);
  const selected = normalizeLocalProduct((await (await call('GET', '/api/nutrition/catalog/product?id=' + encodeURIComponent(found.id) + '&lc=en')).json()).product);
  assert.equal(selected.id, found.id); assert.equal(selected.food.name, found.name); assert.equal(selected.food.reference.unit, 'g');
  disk = await diskBridge({ baseDirectory: path.join(root, 'client') });
  const scope = { namespace: { profileId: user.id, serverOrigin: origin }, generation: 'official-http-fixture-1' };
  const open = () => createNutritionLocalStore({ ...scope, deviceId: 'smoke-device', backend: nutritionFsBackend({ loadPlugin: async () => disk.plugin }) });
  store = await open(); let sequence = 0;
  const entry = { schemaVersion: 1, id: 'official-smoke-entry', d: '2026-11-04', meal: 'breakfast', snapshot: selected.food, quantity: { amount: 50, unit: 'g' } };
  await createNutritionCommands({ store, newId: () => 'smoke-' + ++sequence }).save('foodEntries', entry);
  const session = { userId: user.id, serverOrigin: origin, epoch: 1 };
  const transport = async (route, options = {}) => {
    const response = await call(options.method || 'GET', route, options.body ? JSON.parse(options.body) : undefined), value = await response.json();
    if (!response.ok) throw Object.assign(new Error(value.error || value.code), { status: response.status, data: value });
    return value;
  };
  assert.equal((await createNutritionSync({ store, getSession: () => session, transport }).run()).status, 'synced');
  assert.equal(daySummary((await store.readDay(entry.d)).entries, [], entry.d).totals.kcal, selected.food.nutrients.kcal / 2);
  const exported = await createNutritionBackup({ store, getSession: () => session }).export(); assert.ok(exported.blob.size > 0);
  store.close(); store = await open(); assert.equal((await store.readDay(entry.d)).entries[0].snapshot.source.publicCatalogImport.provider, 'ciqual');
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'current.json'), 'utf8'));
  summary = { passed: true, profile: 'production-selfhost-ciqual', source: 'official-pinned-read-only', catalogueSha256: manifest.sha256,
    rows: manifest.rows, englishMatches: english.count, frenchMatches: french.count, selectedLookup: selected.id, selectedName: selected.name,
    journalEntries: 1, nutritionSync: 'synced', reopen: true, backupBytes: exported.blob.size,
    account: 'disposable-software-authenticator', transport: 'loopback HTTP', listenHost: '127.0.0.1', dockerRun: false, tlsVerified: false, physicalDevice: false };
} finally {
  store?.close(); await disk?.cleanup();
  if (child && child.exitCode === null && child.signalCode === null) {
    const ended = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000); await ended; clearTimeout(timer);
  }
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(JSON.stringify(summary, null, 2));
