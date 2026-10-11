import assert from 'node:assert/strict'
import { test } from 'vitest'
import { readZip, zipStore } from '../zip.js'
import { exportBackupZip } from '../backup-media.js'
import { exportNutritionBackup, readNutritionBackup } from './backup.js'
import { BACKUP_MANIFEST, MAX_BACKUP_BYTES, parseBackupJson, safeBackupValue } from './backup-contract.js'
import { canonicalJson, sealDocument } from './persistence-contract.js'
import { backupFixture } from './backup.test-util.js'
import { library, journal, hasCode, reseal } from './persistence.test-util.js'
async function changeArchive(blob, change) {
  const entries = await readZip(blob), entry = entries.find(e => e.name === BACKUP_MANIFEST)
  let manifest = JSON.parse(await entry.blob.text()); await change(manifest, entries)
  const payload = { ...manifest }; delete payload.integrity
  manifest = await sealDocument(payload); entry.blob = new Blob([canonicalJson(manifest)])
  return zipStore(entries)
}
for (const kind of ['idb', 'fs']) test(`round trip all Nutrition collections/snapshots (${kind})`, async () => {
  const f = await backupFixture(kind); await f.commit(journal()); await f.commit(library(), 'library')
  const out = await f.service().export(), read = await readNutritionBackup(out.blob)
  assert.deepEqual(read.current.find(p => p.kind === 'library').records, library().records)
  assert.deepEqual(read.current.find(p => p.kind === 'journal').records, journal().records)
  assert.equal(read.digest, out.digest); assert.equal(out.manifest.sections.nutrition.counts.recipes, 1)
  assert.equal(read.current[0].namespace.profileId, 'backup'); assert.equal(JSON.stringify(out.manifest).includes('local-profile'), false)
})
test('empty Nutrition archive is valid and deterministic', async () => {
  const f = await backupFixture(), a = await f.service().export(), b = await f.service().export()
  assert.equal(a.digest, b.digest); assert.deepEqual(new Uint8Array(await a.blob.arrayBuffer()), new Uint8Array(await b.blob.arrayBuffer()))
  assert.deepEqual((await readNutritionBackup(a.blob)).current, [])
})
test('global data archive preserves workouts, omits auth/active/cache', async () => {
  const f = await backupFixture(), state = { workouts: [{ id: 'w1', note: '<script>alert(1)</script>' }], routines: [], unit: 'lb', active: { token: 'secret' }, token: 'secret', _wid: 'device-write' }
  const out = await exportNutritionBackup({ store: f.store, getWorkouts: () => state, getWorkoutRevision: () => ({ namespace: f.store.scope.namespace, revision: 'fixture-version' }) }), read = await readNutritionBackup(out.blob)
  assert.deepEqual(read.workouts, { workouts: state.workouts, routines: [], unit: 'lb' })
  assert.equal((await readZip(out.blob)).some(e => e.name === 'opengym-backup.json'), false)
})
test('legacy JSON and existing workout media ZIP stay recognized', async () => {
  const state = { workouts: [], routines: [], oldSetting: true }, json = await readNutritionBackup(new Blob([JSON.stringify(state)]))
  assert.equal(json.legacy, true); assert.deepEqual(json.workouts, state)
  const zip = await exportBackupZip(state, { media: { get: async () => null } }); assert.equal((await readNutritionBackup(zip.blob)).legacy, true)
})
for (const [name, input, code] of [
  ['malformed JSON', '{', 'invalid_json'], ['empty file', '', 'invalid_json'], ['future JSON format', '{"format":"future"}', 'unsupported_backup_format'],
  ['prototype pollution', '{"workouts":[],"routines":[],"__proto__":{"polluted":true}}', 'backup_unsafe_key'],
  ['deep input', '['.repeat(65) + '0' + ']'.repeat(65), 'backup_complexity_limit'],
]) test(name, async () => { await assert.rejects(readNutritionBackup(new Blob([input])), hasCode(code)); assert.equal({}.polluted, undefined) })
for (const [name, build, code] of [
  ['cycle', () => { const a = {}; a.a = a; return a }, 'backup_repeated_reference'],
  ['prototype values', () => Object.create({ a: 1 }), 'backup_plain_object_required'],
  ['getter', () => Object.defineProperty({}, 'secret', { get() { throw Error('executed') }, enumerable: true }), 'backup_data_property_required'],
  ['NaN', () => ({ x: NaN }), 'json_nonfinite_number'], ['Infinity', () => ({ x: Infinity }), 'json_nonfinite_number'], ['bigint', () => ({ x: 1n }), 'json_unsupported_value'],
]) test(`reject ${name} before serialization`, () => assert.throws(() => safeBackupValue(build()), hasCode(code)))
test('quoted braces do not trigger nesting gate', () => assert.equal(parseBackupJson('{"text":"' + '{'.repeat(100) + '"}').text.length, 100))
test('size bound applies before reading', async () => assert.rejects(readNutritionBackup({ size: MAX_BACKUP_BYTES + 1024 * 1024 + 1, text() { throw Error('read') } }), hasCode('backup_too_large')))
for (const [name, mutate, code] of [
  ['future envelope version', m => { m.schemaVersion = 2 }, 'unsupported_backup_version'], ['unknown storage version', m => { m.storageVersion = 9 }, 'unsupported_storage_version'],
  ['missing section', m => { delete m.sections.workouts }, 'required_field'], ['unknown field', m => { m.untrusted = true }, 'unexpected_field'],
  ['negative counts', m => { m.sections.nutrition.counts.foodEntries = -1 }, 'invalid_backup_count'], ['incorrect counts', m => { m.sections.nutrition.counts.foodEntries++ }, 'backup_count_mismatch'],
  ['wrong announced size', m => { m.documents[0].bytes++ }, 'backup_size_mismatch'], ['missing document', m => { m.documents.pop() }, 'missing_backup_document'],
  ['duplicate descriptor', m => { m.documents.push(m.documents[0]) }, 'invalid_backup_document'], ['incomplete history', m => { m.sections.nutrition.current = [] }, 'invalid_backup_document'],
  ['duplicate partition reference', m => { m.sections.nutrition.current.push(m.sections.nutrition.current[0]) }, 'invalid_backup_references'],
]) test(`reject correctly sealed ${name}`, async () => {
  const f = await backupFixture(); await f.commit(); const out = await f.service().export()
  await assert.rejects(readNutritionBackup(await changeArchive(out.blob, mutate)), hasCode(code))
})
test('missing snapshots cannot bypass business validators by resealing', async () => {
  const f = await backupFixture(); await f.commit(); const out = await f.service().export()
  const bad = await changeArchive(out.blob, async (m, entries) => {
    const doc = m.documents[0], e = entries.find(e => e.name.endsWith(`${doc.digest}.json`)), part = JSON.parse(await e.blob.text())
    part.records.foodEntries[0].snapshotRef = 'f'.repeat(64)
    const sealed = reseal(part), text = canonicalJson(sealed), old = doc.digest
    doc.digest = sealed.integrity.digest; doc.bytes = new TextEncoder().encode(text).length; m.sections.nutrition.current = [doc.digest]
    e.name = e.name.replace(old, doc.digest); e.blob = new Blob([text])
  })
  await assert.rejects(readNutritionBackup(bad), error => error.issues?.some(i => /snapshot/.test(i.code)))
})
test('extra and duplicate ZIP entries refused', async () => {
  const f = await backupFixture(), out = await f.service().export(), entries = await readZip(out.blob)
  await assert.rejects(readNutritionBackup(await zipStore([...entries, entries[0]])), hasCode('duplicate_archive_entry'))
  await assert.rejects(readNutritionBackup(await zipStore([...entries, { name: 'surprise.json', blob: new Blob(['{}']) }])), hasCode('unexpected_archive_entry'))
})
test('manifest tampering and truncation fail', async () => {
  const f = await backupFixture(); await f.commit(); const out = await f.service().export(), entries = await readZip(out.blob), m = entries.find(e => e.name === BACKUP_MANIFEST)
  const raw = JSON.parse(await m.blob.text()); raw.sections.nutrition.counts.foodEntries++; m.blob = new Blob([canonicalJson(raw)])
  await assert.rejects(readNutritionBackup(await zipStore(entries)), hasCode('checksum_mismatch'))
  await assert.rejects(readNutritionBackup(out.blob.slice(0, out.blob.size - 20)))
})
test('duplicate JSON keys and dangerous paths rejected', async () => {
  const f = await backupFixture(), out = await f.service().export(), entries = await readZip(out.blob); entries[0].name = '../evil.json'
  await assert.rejects(readNutritionBackup(await zipStore(entries)), error => error.code === 'bad-name')
  const clean = await readZip(out.blob), m = clean.find(e => e.name === BACKUP_MANIFEST), text = await m.blob.text()
  m.blob = new Blob([text.replace('"schemaVersion":1', '"schemaVersion":0,"schemaVersion":1')])
  await assert.rejects(readNutritionBackup(await zipStore(clean)), hasCode('noncanonical_backup_json'))
})

