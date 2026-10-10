import { describe, it, vi } from 'vitest'
import assert from 'node:assert/strict'
import { encodePartition, decodePartition, stringifyPartition, parsePartition, migratePartition, PARTITION_FORMAT } from './serialization.js'
import { MAX_DOCUMENT_BYTES, byteLength, canonicalJson, journalPartitionId } from './persistence-contract.js'
import { entry, food, recipe, freeze } from './fixtures.test-util.js'
import { createRecipeSnapshot } from './recipe.js'
import { sumFoodEntries } from './calculate.js'
import { journal, library, sync, stamp, reseal, hasCode } from './persistence.test-util.js'

describe('versioned nutrition serialization', () => {
  it('keeps identical partition bytes and restores data without Web Crypto', async () => {
    const input = library(), native = await encodePartition(input)
    vi.stubGlobal('crypto', undefined)
    try {
      const fallback = await encodePartition(input)
      assert.deepEqual(fallback, native)
      assert.deepEqual(await decodePartition(await stringifyPartition(fallback)), input)
    } finally { vi.unstubAllGlobals() }
  })
  for (const [name, make] of [['journal', journal], ['library, recipes, templates and goals', library]]) {
    it(`round-trips ${name} through the actual JSON format`, async () => {
      const input = freeze(make()), before = canonicalJson(input)
      const encoded = await encodePartition(input)
      const text = await stringifyPartition(encoded)
      const parsed = await parsePartition(text)
      assert.deepEqual(await decodePartition(parsed), input)
      assert.equal(canonicalJson(input), before)
      assert.ok(byteLength(text) < MAX_DOCUMENT_BYTES)
    })
  }
  it('retains absent/null/zero nutrients, fractional portions, metadata and provenance', async () => {
    const snapshot = food({ nutrients: { kcal: null, protein: 0, carbs: 1 / 3, sugar: null },
      source: { kind: 'open-food-facts', externalId: '123', url: 'https://world.openfoodfacts.org/product/123',
        license: { id: 'ODbL', url: 'https://opendatacommons.org/licenses/odbl/', attribution: 'Test only' },
        imported: { locale: 'fr', verified: false } }, metadata: { future: [null, 'é'] } })
    const input = journal({ records: { foodEntries: [entry({ snapshot, quantity: { amount: 0.25, unit: 'portion', portionId: 'scoop' },
      note: '', mealId: null, copiedFromEntryId: 'previous', snapshotRef: 'business metadata', extra: { x: 2 } })] } })
    const result = await decodePartition(await encodePartition(input))
    assert.deepEqual(result, input)
    assert.equal(Object.hasOwn(result.records.foodEntries[0].snapshot.nutrients, 'fat'), false)
  })
  it('deduplicates whole snapshots across catalogue, recipe ingredients and templates', async () => {
    const encoded = await encodePartition(library())
    assert.equal(Object.keys(encoded.snapshots).length, 3)
    assert.equal(encoded.records.customFoods[0].foodRef, encoded.records.recipes[0].ingredients[0].foodRef)
    assert.equal(encoded.records.customFoods[0].foodRef, encoded.records.mealTemplates[0].items[0].snapshotRef)
  })
  it('deduplicates by full content, not food id or key order', async () => {
    const original = food(), reordered = Object.fromEntries(Object.entries(original).reverse())
    const input = journal({ records: { foodEntries: [entry(), entry({ id: 'b', snapshot: reordered }),
      entry({ id: 'c', snapshot: food({ nutrients: { kcal: 400 } }) }), entry({ id: 'd', snapshot: food({ source: { kind: 'custom', attribution: 'different' } }) })] } })
    const encoded = await encodePartition(input)
    assert.equal(Object.keys(encoded.snapshots).length, 3)
    assert.deepEqual(await decodePartition(encoded), input)
  })
  it('returns independent snapshots and retains history after a catalogue edit', async () => {
    const old = food(), input = journal({ records: { foodEntries: [entry({ snapshot: old }), entry({ id: 'b', snapshot: old })] } })
    const encoded = await encodePartition(input), decoded = await decodePartition(encoded)
    decoded.records.foodEntries[0].snapshot.nutrients.kcal = 1
    old.nutrients.kcal = 2
    assert.equal(decoded.records.foodEntries[1].snapshot.nutrients.kcal, 380)
    assert.equal((await decodePartition(encoded)).records.foodEntries[0].snapshot.nutrients.kcal, 380)
  })
  it('captures caller data before asynchronous serialization', async () => {
    const input = journal(), result = encodePartition(input)
    input.records.foodEntries[0].snapshot.name = 'Changed'
    assert.equal((await decodePartition(await result)).records.foodEntries[0].snapshot.name, 'Oats')
  })
  it('keeps placement stable when the consumption day changes', async () => {
    const input = journal({ records: { foodEntries: [entry({ d: '2020-01-01' })] } })
    assert.equal((await encodePartition(input)).id, input.id)
    input.records.foodEntries[0].d = '2030-12-31'
    assert.equal((await decodePartition(await encodePartition(input))).id, input.id)
  })
  it('preserves edits, field stamps and deletion tombstones outside business rows', async () => {
    const input = journal({ sync: { ...sync(4), remote: { revision: 2, writeId: 'server-write-2' }, edits: [{ collection: 'foodEntries', id: 'entry-1', stamp: stamp(8), fields: { quantity: stamp(8), snapshot: stamp(7) } }],
      tombstones: [{ collection: 'foodEntries', id: 'removed', stamp: stamp(9) }] } })
    assert.deepEqual(await decodePartition(await encodePartition(input)), input)
  })
  for (const [name, change, code] of [
    ['wrong collection', d => { d.records.recipes = [] }, 'invalid_collection'],
    ['wrong kind', d => { d.kind = 'library' }, 'partition_kind_mismatch'],
    ['duplicate entry id', d => { d.records.foodEntries.push(entry()) }, 'duplicate_id'],
    ['invalid quantity', d => { d.records.foodEntries[0].quantity.amount = 0 }, 'positive_number_required'],
    ['foreign storage header', d => { d.extraHeader = 1 }, 'unexpected_field'],
    ['URL with a path', d => { d.namespace = { serverOrigin: 'https://gym.example/path', profileId: 'a' } }, 'canonical_origin_required'],
    ['fractional revision', d => { d.sync.revision = 0.5 }, 'safe_integer_required'],
    ['missing write id', d => { d.sync.revision = 2 }, 'invalid_write_id'],
    ['edit without record', d => { d.sync.edits = [{ collection: 'foodEntries', id: 'missing', stamp: stamp() }] }, 'edit_without_record'],
    ['live tombstone', d => { d.sync.tombstones = [{ collection: 'foodEntries', id: 'entry-1', stamp: stamp() }] }, 'live_tombstone_conflict'],
    ['duplicate tombstone', d => { d.sync.tombstones = [1, 2].map(() => ({ collection: 'foodEntries', id: 'deleted', stamp: stamp() })) }, 'duplicate_sync_marker'],
    ['stamp overflow', d => { d.sync.edits = [{ collection: 'foodEntries', id: 'entry-1', stamp: stamp(Number.MAX_SAFE_INTEGER + 1) }] }, 'positive_safe_integer_required'],
    ['remote revision without a write id', d => { d.sync.remote = { revision: 1, writeId: null } }, 'invalid_write_id'],
    ['split atomic field', d => { d.sync.edits = [{ collection: 'foodEntries', id: 'entry-1', stamp: stamp(), fields: { 'quantity.amount': stamp() } }] }, 'unknown_record_field'],
    ['editing an immutable id', d => { d.sync.edits = [{ collection: 'foodEntries', id: 'entry-1', stamp: stamp(), fields: { id: stamp() } }] }, 'immutable_record_field'],
  ]) it(`rejects ${name} at the write boundary`, async () => {
    const input = journal(); change(input)
    await assert.rejects(encodePartition(input), hasCode(code))
  })
  for (const [name, change, code] of [
    ['missing reference', d => { d.records.foodEntries[0].snapshotRef = '0'.repeat(64) }, 'missing_snapshot'],
    ['malformed reference', d => { d.records.foodEntries[0].snapshotRef = '../snapshot' }, 'invalid_snapshot_reference'],
    ['snapshot with altered content', d => { Object.values(d.snapshots)[0].name = 'Different' }, 'snapshot_checksum_mismatch'],
    ['unknown row fields', d => { d.records.foodEntries[0].ignored = true }, 'unexpected_field'],
    ['embedded snapshot overriding reference', d => { d.records.foodEntries[0].value.snapshot = food() }, 'reserved_storage_field'],
    ['corrupted domain quantity', d => { d.records.foodEntries[0].value.quantity.unit = 'cups' }, 'unknown_unit'],
    ['future domain format', d => { d.domainVersion = 2 }, 'unsupported_domain_version'],
    ['future storage format', d => { d.storageVersion = 42 }, 'unsupported_storage_version'],
  ]) it(`rejects ${name}, even with a recomputed outer checksum`, async () => {
    const doc = await encodePartition(journal()); change(doc)
    await assert.rejects(decodePartition(reseal(doc)), hasCode(code))
  })
  it('detects accidental corruption without rewriting the checksum', async () => {
    const doc = await encodePartition(journal()); doc.records.foodEntries[0].value.note = 'unexpected'
    await assert.rejects(decodePartition(doc), hasCode('checksum_mismatch'))
  })
  it('rejects a recipe snapshot where an ingredient requires a food', async () => {
    const doc = await encodePartition(library())
    const recipeRef = doc.records.mealTemplates[0].items[1].snapshotRef
    doc.records.recipes[0].ingredients[0].foodRef = recipeRef
    await assert.rejects(decodePartition(reseal(doc)), hasCode('food_reference_required'))
  })
  it('rejects invalid metadata without invoking getters or losing unsupported values', async () => {
    const input = journal(); input.records.foodEntries[0].snapshot.source.bad = undefined
    await assert.rejects(encodePartition(input), hasCode('json_unsupported_value'))
    input.records.foodEntries[0].snapshot.source.bad = input
    await assert.rejects(encodePartition(input), hasCode('json_circular_reference'))
    const inherited = Object.create(journal())
    await assert.rejects(encodePartition(inherited), hasCode('json_plain_object_required'))
  })
  it('migrates the inline v0 format without losing metadata, ids or stamps', async () => {
    const input = freeze(library()), legacy = reseal({ ...input, format: PARTITION_FORMAT, storageVersion: 0, domainVersion: 1 })
    const migrated = await migratePartition(freeze(legacy))
    assert.equal(migrated.storageVersion, 1)
    assert.deepEqual(await decodePartition(migrated), input)
    assert.deepEqual(await migratePartition(migrated), migrated)
  })
  it('rejects invalid or corrupt legacy records instead of repairing them', async () => {
    const legacy = reseal({ ...journal(), format: PARTITION_FORMAT, storageVersion: 0, domainVersion: 1 })
    legacy.records.foodEntries[0].quantity.amount = -1
    await assert.rejects(migratePartition(legacy), hasCode('checksum_mismatch'))
    await assert.rejects(migratePartition(reseal(legacy)), hasCode('positive_number_required'))
  })
  it('rejects over-budget writes rather than truncating data', async () => {
    const input = journal(); input.records.foodEntries[0].note = 'é'.repeat(MAX_DOCUMENT_BYTES / 2)
    await assert.rejects(encodePartition(input), hasCode('document_too_large'))
  })
  for (const years of [5, 10]) it(`round-trips ${years} years of recurring recipe entries in bounded partitions`, async () => {
    const count = years === 5 ? 18270 : 36530, snapshot = createRecipeSnapshot(recipe()), batchSize = 300
    let total = 0, bytes = 0
    for (let start = 0; start < count; start += batchSize) {
      const rows = Array.from({ length: Math.min(batchSize, count - start) }, (_, offset) => {
        const index = start + offset, d = new Date(Date.UTC(2020, 0, 1 + Math.floor(index / 10))).toISOString().slice(0, 10)
        return entry({ id: `entry-${index}`, d, snapshot, quantity: { amount: 0.5, unit: 'serving' } })
      })
      const input = journal({ id: journalPartitionId('2026-10', `batch-${start}`), records: { foodEntries: rows } })
      const encoded = await encodePartition(input), text = await stringifyPartition(encoded)
      assert.equal(Object.keys(encoded.snapshots).length, 1)
      assert.ok(byteLength(text) < MAX_DOCUMENT_BYTES)
      const result = await decodePartition(await parsePartition(text))
      assert.deepEqual(result.records.foodEntries, rows)
      assert.equal(sumFoodEntries(result.records.foodEntries).totals.kcal, rows.length * 125)
      total += rows.length; bytes += byteLength(text)
    }
    assert.equal(total, count)
    assert.ok(bytes < count * byteLength(JSON.stringify(entry({ snapshot }))))
  }, 120000)
})
