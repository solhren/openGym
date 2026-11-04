// Optional local developer smoke; Playwright is supplied by the operator, not a
// production dependency. Uses a disposable account and Chrome's virtual passkey.
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node browser-smoke.mjs PUBLIC_CIQUAL_DIR
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { boundPort } from '../../api/test/helpers.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const generation = process.argv[2];
assert.equal(process.argv.length, 3, 'Provide one public Ciqual generation directory');
assert.ok(path.isAbsolute(generation) && fs.realpathSync(generation) === generation);
assert.ok(path.isAbsolute(process.env.PLAYWRIGHT_MODULE || ''), 'Set PLAYWRIGHT_MODULE to an existing trusted local Playwright module');
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const runtime = path.join(repository, 'scripts/nutrition-local-catalog/runtime/public-browser-validation');
fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
const run = fs.mkdtempSync(path.join(runtime, 'run-'));
const data = path.join(run, 'data'); fs.mkdirSync(data, { mode: 0o700 });
const fixtureInvite = 'PUBLIC-BROWSER-FIXTURE';
fs.writeFileSync(path.join(data, 'db.json'), JSON.stringify({ users: [], creds: [], subs: [], invites: [{ code: fixtureInvite }] }), { mode: 0o600 });
const port = 5198, origin = `http://localhost:${port}`;
const children = [], evidence = { passed: false, checks: [], layouts: [], externalRequests: 0,
  source: 'official Ciqual 2025, read-only', authenticator: 'Chromium virtual WebAuthn',
  transport: 'loopback HTTP with real Vite proxy/API', docker: false, physicalDevice: false, tls: false };
