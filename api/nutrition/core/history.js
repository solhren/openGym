import { check } from './persistence-contract.js'

export function preserveHistory(before, after) {
  const keyOf = row => JSON.stringify([row.collection, row.id])
  const live = new Set(), tombstones = new Map(), edits = new Map()
  const retainStamp = (previous, next) => {
    // Equal counters from different devices are concurrent, not proven supersession.
    // A future merge coordinator must resolve them explicitly; storage cannot guess.
    check(next.counter > previous.counter || (next.counter === previous.counter && next.deviceId === previous.deviceId),
      'sync', 'regressing_sync_stamp')
  }
  for (const part of after) {
    for (const [collection, rows] of Object.entries(part.records)) {
      for (const id of collection === 'nutritionSettings' ? ['$'] : rows.map(row => row.id)) live.add(JSON.stringify([collection, id]))
    }
    for (const row of part.sync.tombstones) tombstones.set(keyOf(row), row)
    for (const row of part.sync.edits) edits.set(keyOf(row), row)
  }
  for (const part of before) {
    for (const [collection, rows] of Object.entries(part.records)) {
      for (const id of collection === 'nutritionSettings' ? ['$'] : rows.map(row => row.id)) {
        const key = JSON.stringify([collection, id])
        check(live.has(key) || tombstones.has(key), `records.${collection}.${id}`, 'untracked_record_removal')
      }
    }
    // No age-based deletion: a disconnected peer may still need any of these markers.
    for (const row of part.sync.tombstones) {
      const next = tombstones.get(keyOf(row))
      check(!!next, 'sync.tombstones', 'untracked_tombstone_removal')
      retainStamp(row.stamp, next.stamp)
    }
    for (const row of part.sync.edits) {
      const deletion = tombstones.get(keyOf(row)), next = deletion ?? edits.get(keyOf(row))
      check(!!next, 'sync.edits', 'untracked_edit_marker_removal')
      retainStamp(row.stamp, next.stamp)
      for (const [field, previous] of Object.entries(row.fields ?? {})) {
        const stamp = deletion?.stamp ?? next.fields?.[field]
        check(!!stamp, `sync.edits.fields.${field}`, 'untracked_edit_marker_removal')
        retainStamp(previous, stamp)
      }
    }
  }
}
