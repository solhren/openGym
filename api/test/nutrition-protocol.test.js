import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJson, readNutritionBody } from '../nutrition/protocol.js';
import { Readable } from 'node:stream';
import { DEFAULT_LIMITS, nutritionLimits } from '../nutrition/executor.js';

for (const [name, raw, expected] of [
  ['duplicate fields', '{"id":1,"id":2}', 'nutrition-duplicate-key'],
  ['escaped duplicate fields', '{"id":1,"\\u0069d":2}', 'nutrition-duplicate-key'],
  ['nested duplicate fields', '{"a":{"x":0,"x":1}}', 'nutrition-duplicate-key'],
  ['unsupported depth', '{"a":'.repeat(65) + '0' + '}'.repeat(65), 'nutrition-json-too-deep'],
  ['invalid JSON', '{"a":', 'nutrition-invalid-json'],
  ['scalar JSON', 'null', 'nutrition-invalid-json'],
  ['array JSON', '[]', 'nutrition-invalid-json'],
]) test(`Nutrition transport rejects ${name}`, () => assert.throws(() => parseJson(Buffer.from(raw), 524288), error => error.code === expected));
test('Nutrition transport does not count escaped delimiters or identical keys in separate objects as duplicates', () => {
  const value = { name: '"{}[]\\', a: [{ x: 1 }, { x: 2 }], b: { x: 3 } };
  assert.deepEqual(parseJson(Buffer.from(JSON.stringify(value)), 524288), value);
});
test('Nutrition transport enforces UTF-8 bytes and refuses malformed encoding', () => {
  assert.throws(() => parseJson(Buffer.from('{"x":"é"}'), 9), error => error.status === 413);
  assert.throws(() => parseJson(Buffer.from([0x7b, 0xff, 0x7d]), 10), error => error.code === 'nutrition-invalid-utf8');
});
test('Nutrition limits are explicit, integer, configurable and never silently disabled', () => {
  assert.equal(nutritionLimits({}).maxBytes, DEFAULT_LIMITS.maxBytes);
  assert.equal(nutritionLimits({ NUTRITION_MAX_BYTES: '1048576' }).maxBytes, 1048576);
  for (const value of ['0', '-1', 'abc', 'Infinity', '1048576.5']) assert.throws(() => nutritionLimits({ NUTRITION_MAX_BYTES: value }));
});
test('frontend and server use the same contract constructors and SHA implementation', async () => {
  const core = await import('../nutrition/core/contracts.js'), front = await import('../../frontend/src/lib/nutrition/contracts.js');
  const hash = await import('../shared/sha256.js'), browser = await import('../../frontend/src/lib/sha256.js');
  assert.equal(core.NutritionValidationError, front.NutritionValidationError);
  assert.equal(hash.sha256Hex, browser.sha256Hex);
});
test('Nutrition body abortion releases the request instead of publishing a partial document', async () => {
  const req = new Readable({ read() {} }); req.headers = { 'content-type': 'application/json' };
  const body = readNutritionBody(req, 524288, { idleMs: 100, totalMs: 200 });
  req.push(Buffer.from('{"unfinished":')); req.emit('aborted');
  await assert.rejects(body, error => error.clientGone === true); req.destroy();
});

test('combined Nutrition recovery decoder preserves portable v1 and independently captured historical snapshots', async () => {
  const { part } = await import('./nutrition-fixtures.mjs');
  const { decodePartitionDocument, decodePartition } = await import('../nutrition/core/serialization.js');
  const portable = await part(), decoded = await decodePartitionDocument(portable);
  assert.deepEqual(decoded.partition, portable);
  assert.deepEqual(decoded.domain, await decodePartition(portable));
  decoded.domain.records.foodEntries[0].snapshot.name = 'Changed by consumer';
  assert.equal(Object.values(decoded.partition.snapshots)[0].name, 'Oats');
  assert.equal(Object.values(portable.snapshots)[0].name, 'Oats');
  const broken = structuredClone(portable); broken.records.foodEntries[0].snapshotRef = '0'.repeat(64);
  await assert.rejects(decodePartitionDocument(broken), error => error.issues.some(i => i.code === 'checksum_mismatch'));
});
