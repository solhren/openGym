// Verify registration in the real API, anonymous reads and existing origin handling.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { boundPort } from './helpers.mjs';
let child, dir, address;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opengym-catalog-http-'));
  child = spawn(process.execPath, ['server.js'], { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, PORT: '0', DATA_DIR: dir, ORIGIN: 'http://localhost:8080', TRUST_PROXY: '0' } });
  let output = ''; child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { output += d; });
  address = `http://127.0.0.1:${await boundPort(child, () => output)}`;
});
after(async () => { if (child && child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); } if (dir) fs.rmSync(dir, { recursive: true, force: true }); });
test('real server anonymous search reaches validator, not Nutrition authentication', async () => {
  const r = await fetch(address + '/api/nutrition/catalog/search?q=x'); assert.equal(r.status, 400); assert.equal((await r.json()).code, 'catalog-invalid-query');
});
test('real server anonymous barcode route is registered and strictly bounded', async () => {
  const r = await fetch(address + '/api/nutrition/catalog/product?code=../secret'); assert.equal(r.status, 400);
});
test('real server foreign-origin catalogue request refused before any provider request', async () => {
  const r = await fetch(address + '/api/nutrition/catalog/search?q=nutella', { headers: { Origin: 'https://evil.test' } }); assert.equal(r.status, 403);
});
test('real server exposes no catalogue writes or generic proxy', async () => {
  assert.equal((await fetch(address + '/api/nutrition/catalog/search', { method: 'POST', headers: { Origin: 'http://localhost:8080' } })).status, 404);
  assert.equal((await fetch(address + '/api/nutrition/catalog/search?q=nutella&url=http://127.0.0.1')).status, 400);
});
