import fs from 'node:fs';
import path from 'node:path';
import { NutritionValidationError } from './core/contracts.js';
import { boundedJson, canonicalJson, check, contentHash, exactKeys, jsonClone, readDocument,
  sealDocument, sameNamespace, verifiedDocument, isCounter } from './core/persistence-contract.js';
import { readHead, readManifest, createDatasetValidator } from './core/persistence-commit.js';
import { decodePartition } from './core/serialization.js';
import { preserveHistory } from './core/history.js';
import { validateBackupMetadata } from './core/backup-history.js';
import { capacity, privateDirectory, privateFiles, userDirectory } from './files.js';
import { NutritionHttpError, RECEIPT_FORMAT, REQUEST_FORMAT, digest, validateServerScope } from './protocol.js';

const unsupported = error => error?.issues?.some(i => ['unsupported_storage_version', 'unsupported_domain_version',
  'unsupported_version', 'committed_migration_required'].includes(i.code));
const corrupt = error => error instanceof NutritionValidationError ?
  new NutritionHttpError(503, unsupported(error) ? 'nutrition-format-unsupported' : 'nutrition-storage-corrupt', { issues: error.issues.slice(0, 32) }) : error;
const same = (a, b) => canonicalJson(a) === canonicalJson(b);
const refOf = part => ({ id: part.id, digest: part.integrity.digest, revision: part.sync.revision, writeId: part.sync.writeId });

