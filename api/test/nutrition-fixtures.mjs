import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodePartition } from '../nutrition/core/serialization.js';
import { prepareCommit } from '../nutrition/core/persistence-commit.js';
import { contentHash } from '../nutrition/core/persistence-contract.js';
import { prepareOwner } from '../nutrition/files.js';
import { DEFAULT_LIMITS } from '../nutrition/executor.js';
import { createNutritionServerStore } from '../nutrition/store.js';

export const origin = 'https://gym.example.com';
export const scope = { namespace: { serverOrigin: origin, profileId: 'alice' }, generation: 'generation-1' };
export const food = () => ({ schemaVersion: 1, kind: 'food', id: 'oats', name: 'Oats', reference: { amount: 100, unit: 'g' },
  nutrients: { kcal: 380, protein: 13, carbs: 60, fat: 7 }, portions: [], source: { kind: 'custom' } });
export const entry = (over = {}) => ({ schemaVersion: 1, id: 'entry-a', d: '2026-10-10', meal: 'breakfast',
  snapshot: food(), quantity: { amount: 50, unit: 'g' }, ...over });
export const domain = (revision = 0, over = {}) => ({ id: 'journal-2026-10-device-a-0', kind: 'journal', ...scope,
  records: { foodEntries: [entry()] }, sync: { revision, writeId: revision ? `write-${revision}` : null, edits: [], tombstones: [] }, ...over });
export const part = (revision = 0, over = {}) => encodePartition(domain(revision, over));
export const plan = (commitId, partitions, baseManifest = null, over = {}) => prepareCommit({ ...scope, commitId, baseManifest, partitions, ...over });
export const request = ({ expectedHead, manifest, head }) => ({ expectedHead, manifest, head });
export const status = (code, issue) => error => error.status === code && (!issue || error.code === issue);
export async function fixture(t, over = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-nutrition-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ users: [{ id: 'alice', name: 'Alice' }, { id: 'bob', name: 'Bob' }] }));
  const actualScope = over.scope || scope;
  const { owner } = prepareOwner(dataDir, actualScope.namespace.profileId);
  const dir = path.join(owner, await contentHash(actualScope));
  let fault = () => {};
  const options = { dataDir, scope: actualScope, limits: { ...DEFAULT_LIMITS, reserveBytes: 0 }, authorize: () => {}, ...over,
    fault: phase => fault(phase) };
  return { dataDir, owner, dir, options, store: await createNutritionServerStore(options),
    setFault(fn) { fault = fn; }, reopen: () => createNutritionServerStore(options) };
}
export async function publish(store, prepared) {
  for (const value of prepared.writes) await store.upload(value.integrity.digest, value);
  return store.publish(request(prepared));
}
