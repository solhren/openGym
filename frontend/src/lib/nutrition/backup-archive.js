import { canonicalJson, byteLength, contentHash, check, jsonClone } from './persistence-contract.js'

/** Archive imported/frozen complete variants in dedicated v1 library shards. Inline recipe
 * snapshots can be much larger than packed current rows; never force all of them into the
 * original month or drop them when that month reaches 512 KiB. No records become live here. */
export function restorationArchive({ scope, restoreKey, incoming, existing, reservedIds }) {
  const known = new Map(existing.flatMap(p => Object.entries(p.extensions?.nutritionSyncConflicts?.records ?? {})))
  let shard = -1, bytes = 0, part
  return async row => {
    const variant = jsonClone({ collection: row.collection, id: row.id, record: row.record, marker: row.marker }), hash = await contentHash(variant)
    if (known.has(hash)) {
      check(canonicalJson(known.get(hash)) === canonicalJson(variant), 'restore', 'conflict_archive_collision'); return
    }
    const size = byteLength(canonicalJson(variant)) + 70
    check(size < 320 * 1024, 'restore', 'restore_variant_too_large')
    if (!part || bytes + size > 320 * 1024) {
      let id
      do {
        check(shard < 9998, 'restore', 'restore_archive_shard_limit')
        id = `library-bv-${restoreKey.slice(0, 56)}-${++shard}`
      } while (reservedIds.has(id) || incoming.has(id))
      reservedIds.add(id)
      part = { id, kind: 'library', ...scope, records: {}, sync: { revision: 0, writeId: null, edits: [], tombstones: [] },
        extensions: { nutritionSyncConflicts: { version: 1, records: {} } } }
      incoming.set(id, part); bytes = 0
    }
    part.extensions.nutritionSyncConflicts.records[hash] = variant; bytes += size; known.set(hash, variant)
  }
}
