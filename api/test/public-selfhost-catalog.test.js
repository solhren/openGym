import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { selfHostedCatalogConfig, experimentalCatalogRelay, createPublicCatalogRelay } from '../nutrition/catalog-local.js';

const environment = {
  NODE_ENV: 'production', DATA_DIR: '/data', OPENGYM_SELF_HOSTED_CATALOG: '1',
  NUTRITION_LOCAL_CATALOG: '1', NUTRITION_LOCAL_CATALOG_KIND: 'ciqual-local',
  OPENGYM_CATALOG_DIR: '/catalogues/ciqual-2025'
};
const manifest = { format: 'opengym-public-food-catalog', schemaVersion: 1, provider: 'ciqual', sha256: 'a'.repeat(64), rows: 2, literalOnly: true };

test('the explicit generic production profile accepts /data without inheriting beta configuration', () => {
  assert.equal(selfHostedCatalogConfig({ environment: {} }), null);
  assert.deepEqual(selfHostedCatalogConfig({ environment }), { directory: '/catalogues/ciqual-2025', listenHost: '127.0.0.1' });
  assert.equal(selfHostedCatalogConfig({ environment: { ...environment, OPENGYM_CATALOG_LISTEN_HOST: '0.0.0.0' } }).listenHost, '0.0.0.0');
  for (const extra of [{ NODE_ENV: 'development' }, { NUTRITION_LOCAL_CATALOG: '0' }, { NUTRITION_LOCAL_CATALOG_KIND: 'wger-v1' },
    { OPENGYM_PRIVATE_BETA: '1' }, { OPENGYM_PERSONAL_BETA: '1' }, { OPENGYM_BETA_DOCKER: '1' },
    { OPENGYM_CATALOG_DIR: '/data' }, { OPENGYM_CATALOG_DIR: '/data/public' }, { OPENGYM_CATALOG_DIR: '/' },
    { OPENGYM_CATALOG_DIR: 'relative' }, { OPENGYM_CATALOG_DIR: '/catalogues/../data' }, { DATA_DIR: '/catalogues' },
    { OPENGYM_CATALOG_LISTEN_HOST: 'localhost' }, { OPENGYM_CATALOG_LISTEN_HOST: '::' }, { OPENGYM_CATALOG_LISTEN_HOST: '' }]) {
    assert.throws(() => selfHostedCatalogConfig({ environment: { ...environment, ...extra } }), /invalid-self-hosted-catalogue-configuration/);
  }
});

test('a public reader failure refuses startup and never constructs an external provider', async () => {
  let closed = 0, external = 0;
  await assert.rejects(experimentalCatalogRelay({ environment, dataDir: '/data',
    remote: { read() { external++; } },
    loadPublic: async () => ({ createPublicCatalog: async () => ({ inspect() { throw Error('broken'); }, async close() { closed++; } }) })
  }), /self-hosted-catalogue-unavailable/);
  assert.equal(closed, 1); assert.equal(external, 0);
  await assert.rejects(experimentalCatalogRelay({ environment, dataDir: '/data',
    loadPublic: async () => ({ createPublicCatalog: async () => ({ inspect: async () => ({ ...manifest, provider: 'wger' }), async close() {} }) })
  }), /self-hosted-catalogue-unavailable/);
});

test('generic Ciqual routes are bounded, language-aware and never interpret barcodes as food codes', async () => {
  const calls = [];
  const catalog = { inspect: async () => manifest, close: async () => {},
    search: async args => { calls.push(args); return { products: [], count: 0, page: args.page, pageSize: 20 }; },
    product: async (id, options) => { calls.push({ id, lc: options.lc }); return { id }; } };
  const relay = createPublicCatalogRelay({ catalog }); await relay.warm();
  assert.equal(relay.capabilities.provider, 'ciqual');
  await relay.read('search', '/api/nutrition/catalog/search?q=Cooked%20rice&lc=en&page=2');
  assert.deepEqual(calls[0], { q: 'Cooked rice', lc: 'en', page: 2 });
  assert.equal((await relay.read('product', '/api/nutrition/catalog/product?id=ciqual:1234&lc=en')).body.product.id, 'ciqual:1234');
  assert.deepEqual(calls[1], { id: 'ciqual:1234', lc: 'en' });
  for (const query of ['q=riz&page=21', 'q=riz&q=rice', 'q=riz&staging=1', 'q=riz&url=http://private', 'q=riz&lc=english']) {
    await assert.rejects(relay.read('search', '/api/nutrition/catalog/search?' + query), { code: 'catalog-invalid-query' });
  }
  await assert.rejects(relay.read('product', '/api/nutrition/catalog/product?code=00001234'), { status: 404, code: 'catalog-not-found' });
  assert.equal(calls.length, 2);
  await relay.close(); await assert.rejects(relay.read('search', '/api/nutrition/catalog/search?q=riz'), { code: 'catalog-request-cancelled' });
});

test('registry aliases of the same proven generation are deduplicated; empty stays local-unavailable', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'public-registry-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const registry = path.join(root, 'registry.json'), config = { ...environment, NUTRITION_LOCAL_CATALOG_KIND: 'public-registry', OPENGYM_CATALOG_REGISTRY: registry };
  const entry = (id, extra = {}) => ({ id, kind: 'ciqual-local', directory: id, enabled: true, catalogueSha256: manifest.sha256, ...extra });
  const write = catalogues => fs.writeFileSync(registry, JSON.stringify({ format: 'opengym-public-catalogue-registry', version: 1, catalogues }));
  let starts = 0, closes = 0;
  const loadPublic = async () => ({ createPublicCatalog: async () => { starts++; return { inspect: async () => manifest, close: async () => { closes++; } }; } });
  write([entry('first'), entry('alias')]);
  const relay = await experimentalCatalogRelay({ environment: config, dataDir: '/data', loadPublic });
  assert.equal(relay.capabilities.provider, 'ciqual'); assert.equal(starts, 2); assert.equal(closes, 1);
  await relay.close(); assert.equal(closes, 2);
  write([]);
  const empty = await experimentalCatalogRelay({ environment: config, dataDir: '/data', loadPublic });
  assert.equal(empty.available, false); assert.equal(starts, 2);
  await assert.rejects(empty.read('search', '/api/nutrition/catalog/search?q=rice'), { code: 'catalog-local-unavailable' });
  for (const entries of [[entry('one', { kind: 'wger-v1' })], [entry('one', { directory: '../private' })],
    [entry('one'), entry('two', { catalogueSha256: 'b'.repeat(64) })], [entry('one'), entry('one')]]) {
    write(entries);
    await assert.rejects(experimentalCatalogRelay({ environment: config, dataDir: '/data', loadPublic }), /self-hosted-catalogue-unavailable/);
    assert.equal(starts, 2, 'invalid plan is refused before any reader starts');
  }
});
