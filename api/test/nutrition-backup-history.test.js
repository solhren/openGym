import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fixture, part, plan, publish, entry } from './nutrition-fixtures.mjs';
import { preserveHistory } from '../nutrition/core/history.js';
import { contentHash } from '../nutrition/core/persistence-contract.js';

for (const name of ['nutritionSyncConflicts', 'nutritionBackupRestores', 'nutritionBackupRestorePreparations', 'nutritionBackupTombstones']) {
  test(`Nutrition server retains ${name} when an older client omits it`, async t => {
    const f = await fixture(t), row = name === 'nutritionSyncConflicts' ? { collection: 'foodEntries', id: 'entry-a', record: entry(), marker: null } :
      name === 'nutritionBackupTombstones' ? { collection: 'foodEntries', id: 'old-entry', stamp: { counter: 1, deviceId: 'a' } } : { requestDigest: 'b'.repeat(64), ...(name === 'nutritionBackupRestorePreparations' ? { baseDigest: 'c'.repeat(64) } : {}) };
    const records = { [await contentHash(row)]: row };
    const first = await plan('with-evidence', [await part(0, { extensions: { [name]: { version: 1, records } } })]);
    await publish(f.store, first);
    const missing = await plan('missing-evidence', [await part(1)], first.manifest);
    await assert.rejects(publish(f.store, missing), error => error.issues?.some(i => i.code === 'history_metadata_missing'));
    assert.equal((await f.store.head()).head.commitId, 'with-evidence');
    const alteredRow = name === 'nutritionBackupTombstones' ? { ...row, id: 'other-entry' } :
      name === 'nutritionSyncConflicts' ? { ...row, record: entry({ id: 'entry-a', quantity: { amount: 99, unit: 'g' } }) } :
      { ...row, requestDigest: 'c'.repeat(64) };
    const altered = await plan('altered-evidence', [await part(1, { extensions: { [name]: { version: 1,
      records: { [await contentHash(alteredRow)]: alteredRow } } } })], first.manifest);
    await assert.rejects(publish(f.store, altered), error => error.issues?.some(i => i.code === 'history_metadata_missing'));
    const kept = await plan('retained-evidence', [await part(1, { extensions: { [name]: { version: 1, records } } })], first.manifest);
    await publish(f.store, kept); assert.equal((await f.store.head()).head.commitId, 'retained-evidence');
  });
}
test('Nutrition metadata can move atomically between partitions but incompatible duplicates fail', () => {
  const marker = { ['a'.repeat(64)]: { requestDigest: 'b'.repeat(64) } };
  const old = [{ records: {}, sync: { edits: [], tombstones: [] }, extensions: { nutritionBackupRestores: { version: 1, records: marker } } }];
  assert.doesNotThrow(() => preserveHistory(old, [{ records: {}, sync: { edits: [], tombstones: [] } }, old[0]]));
  const corrupted = structuredClone(old[0]); corrupted.extensions.nutritionBackupRestores.records['a'.repeat(64)].requestDigest = 'c'.repeat(64);
  assert.throws(() => preserveHistory(old, [old[0], corrupted]), error => error.issues?.some(i => i.code === 'history_metadata_collision'));
});

test('Nutrition server rejects malformed restore metadata before storing its partition', async t => {
  const f = await fixture(t);
  for (const [name, row, code] of [
    ['nutritionBackupRestores', { requestDigest: 'invalid' }, 'invalid_restore_receipt'],
    ['nutritionBackupRestorePreparations', { requestDigest: 'b'.repeat(64) }, 'required_field'],
    ['nutritionBackupTombstones', { collection: 'foodEntries', id: 'old-entry', stamp: { counter: 1, deviceId: 'a' } }, 'backup_metadata_checksum_mismatch'],
  ]) {
    const value = await part(0, { extensions: { [name]: { version: 1, records: { ['a'.repeat(64)]: row } } } });
    await assert.rejects(f.store.upload(value.integrity.digest, value), error => error.issues?.some(i => i.code === code));
    assert.equal((await f.store.head()).head, null);
    assert.equal(existsSync(`${f.dir}/p-${value.integrity.digest}.json`), false);
  }
});
