import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { fixture, part, plan, request, scope, entry } from './nutrition-fixtures.mjs';
import { nutritionExecutor } from '../nutrition/executor.js';

test('Nutrition publishes and updates ten years through the real memory-bounded worker', { timeout: 120000 }, async t => {
  const f = await fixture(t), partitions = [], start = performance.now();
  for (let year = 2007; year < 2017; year++) for (let month = 1; month <= 12; month++) {
    const key = `${year}-${String(month).padStart(2, '0')}`;
    const days = new Date(Date.UTC(year, month, 0)).getUTCDate(), foodEntries = [];
    for (let day = 1; day <= days; day++) for (const meal of ['breakfast', 'lunch', 'dinner']) {
      foodEntries.push(entry({ id: `${key}-${day}-${meal}`, d: `${key}-${String(day).padStart(2, '0')}`, meal }));
    }
    const value = await part(0, { id: `journal-${key}-device-a-0`, records: { foodEntries } });
    partitions.push(value); await f.store.upload(value.integrity.digest, value);
  }
  const first = await plan('ten-year-first', partitions), executor = nutritionExecutor({ dataDir: f.dataDir, limits: f.options.limits });
  const call = body => executor.perform(execute => execute({ action: 'publish', scope, body,
    authorization: { sv: 0, exp: Date.now() + 86400000 } }));
  const before = performance.now(); assert.equal((await call(request(first))).status, 200);
  const firstMs = performance.now() - before;
  const last = partitions.at(-1), decoded = (await import('../nutrition/core/serialization.js')).decodePartition;
  const domain = await decoded(last), updated = await part(1, { ...domain, sync: { ...domain.sync, revision: 1, writeId: 'ten-year-edit' },
    records: { foodEntries: domain.records.foodEntries.map((row, index) => index ? row : { ...row, quantity: { amount: 75, unit: 'g' } }) } });
  await f.store.upload(updated.integrity.digest, updated);
  const second = await plan('ten-year-second', [updated], first.manifest), next = performance.now();
  assert.equal((await call(request(second))).status, 200);
  assert.equal((await f.store.head()).manifest.partitions.length, 120);
  assert.deepEqual(await f.store.partition(last.integrity.digest, first.manifest.integrity.digest), last);
  console.log('Nutrition server ten-year fixture:', { partitions: 120, entries: 10959, fixtureAndStageMs: before - start,
    firstPublicationMs: firstMs, checkedUpdateMs: performance.now() - next });
});