test('two different partition ids cannot duplicate the same business entity', async () => {
  const f = await backupFixture(); await f.commit(); const out = await f.service().export()
  const bad = await changeArchive(out.blob, async (m, entries) => {
    const original = entries.find(e => e.name.startsWith('nutrition/')), part = JSON.parse(await original.blob.text())
    const copy = reseal({ ...part, id: 'journal-2026-10-another-shard' }), text = canonicalJson(copy)
    m.documents.push({ digest: copy.integrity.digest, kind: 'nutrition', bytes: new TextEncoder().encode(text).length })
    m.sections.nutrition.current.push(copy.integrity.digest); m.sections.nutrition.counts.foodEntries++
    entries.push({ name: `nutrition/${copy.integrity.digest}.json`, blob: new Blob([text]) })
  })
  await assert.rejects(readNutritionBackup(bad), hasCode('duplicate_dataset_id'))
})

test('an unreleased v0 draft partition is not silently treated as a v1 backup migration', async () => {
  const f = await backupFixture(); await f.commit(); const out = await f.service().export()
  const bad = await changeArchive(out.blob, async (m, entries) => {
    const doc = m.documents[0], e = entries.find(e => e.name.startsWith('nutrition/')), part = JSON.parse(await e.blob.text())
    const copy = reseal({ ...part, storageVersion: 0 }), text = canonicalJson(copy)
    const old = doc.digest; doc.digest = copy.integrity.digest; doc.bytes = new TextEncoder().encode(text).length
    m.sections.nutrition.current = [doc.digest]; e.name = e.name.replace(old, doc.digest); e.blob = new Blob([text])
  })
  await assert.rejects(readNutritionBackup(bad), hasCode('unsupported_backup_version'))
})

