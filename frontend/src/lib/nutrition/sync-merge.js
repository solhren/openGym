import { canonicalJson, check, contentHash, exactKeys, jsonClone, isCounter } from './persistence-contract.js'
import { encodePartition } from './serialization.js'
import { preserveHistory } from '../../../../api/nutrition/core/history.js'
import { validateConflictArchives } from './sync-contract.js'
import { BACKUP_METADATA, unionBackupMetadata } from './backup-history.js'

const keyOf = row => canonicalJson([row.collection, row.id])
const same = (a, b) => canonicalJson(a) === canonicalJson(b)
const compare = (a, b) => a.counter - b.counter || (a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0)
const mutable = field => !['id', 'schemaVersion'].includes(field)
const advanced = counter => { check(isCounter(counter) && counter < Number.MAX_SAFE_INTEGER, 'sync', 'counter_overflow'); return counter + 1 }

// A deterministic resolution stamp covers *both* inputs. Equal Lamport counters from
// different devices must advance, rather than simply choosing a device lexicographically.
function cover(stamps, divergent = false) {
  const maximum = Math.max(...stamps.map(s => s.counter))
  const atMaximum = stamps.filter(s => s.counter === maximum)
  return atMaximum.some(s => !same(s, atMaximum[0])) || divergent ?
    { counter: advanced(maximum), deviceId: 'nutrition-merge-v1' } : jsonClone(atMaximum[0])
}

function index(domains, fallback) {
  const result = new Map()
  for (const part of domains) {
    const edits = new Map(part.sync.edits.map(row => [keyOf(row), row]))
    for (const [collection, rows] of Object.entries(part.records)) {
      for (const record of collection === 'nutritionSettings' ? [rows] : rows) {
        const id = collection === 'nutritionSettings' ? '$' : record.id, key = keyOf({ collection, id })
        check(!result.has(key), 'records', 'duplicate_dataset_id')
        result.set(key, { collection, id, record, owner: part.id,
          marker: edits.get(key) ?? (fallback ? { collection, id, stamp: fallback } : null) })
      }
    }
    for (const marker of part.sync.tombstones) {
      const key = keyOf(marker)
      check(!result.has(key), 'sync', 'dataset_live_tombstone_conflict')
      result.set(key, { collection: marker.collection, id: marker.id, marker, owner: part.id, deleted: true })
    }
  }
  return result
}

/** Merge validated domain graphs, independent of React, network and storage. Tombstones
 * are permanent for an entity id. Conflicting values are retained as self-contained domain
 * records in extensions, including their snapshots; there is no expiry or implicit pruning.
 * Without edit markers, divergent existing records are refused instead of guessing. */
