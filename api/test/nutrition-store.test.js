import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, part, plan, request, publish, scope, entry, status } from './nutrition-fixtures.mjs';
import { decodePartition } from '../nutrition/core/serialization.js';
import { sealDocument, contentHash, boundedJson } from '../nutrition/core/persistence-contract.js';
import { createNutritionServerStore } from '../nutrition/store.js';
import { prepareOwner } from '../nutrition/files.js';

test('Nutrition stages immutable partitions and publishes an exact v1 manifest independently', async t => {
  const f = await fixture(t), a = await part(), prepared = await plan('first', [a]);
  assert.equal((await f.store.head()).status, 'uninitialized');
  assert.equal((await f.store.upload(a.integrity.digest, a)).staged, true);
  assert.equal((await f.store.head()).head, null);
  await assert.rejects(f.store.partition(a.integrity.digest, prepared.manifest.integrity.digest), status(404));
  const saved = await f.store.publish(request(prepared));
  assert.deepEqual(saved.head, prepared.head);
  assert.equal(saved.receipt.requestDigest, await contentHash(request(prepared)));
  assert.deepEqual(await f.store.manifest(prepared.manifest.integrity.digest), prepared.manifest);
  assert.deepEqual((await decodePartition(await f.store.partition(a.integrity.digest, prepared.manifest.integrity.digest))).records.foodEntries, [entry()]);
  const next = await f.reopen(); assert.equal((await next.head()).head.commitId, 'first');
  assert.equal(fs.statSync(path.join(f.dir, 'head.json')).mode & 0o777, 0o600);
});
test('Nutrition repeats exact uploads and commits, including after a later commit', async t => {
  const f = await fixture(t), a = await part(), first = await plan('first', [a]);
  const saved = await publish(f.store, first);
  assert.equal((await f.store.upload(a.integrity.digest, a)).repeated, true);
  const second = await plan('second', [await part(1)], first.manifest); await publish(f.store, second);
  const repeated = await f.store.publish(request(first));
  assert.equal(repeated.repeated, true); assert.deepEqual(repeated.receipt, saved.receipt);
  assert.equal((await f.store.head()).head.commitId, 'second');
  const altered = { ...request(first), expectedHead: second.head };
  await assert.rejects(f.store.publish(altered), status(409, 'nutrition-commit-id-conflict'));
});
test('Nutrition refuses stale heads, nonadvancing revisions and sequence jumps', async t => {
  const f = await fixture(t), first = await plan('first', [await part()]); await publish(f.store, first);
  await assert.rejects(f.store.publish(request(await plan('stale', []))), status(409, 'nutrition-stale-head'));
  const second = await plan('second', [await part(1)], first.manifest);
  await f.store.upload(second.writes[0].integrity.digest, second.writes[0]);
  const { integrity: ignored, ...payload } = second.manifest;
  const badManifest = await sealDocument({ ...payload, sequence: 2 });
  const { integrity: ignoredHead, ...headPayload } = second.head;
  const badHead = await sealDocument({ ...headPayload, manifestDigest: badManifest.integrity.digest });
  await assert.rejects(f.store.publish({ expectedHead: first.head, manifest: badManifest, head: badHead }), error => error.issues?.some(i => i.code === 'nonadvancing_sequence'));
  const sameRev = await part(0, { records: { foodEntries: [entry({ meal: 'dinner' })] } });
  await f.store.upload(sameRev.integrity.digest, sameRev);
  const staleManifest = await sealDocument({ ...payload, partitions: [{ id: sameRev.id, digest: sameRev.integrity.digest, revision: 0, writeId: null }] });
  const staleHead = await sealDocument({ ...headPayload, manifestDigest: staleManifest.integrity.digest });
  await assert.rejects(f.store.publish({ expectedHead: first.head, manifest: staleManifest, head: staleHead }), status(409, 'nutrition-stale-partition'));
  assert.equal((await f.store.head()).head.commitId, 'first');
});
test('Nutrition rejects cross-user/generation/origin documents and never accepts client-supplied paths', async t => {
  const f = await fixture(t), other = await part(0, { namespace: { ...scope.namespace, profileId: 'bob' } });
  await assert.rejects(f.store.upload(other.integrity.digest, other), error => error.issues?.some(i => i.code === 'namespace_mismatch'));
  for (const over of [{ generation: 'different' }, { namespace: { ...scope.namespace, serverOrigin: null } }]) {
    const value = await part(0, over);
    await assert.rejects(f.store.upload(value.integrity.digest, value));
  }
  for (const hash of ['../head', 'A'.repeat(64), '0'.repeat(63), '0'.repeat(64) + '/head']) await assert.rejects(f.store.upload(hash, await part()));
  assert.equal(fs.existsSync(f.dir), false);
});
test('Nutrition scopes accounts and restore generations independently', async t => {
  const f = await fixture(t); await publish(f.store, await plan('first', [await part()]));
  for (const actualScope of [{ ...scope, namespace: { ...scope.namespace, profileId: 'bob' } }, { ...scope, generation: 'generation-2' }]) {
    prepareOwner(f.dataDir, actualScope.namespace.profileId);
    const other = await createNutritionServerStore({ ...f.options, scope: actualScope });
    assert.equal((await other.head()).status, 'uninitialized');
    await assert.rejects(other.manifest((await f.store.head()).manifest.integrity.digest), status(404));
  }
});
test('Nutrition preserves history and tombstones and prohibits recycling retired shard ids', async t => {
  const f = await fixture(t), first = await plan('first', [await part()]); await publish(f.store, first);
  const missing = await plan('drop', [], first.manifest, { removePartitionIds: [first.writes[0].id] });
  await assert.rejects(f.store.publish(request(missing)), error => error.issues?.some(i => i.code === 'untracked_record_removal'));
  const deleted = await part(1, { records: { foodEntries: [] }, sync: { revision: 1, writeId: 'delete', edits: [],
    tombstones: [{ collection: 'foodEntries', id: 'entry-a', stamp: { counter: 1, deviceId: 'device-a' } }] } });
  const second = await plan('delete', [deleted], first.manifest); await publish(f.store, second);
  const moved = await part(0, { id: 'journal-2026-11-device-a-0', records: { foodEntries: [] }, sync: { ...deleted.sync, revision: 0, writeId: null } });
  const third = await plan('move', [moved], second.manifest, { removePartitionIds: [deleted.id] }); await publish(f.store, third);
  const recycled = await part(2, { records: { foodEntries: [] } });
  await assert.rejects(publish(f.store, await plan('recycle', [recycled], third.manifest)), status(409, 'nutrition-retired-partition'));
  assert.deepEqual(await f.store.partition(first.writes[0].integrity.digest, first.manifest.integrity.digest), first.writes[0]);
});
test('Nutrition retains exact pending versions even when they are no longer current', async t => {
  const f = await fixture(t), a = await part();
  const pendingOperations = [{ id: 'pending-a', stamp: { counter: 1, deviceId: 'device-a' },
    partitions: [{ id: a.id, digest: a.integrity.digest, revision: 0, writeId: null }], removedPartitionIds: [] }];
  const first = await plan('first', [a], null, { pendingOperations }); await publish(f.store, first);
  const second = await plan('second', [await part(1)], first.manifest); await publish(f.store, second);
  assert.deepEqual(await f.store.partition(a.integrity.digest, second.manifest.integrity.digest), a);
  assert.deepEqual((await f.store.head()).manifest.pendingOperations, pendingOperations);
  fs.unlinkSync(path.join(f.dir, `p-${a.integrity.digest}.json`));
  await assert.rejects(f.store.publish(request(await plan('third', [await part(2)], second.manifest))), status(503));
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'head.json'))).commitId, 'second');
});
test('Nutrition refuses corrupt staged references, orphan manifests and global duplicate records', async t => {
  const f = await fixture(t), a = await part(), prepared = await plan('missing', [a]);
  await assert.rejects(f.store.publish(request(prepared)), error => error.issues?.some(i => i.code === 'missing_partition'));
  const b = await part(0, { id: 'journal-2026-11-device-a-0' });
  await f.store.upload(a.integrity.digest, a); await f.store.upload(b.integrity.digest, b);
  await assert.rejects(f.store.publish(request(await plan('duplicate', [a, b]))), error => error.issues?.some(i => i.code === 'duplicate_dataset_id'));
  fs.writeFileSync(path.join(f.dir, `p-${a.integrity.digest}.json`), '{broken');
  await assert.rejects(f.store.publish(request(prepared)));
  assert.equal((await f.store.head()).status, 'uninitialized');
});
test('Nutrition validates snapshot references and nutrients even when the portable checksum is correctly resealed', async t => {
  const f = await fixture(t), original = await part();
  const { integrity, ...missing } = JSON.parse(JSON.stringify(original));
  missing.records.foodEntries[0].snapshotRef = '0'.repeat(64);
  const badReference = await sealDocument(missing);
  await assert.rejects(f.store.upload(badReference.integrity.digest, badReference),
    error => error.issues?.some(issue => issue.code === 'missing_snapshot'));
  const { integrity: ignored, ...bad } = JSON.parse(JSON.stringify(original));
  const snapshot = Object.values(bad.snapshots)[0]; snapshot.nutrients.protein = -1;
  // Reseal the snapshot key too: the domain rules must reject it independently of SHA checks.
  const hash = await contentHash(snapshot); bad.snapshots = { [hash]: snapshot };
  bad.records.foodEntries[0].snapshotRef = hash;
  const badNutrients = await sealDocument(bad);
  await assert.rejects(f.store.upload(badNutrients.integrity.digest, badNutrients), error => !!error.issues?.length);
  assert.equal((await f.store.head()).status, 'uninitialized');
});
test('Nutrition reports fallback read-only without publishing over a damaged current graph', async t => {
  const f = await fixture(t), first = await plan('first', [await part()]); await publish(f.store, first);
  const second = await plan('second', [await part(1)], first.manifest); await publish(f.store, second);
  fs.writeFileSync(path.join(f.dir, 'head.json'), '{bad');
  const state = await f.store.head(); assert.equal(state.status, 'recovery-required'); assert.equal(state.head.commitId, 'second');
  assert.equal(Object.hasOwn(state, 'domains'), false);
  await assert.rejects(f.store.publish(request(await plan('third', [], first.manifest))), status(503, 'nutrition-recovery-required'));
  assert.equal(fs.readFileSync(path.join(f.dir, 'head.json'), 'utf8'), '{bad');
});
test('Nutrition refuses future formats and missing publication roots with confirmed evidence', async t => {
  const f = await fixture(t), first = await plan('first', [await part()]); await publish(f.store, first);
  const { integrity: ignored, ...payload } = first.head;
  fs.writeFileSync(path.join(f.dir, 'head.json'), boundedJson(await sealDocument({ ...payload, storageVersion: 2 })));
  await assert.rejects(f.store.head(), status(503, 'nutrition-format-unsupported'));
  fs.unlinkSync(path.join(f.dir, 'head.json'));
  assert.equal((await f.store.head()).status, 'recovery-required');
  await assert.rejects(f.store.publish(request(first)), status(503, 'nutrition-recovery-required'));
});
test('Nutrition detects a partially restored older head rather than silently rolling back an acknowledged publication', async t => {
  const f = await fixture(t), first = await plan('first', [await part()]); await publish(f.store, first);
  const second = await plan('second', [await part(1)], first.manifest); await publish(f.store, second);
  fs.writeFileSync(path.join(f.dir, 'head.json'), boundedJson(first.head));
  const state = await f.store.head();
  assert.equal(state.status, 'recovery-required'); assert.equal(state.head.commitId, 'second');
  await assert.rejects(f.store.publish(request(first)), status(503, 'nutrition-recovery-required'));
  assert.deepEqual(await f.store.partition(first.writes[0].integrity.digest, first.manifest.integrity.digest), first.writes[0]);
});
test('Nutrition never acknowledges an orphan receipt or a corrupt confirmation marker', async t => {
  const f = await fixture(t), first = await plan('first', [await part()]); await publish(f.store, first);
  const record = path.join(f.dir, `c-${await contentHash('first')}.json`), original = fs.readFileSync(record);
  fs.unlinkSync(record);
  await assert.rejects(f.store.publish(request(first)), status(503, 'nutrition-receipt-conflict'));
  fs.writeFileSync(record, original);
  fs.writeFileSync(path.join(f.dir, 'confirmed.json'), '{broken');
  await assert.rejects(f.store.publish(request(first)), status(503, 'nutrition-storage-corrupt'));
});
test('Nutrition retains published pending versions even after a later manifest explicitly removes its queue entries', async t => {
  const f = await fixture(t), a = await part();
  const pendingOperations = [{ id: 'pending-a', stamp: { counter: 1, deviceId: 'device-a' },
    partitions: [{ id: a.id, digest: a.integrity.digest, revision: 0, writeId: null }], removedPartitionIds: [] }];
  const first = await plan('first', [a], null, { pendingOperations }); await publish(f.store, first);
  const second = await plan('second', [await part(1)], first.manifest, { pendingOperations: [] }); await publish(f.store, second);
  assert.deepEqual((await f.store.head()).manifest.pendingOperations, []);
  assert.deepEqual(await f.store.manifest(first.manifest.integrity.digest), first.manifest);
  assert.deepEqual(await f.store.partition(a.integrity.digest, first.manifest.integrity.digest), a);
});
test('Nutrition quota and authorization failures never change a published head or erase versions', async t => {
  const f = await fixture(t), first = await plan('first', [await part()]); await publish(f.store, first);
  const before = fs.readFileSync(path.join(f.dir, 'head.json'), 'utf8');
  const limited = await createNutritionServerStore({ ...f.options, limits: { ...f.options.limits, maxBytes: 1 } });
  await assert.rejects(limited.upload((await part(1)).integrity.digest, await part(1)), status(507, 'nutrition-capacity'));
  const denied = await createNutritionServerStore({ ...f.options, authorize: () => { throw Object.assign(new Error('denied'), { status: 401 }); } });
  await assert.rejects(denied.upload((await part(1)).integrity.digest, await part(1)), error => error.status === 401);
  assert.equal(fs.readFileSync(path.join(f.dir, 'head.json'), 'utf8'), before);
  assert.deepEqual(await f.store.partition(first.writes[0].integrity.digest, first.manifest.integrity.digest), first.writes[0]);
});
test('Nutrition refuses filesystem symlinks and immutable-content mismatches', async t => {
  const f = await fixture(t), a = await part(); await f.store.upload(a.integrity.digest, a);
  fs.writeFileSync(path.join(f.dir, `p-${a.integrity.digest}.json`), '{}');
  await assert.rejects(f.store.upload(a.integrity.digest, a), status(503, 'nutrition-immutable-conflict'));
  fs.unlinkSync(path.join(f.dir, `p-${a.integrity.digest}.json`));
  fs.symlinkSync(path.join(f.dataDir, 'db.json'), path.join(f.dir, `p-${a.integrity.digest}.json`));
  await assert.rejects(f.store.upload(a.integrity.digest, a));
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dataDir, 'db.json'))).users.length, 2);
});

