import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createPublicCatalog } from '../../scripts/nutrition-local-catalog/public-catalog-client.mjs';
import { normalizeLocalProduct } from '../../frontend/src/lib/nutrition/catalog/local-product.js';
import { publicCatalogFixture, fixtureCatalogSpawn } from './public-catalog-fixtures.mjs';

test('real read-only public reader preserves English/French identity, provenance and unknown values', async t => {
  const fixture = await publicCatalogFixture(t), catalog = await createPublicCatalog({ directory: fixture.directory, spawnProcess: fixtureCatalogSpawn(fixture.specsFile) });
  t.after(() => catalog.close());
  assert.equal((await catalog.inspect()).sha256, fixture.sha256);
  const english = await catalog.search({ q: 'test milk', page: 1, lc: 'en' });
  assert.equal(english.count, 1); assert.equal(english.products[0].name, 'Test milk');
  const en = normalizeLocalProduct(english.products[0]), fr = normalizeLocalProduct(await catalog.product(en.id, { lc: 'fr' }));
  assert.equal(en.id, fr.id); assert.notEqual(en.food.id, fr.food.id);
  assert.equal(fr.name, 'Lait de test'); assert.equal(en.food.name, en.name);
  assert.deepEqual(en.food.reference, { amount: 100, unit: 'g' });
  assert.equal(en.food.source.publicCatalogImport.provider, 'ciqual');
  const rice = await catalog.search({ q: 'rice', page: 1, lc: 'en' });
  assert.equal(rice.count, 3); assert.equal(rice.products[0].id, 'ciqual:99900004', 'exact official label comes first');
  assert.equal(rice.products.at(-1).food, null, 'relevant addable foods precede unknown nutrition');
  const milk = await catalog.search({ q: 'milk', page: 1, lc: 'en' });
  assert.notEqual(milk.products[0].name, 'Milkshake'); assert.equal(milk.products.at(-1).name, 'Milkshake');
  const egg = await catalog.search({ q: 'egg', page: 1, lc: 'en' });
  assert.equal(egg.products[0].name, 'Egg, raw'); assert.equal(egg.products.at(-1).name, 'Eggplant');
  const lait = await catalog.search({ q: 'lait', page: 1, lc: 'fr' });
  assert.notEqual(lait.products[0].name, 'Laitance'); assert.equal(lait.products.at(-1).name, 'Laitance');
  const unknown = normalizeLocalProduct(await catalog.product('ciqual:99900003'));
  assert.equal(unknown.food, null); assert.equal(unknown.reference, null);
  assert.deepEqual(await catalog.barcode('99900001'), []);
  assert.equal(await catalog.product('ciqual:1234'), null);
  assert.equal((await catalog.search({ q: 'rice', page: 1, lc: 'de' })).products[0].language, 'en');
  await assert.rejects(catalog.search({ q: 'rice', page: 21, lc: 'en' }), { code: 'catalogue-read-refused' });
  assert.equal(fs.readdirSync(fixture.directory).some(name => /-wal$|-journal$|-shm$/.test(name)), false);
});

test('a modified or symlinked public generation refuses startup rather than using a provider', async t => {
  const fixture = await publicCatalogFixture(t);
  const manifest = JSON.parse(fs.readFileSync(path.join(fixture.directory, 'current.json'), 'utf8'));
  const file = path.join(fixture.directory, manifest.file);
  await assert.rejects(createPublicCatalog({ directory: fixture.directory }), { code: 'worker-interrupted' });
  fs.appendFileSync(file, 'corrupt');
  await assert.rejects(createPublicCatalog({ directory: fixture.directory, spawnProcess: fixtureCatalogSpawn(fixture.specsFile) }), { code: 'worker-interrupted' });
  const alias = path.join(fixture.root, 'alias'); fs.symlinkSync(fixture.directory, alias);
  await assert.rejects(createPublicCatalog({ directory: alias, spawnProcess: fixtureCatalogSpawn(fixture.specsFile) }), { code: 'worker-interrupted' });
});