export async function mergeNutritionDomains({ remote, local, localStamp, writeId }) {
  remote = jsonClone(remote); local = jsonClone(local)
  // Validate inputs through the same business/storage validators as every persisted write.
  for (const part of [...remote, ...local]) await encodePartition(part)
  await validateConflictArchives([...remote, ...local])
  const a = index(remote), originalLocal = index(local), b = index(local, localStamp), parts = new Map()
  for (const part of [...remote, ...local]) {
    if (!parts.has(part.id)) parts.set(part.id, { ...part, records: {}, sync: { ...part.sync, edits: [], tombstones: [] } })
    const target = parts.get(part.id), extensions = { ...(target.extensions ?? {}) }
    for (const collection of Object.keys(part.records)) if (collection !== 'nutritionSettings') target.records[collection] ??= []
    for (const [key, value] of Object.entries(part.extensions ?? {})) {
      if (BACKUP_METADATA.includes(key)) {
        extensions[key] = unionBackupMetadata(extensions[key], value, key)
      } else if (key === 'nutritionSyncConflicts') {
        exactKeys(value, ['version', 'records'], 'extensions.nutritionSyncConflicts')
        check(value.version === 1 && value.records && typeof value.records === 'object' && !Array.isArray(value.records), 'extensions', 'invalid_conflict_archive')
        const prior = extensions[key] ?? { version: 1, records: {} }
        for (const [hash, record] of Object.entries(value.records)) {
          check(await contentHash(record) === hash, 'extensions', 'conflict_archive_checksum_mismatch')
          check(!Object.hasOwn(prior.records, hash) || same(prior.records[hash], record), 'extensions', 'conflict_archive_collision')
        }
        extensions[key] = { version: 1, records: { ...prior.records, ...value.records } }
      } else {
        check(!Object.hasOwn(extensions, key) || same(extensions[key], value), `extensions.${key}`, 'extension_conflict')
        Object.defineProperty(extensions, key, { value, enumerable: true, configurable: true, writable: true })
      }
    }
    if (Object.keys(extensions).length) target.extensions = extensions
  }
  const archive = async (part, row) => {
    if (!row || row.deleted) return
    const value = { collection: row.collection, id: row.id, record: row.record, marker: row.marker }
    const hash = await contentHash(value)
    part.extensions ??= {}
    part.extensions.nutritionSyncConflicts ??= { version: 1, records: {} }
    part.extensions.nutritionSyncConflicts.records[hash] = value
  }
  let conflicts = 0
  for (const key of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const left = a.get(key), right = b.get(key), owner = left?.owner ?? right.owner, target = parts.get(owner)
    const example = left ?? right
    let marker, record
    if (left?.deleted || right?.deleted) {
      const stamps = [left, right].filter(Boolean).flatMap(row => row.marker ?
        [row.marker.stamp, ...Object.values(row.marker.fields ?? {})] : [])
      marker = { collection: example.collection, id: example.id, stamp: cover(stamps) }
      if (left && !left.deleted || right && !right.deleted) {
        await archive(target, left); await archive(target, right); conflicts++
      }
      target.sync.tombstones.push(marker)
      continue
    }
    if (!left || !right) { record = example.record; marker = example.marker }
    else if (same(left.record, right.record)) {
      record = left.record
      if (left.marker || right.marker) {
        const markers = [left.marker, right.marker].filter(Boolean)
        marker = { collection: example.collection, id: example.id, stamp: cover(markers.map(m => m.stamp)) }
        const fields = {}
        for (const field of new Set(markers.flatMap(m => Object.keys(m.fields ?? {}))))
          Object.defineProperty(fields, field, { value: cover(markers.map(m => m.fields?.[field]).filter(Boolean)), enumerable: true })
        if (Object.keys(fields).length) marker.fields = fields
      }
    } else {
      // A synthesized checkpoint stamp is safe for a new id, not for guessing an unmarked
      // edit to an existing id. Both sides of a divergent existing record need real markers.
      const original = originalLocal.get(key)
      check(!!left.marker && !!original?.marker, `records.${example.collection}.${example.id}`, 'untracked_sync_conflict')
      const lm = left.marker, rm = right.marker
      record = {}; const fields = {}
      const whole = !lm.fields || !rm.fields
      // A whole-record writer cannot overwrite a stronger known field clock merely
      // because the other record's aggregate marker is lower than its field markers.
      const effective = m => [m.stamp, ...Object.values(m.fields ?? {})].sort(compare).at(-1)
      const order = compare(effective(lm), effective(rm))
      const winner = order > 0 ? left : order < 0 ? right :
        canonicalJson(left.record) >= canonicalJson(right.record) ? left : right
      let tiedDivergence = false
      for (const field of new Set([...Object.keys(left.record), ...Object.keys(right.record)])) {
        const lp = Object.hasOwn(left.record, field), rp = Object.hasOwn(right.record, field)
        // Optional-field erasure cannot discard an existing field marker under contract v1.
        // Keep that value; the conflicting complete input remains in the archive.
        const ls = lm.fields?.[field] ?? lm.stamp, rs = rm.fields?.[field] ?? rm.stamp
        const differs = lp !== rp || lp && !same(left.record[field], right.record[field])
        const selected = !lp ? right : !rp ? left : whole ? winner : compare(ls, rs) > 0 ? left : compare(ls, rs) < 0 ? right :
          canonicalJson(left.record[field]) >= canonicalJson(right.record[field]) ? left : right
        Object.defineProperty(record, field, { value: selected.record[field], enumerable: true, configurable: true, writable: true })
        const tied = differs && same(ls, rs)
        tiedDivergence ||= tied
        if (mutable(field) && (Object.hasOwn(lm.fields ?? {}, field) || Object.hasOwn(rm.fields ?? {}, field)))
          Object.defineProperty(fields, field, { value: cover([ls, rs], tied), enumerable: true })
      }
      marker = { collection: example.collection, id: example.id, stamp: cover([
        lm.stamp, rm.stamp, ...Object.values(lm.fields ?? {}), ...Object.values(rm.fields ?? {}),
      ], tiedDivergence) }
      if (Object.keys(fields).length) marker.fields = fields
      await archive(target, left); await archive(target, right); conflicts++
    }
    if (example.collection === 'nutritionSettings') target.records.nutritionSettings = record
    else { target.records[example.collection] ??= []; target.records[example.collection].push(record) }
    if (marker) target.sync.edits.push(marker)
  }
  const result = [...parts.values()].sort((x, y) => x.id < y.id ? -1 : x.id > y.id ? 1 : 0)
  for (const part of result) {
    const inputs = [...remote, ...local].filter(p => p.id === part.id)
    const maximum = Math.max(...inputs.map(p => p.sync.revision))
    part.sync = { ...part.sync, revision: advanced(maximum), writeId }
    // Per-adapter base hints have no authority in the portable server publication.
    delete part.sync.remote
    await encodePartition(part) // mixed field values must still satisfy business invariants
  }
  preserveHistory(remote, result); preserveHistory(local, result)
  return { domains: result, conflicts }
}