let browser, stage = 'startup', aborted = false, resourcesTimer;
const reserve = () => {
  const disk = fs.statfsSync(run), memory = Number(/^MemAvailable:\s+(\d+)/m.exec(fs.readFileSync('/proc/meminfo', 'utf8'))[1]) * 1024;
  const value = { disk: disk.bavail * disk.bsize, memory };
  if (value.disk < 20.25 * 1024 ** 3 || value.memory < 2.25 * 1024 ** 3) throw Error('Resource reserve insufficient');
  return value;
};
const child = (args, cwd, env) => {
  const value = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(value); let output = '';
  value.stdout.on('data', b => { output = (output + b).slice(-32768); });
  value.stderr.on('data', b => { output = (output + b).slice(-32768); });
  return { process: value, output: () => output };
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = name => evidence.checks.push(name);
try {
  evidence.initialResources = reserve();
  resourcesTimer = setInterval(() => {
    try { const value = reserve(); evidence.minimumSampled = {
      disk: Math.min(evidence.minimumSampled?.disk ?? Infinity, value.disk),
      memory: Math.min(evidence.minimumSampled?.memory ?? Infinity, value.memory),
    }; } catch { aborted = true; for (const item of children) item.kill('SIGTERM'); void browser?.close(); }
  }, 1000);
  const api = child(['server.js'], path.join(repository, 'api'), {
    PATH: process.env.PATH, NODE_ENV: 'production', PORT: '0', DATA_DIR: data, ORIGIN: origin, RP_ID: 'localhost',
    INVITE_ONLY: '1', ALLOW_GUEST: '0', FIRST_USER_ADMIN: '1', PASSWORD_LOGIN: '0', MEDIA_UPLOADS: '0', COACH_DISABLED: '1', DEFAULT_LANG: 'en',
    OPENGYM_INSTANCE_MODE: 'personal', OPENGYM_SIGNUP_POLICY: 'invite', OPENGYM_MAX_USERS: '1', OPENGYM_LISTEN_HOST: '127.0.0.1',
    OPENGYM_SELF_HOSTED_CATALOG: '1', NUTRITION_LOCAL_CATALOG: '1', NUTRITION_LOCAL_CATALOG_KIND: 'ciqual-local',
    OPENGYM_CATALOG_DIR: generation, OPENGYM_CATALOG_LISTEN_HOST: '127.0.0.1',
  });
  const apiPort = await boundPort(api.process, api.output);
  const vite = child([path.join(repository, 'frontend/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], path.join(repository, 'frontend'), {
    PATH: process.env.PATH, HOME: process.env.HOME, NODE_OPTIONS: '--max-old-space-size=512',
    API_TARGET: `http://127.0.0.1:${apiPort}`, API_ORIGIN: origin, VITE_NUTRITION_LOCAL_V1: '1', VITE_OPENGYM_MANAGED_WEB: '1', VITE_MOBILE: '0', VITE_OPENGYM_PERSONAL_BETA: '0',
  });
  for (let attempt = 0; ; attempt++) {
    if (vite.process.exitCode !== null) throw Error('Isolated Vite exited before readiness');
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) })).ok) break; } catch {}
    assert.ok(attempt < 40, 'Isolated Vite did not become ready'); await pause(250);
  }
  browser = await chromium.launch({ headless: true, env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: run,
    ...(process.env.LD_LIBRARY_PATH ? { LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH } : {}),
    ...(process.env.FONTCONFIG_FILE ? { FONTCONFIG_FILE: process.env.FONTCONFIG_FILE } : {}),
  } }); evidence.browser = browser.version();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'en-US' });
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin !== origin) { evidence.externalRequests++; return route.abort(); }
    return route.continue();
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  stage = 'first account';
  await page.goto(origin);
  await page.getByRole('button', { name: 'Create new profile', exact: true }).click();
  await page.getByRole('textbox', { name: 'Your name', exact: true }).fill('Public browser fixture');
  await page.getByRole('textbox', { name: 'Invite code', exact: true }).fill(fixtureInvite);
  await page.getByRole('button', { name: 'Create passkey', exact: true }).click();
  await page.getByRole('button', { name: 'Nutrition', exact: true }).waitFor();
  check('First owner created through the real registration UI and virtual WebAuthn');
  assert.equal(await page.getByRole('button', { name: 'Continue without account', exact: true }).count(), 0);
  stage = 'search';
  await page.getByRole('button', { name: 'Nutrition', exact: true }).click();
  await page.locator('.nutrition-meals').waitFor();
  await page.getByRole('button', { name: 'Add food', exact: true }).click();
  const query = page.getByRole('combobox', { name: 'Food catalogue', exact: true });
  await query.fill('milk');
  await page.getByRole('listbox').getByRole('option').first().waitFor();
  assert.equal(await page.getByRole('button', { name: 'Scan product barcode', exact: true }).count(), 0);
  await query.press('ArrowDown'); await query.press('Enter');
  await page.locator('.nutrition-product').waitFor();
  const productName = await page.locator('.nutrition-product h3').innerText();
  assert.ok((await page.locator('.nutrition-product').innerText()).includes('100 g'));
  assert.ok((await page.locator('.nutrition-catalog').innerText()).includes('Ciqual'));
  assert.ok(await page.locator('.nutrition-catalog a[href="https://doi.org/10.57745/RDMHWY"]').count());
  evidence.selectedName = productName;
  check('Dynamic local English search and keyboard selection of an official source record');
  for (const width of [320, 390, 768, 1280]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 844 }); await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    const layout = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
    assert.equal(layout.scroll, layout.width, `Horizontal overflow at ${width}/${theme}`);
    evidence.layouts.push({ ...layout, theme });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(run, 'catalogue-390-dark.png'), fullPage: true });
  stage = 'journal mutation';
  await page.getByRole('button', { name: 'Choose quantity', exact: true }).click();
  await page.getByLabel('Quantity', { exact: true }).fill('50');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const edit = () => page.getByRole('button', { name: `Edit ${productName}`, exact: true });
  await edit().waitFor();
  assert.ok((await page.locator('.nutrition-list').innerText()).includes('50 g'));
  await edit().click(); await page.getByLabel('Quantity', { exact: true }).fill('75');
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await edit().waitFor();
  await page.reload(); await edit().waitFor();
  assert.ok((await page.locator('.nutrition-list').innerText()).includes('75 g'));
  check('Quantity add/edit and IndexedDB/session preservation after actual page reload');
  stage = 'backup';
  await page.getByText('More', { exact: true }).click(); await page.getByRole('button', { name: 'Backup', exact: true }).click();
  const downloaded = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export Nutrition', exact: true }).click();
  const download = await downloaded; const backup = path.join(run, 'synthetic-nutrition.zip'); await download.saveAs(backup);
  assert.ok(fs.statSync(backup).size > 0);
  await page.getByLabel('Backup file', { exact: true }).setInputFiles(backup);
  await page.getByRole('button', { name: 'Verify and preview', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm Nutrition restoration', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Confirm Nutrition restoration', exact: true }).click();
  await page.getByText('Nutrition restored locally. Synchronization is pending.', { exact: true }).waitFor();
  check('Browser download, file selection, verified preview and non-destructive Nutrition restore');
  stage = 'offline reuse';
  await page.getByRole('button', { name: 'Journal', exact: true }).click(); await edit().waitFor();
  await context.setOffline(true);
  const deletion = page.getByRole('button', { name: `Delete ${productName}`, exact: true });
  await deletion.click(); const confirmation = page.getByRole('group', { name: `Delete ${productName}`, exact: true });
  await confirmation.getByRole('button', { name: 'Delete', exact: true }).click(); await edit().waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Add food', exact: true }).click();
  await page.getByRole('button', { name: 'Local foods and recipes', exact: true }).click();
  await page.locator('.nutrition-result').filter({ hasText: productName }).first().click();
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await edit().waitFor();
  check('Offline deletion and reuse of the retained saved Food without a supplier');
  await context.setOffline(false);
  stage = 'administration';
  await page.goto(origin + '/#/admin');
  await page.getByText('Public browser fixture', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'New code', exact: true }).count(), 0);
  assert.equal(await page.getByText('Training now', { exact: true }).count(), 0);
  await page.getByRole('button').filter({ hasText: 'Public browser fixture' }).click();
  await page.getByText("Only account access is managed here. This page does not expose the user's workout or Nutrition content.", { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Download their data', exact: true }).count(), 0);
  check('Personal administration exposes account management without invitations or private-history controls');
  stage = 'configuration outage';
  const fresh = await browser.newContext({ locale: 'en-US' });
  const unavailable = await fresh.newPage(); unavailable.setDefaultTimeout(15000);
  await unavailable.route('**/api/config', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
  await unavailable.goto(origin);
  await unavailable.getByRole('button', { name: 'Try again', exact: true }).waitFor();
  assert.equal(await unavailable.getByRole('button', { name: 'Continue without account', exact: true }).count(), 0);
  assert.equal(await unavailable.getByRole('button', { name: 'Create new profile', exact: true }).count(), 0);
  await unavailable.unroute('**/api/config');
  await unavailable.getByRole('button', { name: 'Try again', exact: true }).click();
  await unavailable.getByRole('button', { name: 'Try again', exact: true }).waitFor({ state: 'detached' });
  assert.equal(await unavailable.getByRole('button', { name: 'Create new profile', exact: true }).count(), 0);
  check('Fresh browser refuses guest/signup during API config outage and recovers to closed personal policy');
  await fresh.close();
  assert.deepEqual(errors, []); assert.equal(evidence.externalRequests, 0); assert.equal(aborted, false);
  evidence.finalResources = reserve(); evidence.passed = true;
} catch (error) {
  evidence.failedStage = stage; evidence.error = String(error.message).slice(0, 4000); if (browser?.isConnected()) { const current = browser.contexts()[0]?.pages()[0]; if (current) evidence.visibleText = (await current.locator('body').innerText().catch(() => '')).slice(0, 12000); } throw error;
} finally {
  clearInterval(resourcesTimer);
  await browser?.close().catch(() => {});
  for (const item of children.reverse()) if (item.exitCode === null && item.signalCode === null) {
    const ended = new Promise(resolve => item.once('exit', resolve)); item.kill('SIGTERM');
    const timer = setTimeout(() => item.kill('SIGKILL'), 3000); await ended; clearTimeout(timer);
  }
  fs.writeFileSync(path.join(run, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ evidence: path.relative(repository, path.join(run, 'evidence.json')), passed: evidence.passed, checks: evidence.checks, failedStage: evidence.failedStage }));
}