for (const phase of ['manifest:file-sync', 'manifest:close', 'manifest:rename', 'manifest:dir-sync',
  'request:dir-sync', 'previous:file-sync', 'previous:rename', 'previous:dir-sync',
  'head:file-sync', 'head:close', 'head:rename', 'head:dir-sync', 'receipt:file-sync', 'receipt:rename', 'receipt:dir-sync',
  'confirmed:file-sync', 'confirmed:rename', 'confirmed:dir-sync']) {
  test(`Nutrition safely retries publication after interruption at ${phase}`, async t => {
    const f = await fixture(t), first = await plan('first', [await part()]); await publish(f.store, first);
    const second = await plan('second', [await part(1)], first.manifest);
    await f.store.upload(second.writes[0].integrity.digest, second.writes[0]);
    f.setFault(point => { if (point === phase) throw new Error('interruption'); });
    await assert.rejects(f.store.publish(request(second)));
    const stored = JSON.parse(fs.readFileSync(path.join(f.dir, 'head.json')));
    assert.ok(['first', 'second'].includes(stored.commitId));
    f.setFault(() => {});
    const next = await f.reopen(), response = await next.publish(request(second));
    assert.equal(response.head.commitId, 'second');
    assert.deepEqual(await next.partition(first.writes[0].integrity.digest, first.manifest.integrity.digest), first.writes[0]);
    assert.equal((await next.head()).head.commitId, 'second');
  });
}