test('hostile digest types fail structurally without JavaScript coercion', async () => {
  const f = await backupFixture(); await f.commit(); const out = await f.service().export()
  const bad = await changeArchive(out.blob, m => { m.documents[0].digest = { toString: 'blocked', valueOf: 'blocked' } })
  await assert.rejects(readNutritionBackup(bad), hasCode('invalid_backup_document'))
})

test('snapshot dictionary amplification is refused before allocating its repeated contents', async () => {
  const { estimateHydratedPartitionBytes, decodePartition } = await import('./serialization.js'), f = await backupFixture(); await f.commit()
  const out = await f.service().export(), entries = await readZip(out.blob), raw = JSON.parse(await entries.find(e => e.name.startsWith('nutrition/')).blob.text())
  assert.ok(estimateHydratedPartitionBytes(raw) > new TextEncoder().encode(canonicalJson(raw)).length)
  await assert.rejects(decodePartition(raw, { maxHydratedBytes: 1 }), hasCode('partition_hydration_limit'))
  const bad = await changeArchive(out.blob, async (m, entries) => {
    const doc = m.documents[0], e = entries.find(e => e.name.startsWith('nutrition/')), part = JSON.parse(await e.blob.text())
    const { food } = await import('./fixtures.test-util.js'), snapshot = food({ metadata: { padding: 'x'.repeat(200000) } })
    const hash = await import('./persistence-contract.js').then(p => p.contentHash(snapshot))
    part.snapshots = { [hash]: snapshot }
    const row = part.records.foodEntries[0]
    part.records.foodEntries = Array.from({ length: 600 }, (_, n) => ({ ...row, value: { ...row.value, id: `amplified-${n}` }, snapshotRef: hash }))
    const copy = reseal(part), text = canonicalJson(copy), old = doc.digest
    doc.digest = copy.integrity.digest; doc.bytes = new TextEncoder().encode(text).length
    m.sections.nutrition.current = [doc.digest]; m.sections.nutrition.counts.foodEntries = 600
    e.name = e.name.replace(old, doc.digest); e.blob = new Blob([text])
  })
  await assert.rejects(readNutritionBackup(bad), hasCode('backup_hydration_limit'))
})