// INTERNAL: the worker must hold the account-wide flock for the entire call, including every
// await. Other code must use the executor, never call this factory as an unlocked HTTP store.
export async function createNutritionServerStore({ dataDir, scope: input, limits, authorize, fault }) {
  const scope = jsonClone(input); validateServerScope(scope);
  const owner = userDirectory(dataDir, scope.namespace.profileId), dir = path.join(owner, await contentHash(scope));
  const io = privateFiles({ fault });
  const file = name => path.join(dir, name + '.json');
  const scopeOf = value => {
    check(sameNamespace(value.namespace, scope.namespace), 'namespace', 'namespace_mismatch');
    check(value.generation === scope.generation, 'generation', 'generation_mismatch');
  };
  const checkScopeDirectory = () => {
    try { if (!fs.lstatSync(dir).isDirectory()) throw new NutritionHttpError(503, 'nutrition-unsafe-path'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  };
  checkScopeDirectory();
  const room = (texts, count) => {
    const usage = capacity(owner, limits, texts.reduce((n, text) => n + Buffer.byteLength(text), 0), count);
    if (!fs.existsSync(dir)) {
      if (usage.generations >= limits.maxGenerations) throw new NutritionHttpError(507, 'nutrition-generation-limit');
      privateDirectory(dir);
    }
  };
  const immutable = (name, text, phase) => {
    const existing = io.read(file(name));
    if (existing !== null) {
      if (existing !== text) throw new NutritionHttpError(503, 'nutrition-immutable-conflict');
      io.force(file(name)); // A previous response may have failed before its directory flush.
      return false;
    }
    io.write(file(name), text, phase); return true;
  };
  const partition = async (raw, ref = null) => {
    const part = readDocument(raw);
    check(part.storageVersion === 1, 'storageVersion', part.storageVersion === 0 ? 'committed_migration_required' : 'unsupported_storage_version');
    const domain = await decodePartition(part); scopeOf(part);
    await validateBackupMetadata(domain.extensions);
    if (ref) check(same(refOf(part), ref), 'partitions', 'partition_reference_mismatch');
    return { part, domain };
  };
  const manifestFor = async head => {
    scopeOf(head);
    const raw = io.read(file('m-' + head.manifestDigest)); check(raw !== null, 'manifest', 'missing_manifest');
    const manifest = await readManifest(raw); scopeOf(manifest);
    check(manifest.integrity.digest === head.manifestDigest && manifest.commitId === head.commitId, 'manifest', 'head_manifest_mismatch');
    return manifest;
  };
  const graph = async manifest => {
    const validator = createDatasetValidator(), domains = [], loaded = new Map();
    const load = async ref => {
      if (loaded.has(ref.digest)) {
        check(same(loaded.get(ref.digest), ref), 'partitions', 'partition_reference_mismatch'); return null;
      }
      const raw = io.read(file('p-' + ref.digest)); check(raw !== null, 'partitions', 'missing_partition');
      const value = await partition(raw, ref); loaded.set(ref.digest, refOf(value.part)); return value.domain;
    };
    for (const ref of manifest.partitions) {
      const domain = await load(ref); check(domain !== null, 'partitions', 'duplicate_partition_id');
      validator.add(domain);
      // Keep identities, sync markers and history-content digests needed by preserveHistory. Fully validate
      // one partition at a time; historical snapshots must not all remain resident in a worker.
      const extensions = {};
      for (const name of ['nutritionSyncConflicts', 'nutritionBackupRestores', 'nutritionBackupRestorePreparations', 'nutritionBackupTombstones']) {
        if (!Object.hasOwn(domain.extensions ?? {}, name)) continue;
        const records = Object.create(null);
        for (const [hash, value] of Object.entries(domain.extensions[name]?.records ?? {})) records[hash] = await contentHash(value);
        extensions[name] = { records };
      }
      domains.push({ extensions, records: Object.fromEntries(Object.entries(domain.records).map(([collection, rows]) =>
        [collection, collection === 'nutritionSettings' ? {} : rows.map(row => ({ id: row.id }))])),
      sync: { tombstones: domain.sync.tombstones, edits: domain.sync.edits } });
    }
    validator.finish();
    for (const op of manifest.pendingOperations) for (const ref of op.partitions) await load(ref);
    return domains;
  };
  const confirmedEvidence = () => {
    if (io.read(file('previous')) !== null) return true;
    try { return fs.readdirSync(dir).some(name => /^r-[a-f0-9]{64}\.json$/.test(name)); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  };
  const confirmed = async () => {
    const raw = io.read(file('confirmed')); if (raw === null) return null;
    try {
      const value = await verifiedDocument(raw, 'opengym-nutrition-confirmed-head');
      exactKeys(value, ['format', 'storageVersion', 'domainVersion', 'namespace', 'generation', 'head', 'sequence', 'integrity'], '$');
      scopeOf(value); check(value.domainVersion === 1 && isCounter(value.sequence), 'confirmed', 'invalid_confirmed_head');
      scopeOf(await readHead(value.head)); return value;
    } catch (error) { throw corrupt(error); }
  };
  const current = async (complete = false) => {
    const raw = io.read(file('head')), previous = io.read(file('previous'));
    const anchor = await confirmed();
    if (raw === null && previous === null && anchor === null) {
      if (confirmedEvidence()) throw new NutritionHttpError(503, 'nutrition-recovery-required');
      return { status: 'uninitialized', head: null, manifest: null, domains: [], issues: [] };
    }
    const issues = [];
    const candidates = [raw, anchor ? boundedJson(anchor.head) : null, previous];
    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index];
      if (candidate === null) continue;
      try {
        const head = await readHead(candidate), manifest = await manifestFor(head);
        const degraded = index !== 0;
        if (anchor && index === 0) {
          check(same(head, anchor.head) ? manifest.sequence === anchor.sequence :
            manifest.sequence === anchor.sequence + 1 && manifest.parentCommitId === anchor.head.commitId,
          'head', 'confirmed_anchor_mismatch');
        }
        if (anchor && index === 1) check(manifest.sequence === anchor.sequence, 'confirmed', 'invalid_confirmed_head');
        // A fallback is never accepted on header checks alone.
        const domains = complete || degraded ? await graph(manifest) : [];
        return { status: degraded ? 'recovery-required' : complete ? 'current' : 'partially-verified', head, manifest, domains, issues };
      } catch (error) {
        if (!(error instanceof NutritionValidationError) || unsupported(error)) throw corrupt(error);
        issues.push(...error.issues.slice(0, 32 - issues.length));
      }
    }
    throw new NutritionHttpError(503, 'nutrition-recovery-required', { issues: issues.slice(0, 32) });
  };
  const recordName = async (prefix, id) => prefix + '-' + await contentHash(id);
  const readRecord = async (prefix, id) => {
    const raw = io.read(file(await recordName(prefix, id)));
    if (raw === null) return null;
    try {
      const record = await verifiedDocument(raw, prefix === 'r' ? RECEIPT_FORMAT : REQUEST_FORMAT);
      exactKeys(record, ['format', 'storageVersion', 'domainVersion', 'namespace', 'generation', 'commitId',
        'requestDigest', 'head', ...(prefix === 'c' ? ['expectedHead'] : []), 'integrity'], '$');
      scopeOf(record); check(record.domainVersion === 1, 'domainVersion', 'unsupported_domain_version');
      check(record.commitId === id, 'commitId', 'receipt_commit_mismatch'); digest(record.requestDigest);
      const head = await readHead(record.head); scopeOf(head); check(head.commitId === id, 'head', 'receipt_commit_mismatch');
      if (prefix === 'c' && record.expectedHead !== null) scopeOf(await readHead(record.expectedHead));
      return record;
    } catch (error) { throw corrupt(error); }
  };
  const receiptFor = async record => sealDocument({ format: RECEIPT_FORMAT, storageVersion: 1, domainVersion: 1,
    ...scope, commitId: record.commitId, requestDigest: record.requestDigest, head: record.head });
  const confirm = async state => {
    const text = boundedJson(await sealDocument({ format: 'opengym-nutrition-confirmed-head', storageVersion: 1,
      domainVersion: 1, ...scope, head: state.head, sequence: state.manifest.sequence }));
    if (io.read(file('confirmed')) === text) { io.force(file('confirmed')); return; }
    room([text], 1); authorize(); io.write(file('confirmed'), text, 'confirmed');
  };
  const ensureReceipt = async state => {
    if (!state.head) return;
    const existing = await readRecord('r', state.head.commitId), record = await readRecord('c', state.head.commitId);
    if (!record || !same(record.head, state.head)) throw new NutritionHttpError(503, 'nutrition-recovery-required');
    const receipt = await receiptFor(record);
    if (existing) {
      if (!same(existing, receipt)) throw new NutritionHttpError(503, 'nutrition-receipt-conflict');
      io.force(file(await recordName('r', state.head.commitId)));
      await confirm(state);
      return;
    }
    const text = boundedJson(receipt); room([text], 1); authorize();
    immutable(await recordName('r', state.head.commitId), text, 'receipt-repair');
    await confirm(state);
  };
  const publishedManifest = async hash => {
    digest(hash);
    const raw = io.read(file('m-' + hash));
    if (raw === null) throw new NutritionHttpError(404, 'nutrition-missing');
    try {
      const manifest = await readManifest(raw); scopeOf(manifest);
      check(manifest.integrity.digest === hash, 'manifest', 'checksum_mismatch');
      const state = await current();
      if (state.head?.manifestDigest !== hash) {
        const receipt = await readRecord('r', manifest.commitId);
        if (!receipt || receipt.head.manifestDigest !== hash) throw new NutritionHttpError(404, 'nutrition-missing');
      }
      return manifest;
    } catch (error) { throw corrupt(error); }
  };
  return {
    async head() {
      const { domains, ...state } = await current();
      return { ...state, namespace: scope.namespace, generation: scope.generation };
    },
    manifest: publishedManifest,
    async partition(hash, manifestHash) {
      digest(hash);
      const manifest = await publishedManifest(manifestHash);
      const ref = [...manifest.partitions, ...manifest.pendingOperations.flatMap(op => op.partitions)].find(ref => ref.digest === hash);
      if (!ref) throw new NutritionHttpError(404, 'nutrition-missing');
      try {
        const raw = io.read(file('p-' + hash)); check(raw !== null, 'partitions', 'missing_partition');
        return (await partition(raw, ref)).part;
      } catch (error) { throw corrupt(error); }
    },
    async upload(hash, input) {
      digest(hash);
      const value = await partition(input); check(value.part.integrity.digest === hash, 'digest', 'partition_digest_mismatch');
      const text = boundedJson(value.part), existing = io.read(file('p-' + hash));
      if (existing !== null) {
        if (existing !== text) throw new NutritionHttpError(503, 'nutrition-immutable-conflict');
        authorize(); io.force(file('p-' + hash));
        return { digest: hash, staged: true, repeated: true };
      }
      room([text], 1); authorize(); immutable('p-' + hash, text, 'partition');
      return { digest: hash, staged: true, repeated: false };
    },
    async publish(input) {
      const request = jsonClone(input); exactKeys(request, ['expectedHead', 'manifest', 'head'], '$');
      const head = await readHead(request.head), manifest = await readManifest(request.manifest);
      scopeOf(head); scopeOf(manifest);
      const expected = request.expectedHead === null ? null : await readHead(request.expectedHead);
      if (expected) scopeOf(expected);
      check(head.commitId === manifest.commitId && head.manifestDigest === manifest.integrity.digest, 'head', 'head_manifest_mismatch');
      check(Buffer.byteLength(head.commitId) <= 256, 'commitId', 'identifier_too_long');
      const requestDigest = await contentHash(request);
      const state = await current(true);
      if (state.status === 'recovery-required') throw new NutritionHttpError(503, 'nutrition-recovery-required');
      const receipt = await readRecord('r', head.commitId), reserved = await readRecord('c', head.commitId);
      if ((receipt && receipt.requestDigest !== requestDigest) || (reserved && reserved.requestDigest !== requestDigest)) {
        throw new NutritionHttpError(409, 'nutrition-commit-id-conflict');
      }
      if (receipt) {
        if (!reserved || !same(receipt.head, head) || !same(reserved.head, head)) throw new NutritionHttpError(503, 'nutrition-receipt-conflict');
        try {
          const old = await manifestFor(receipt.head);
          if (!state.manifest || old.sequence > state.manifest.sequence || (old.sequence === state.manifest.sequence && !same(state.head, head))) {
            throw new NutritionHttpError(503, 'nutrition-recovery-required');
          }
          await graph(old);
        } catch (error) { throw corrupt(error); }
        await ensureReceipt(state);
        authorize(); io.force(file(await recordName('c', head.commitId))); io.force(file(await recordName('r', head.commitId)));
        return { head: receipt.head, receipt, repeated: true };
      }
      if (same(state.head, head)) {
        await ensureReceipt(state);
        return { head, receipt: await readRecord('r', head.commitId), repeated: true };
      }
      if (!same(expected, state.head)) throw new NutritionHttpError(409, 'nutrition-stale-head', { head: state.head });
      check(manifest.sequence === (state.manifest ? state.manifest.sequence + 1 : 0), 'sequence', 'nonadvancing_sequence');
      check(manifest.parentCommitId === (state.head?.commitId ?? null), 'parentCommitId', 'unexpected_parent');
      const before = new Map((state.manifest?.partitions ?? []).map(ref => [ref.id, ref]));
      for (const ref of manifest.partitions) {
        const old = before.get(ref.id);
        if (old && !same(old, ref)) {
          if (ref.revision <= old.revision || ref.writeId === old.writeId) throw new NutritionHttpError(409, 'nutrition-stale-partition', { id: ref.id });
        }
      }
      // No TTL or implicit acknowledgment. Retired ids cannot be recycled: inspect retained
      // receipts/manifests, independent of counters rolled back by a restored older head.
      const added = manifest.partitions.filter(ref => !before.has(ref.id));
      if (added.length && state.head) {
        const retired = new Set();
        for (const name of fs.readdirSync(dir).filter(name => /^r-[a-f0-9]{64}\.json$/.test(name))) {
          try {
            const id = readDocument(io.read(path.join(dir, name))).commitId;
            const oldReceipt = await readRecord('r', id);
            check(await recordName('r', id) + '.json' === name, 'receipt', 'receipt_commit_mismatch');
            const oldManifest = await manifestFor(oldReceipt.head);
            for (const ref of oldManifest.partitions) retired.add(ref.id);
          } catch (error) { throw corrupt(error); }
        }
        for (const ref of added) if (retired.has(ref.id)) throw new NutritionHttpError(409, 'nutrition-retired-partition');
      }
      const domains = await graph(manifest); preserveHistory(state.domains, domains);
      await ensureReceipt(state); // Complete a prior post-head interruption before moving on.
      const record = await sealDocument({ format: REQUEST_FORMAT, storageVersion: 1, domainVersion: 1,
        ...scope, commitId: head.commitId, requestDigest, expectedHead: expected, head });
      const newReceipt = await receiptFor(record);
      const confirmation = await sealDocument({ format: 'opengym-nutrition-confirmed-head', storageVersion: 1,
        domainVersion: 1, ...scope, head, sequence: manifest.sequence });
      const texts = [boundedJson(manifest), boundedJson(record), boundedJson(head), boundedJson(newReceipt),
        boundedJson(confirmation), ...(state.head ? [boundedJson(state.head)] : [])];
      room(texts, texts.length); authorize();
      immutable('m-' + manifest.integrity.digest, texts[0], 'manifest');
      immutable(await recordName('c', head.commitId), texts[1], 'request');
      if (state.head) io.write(file('previous'), boundedJson(state.head), 'previous');
      authorize(); // Recheck expiry/revocation immediately before the commit point.
      io.write(file('head'), boundedJson(head), 'head');
      immutable(await recordName('r', head.commitId), boundedJson(newReceipt), 'receipt');
      await confirm({ head, manifest });
      return { head, receipt: newReceipt, repeated: false };
    },
  };
}
