import { assertValid, MASS_UNITS, VOLUME_UNITS } from './contracts.js'
import { validateFood, validateRecipe, validateFoodEntry, validateNutritionGoal, isNutritionDate } from './validate.js'
import { canonicalJson, check, jsonClone, journalPartitionId, libraryPartitionId } from './persistence-contract.js'
import { encodePartition } from './serialization.js'
import { MAX_BACKUP_BYTES } from './backup-contract.js'
import { sumFoodEntries, nutrientsForQuantity, remainingNutrients } from './calculate.js'

export const newNutritionId = () => {
  check(typeof globalThis.crypto?.getRandomValues === 'function', 'identity', 'secure_random_required')
  return [...crypto.getRandomValues(new Uint8Array(16))].map(n => n.toString(16).padStart(2, '0')).join('')
}
const validators = { customFoods: validateFood, recipes: validateRecipe, foodEntries: validateFoodEntry, nutritionGoals: validateNutritionGoal }
const same = (a, b) => canonicalJson(a) === canonicalJson(b)

/** Locale form strings are parsed without silently sanitizing negatives or malformed input.
 * An empty optional nutrient is unknown, not zero. Domain validators remain authoritative. */
export function nutritionNumber(value, nullable = false) {
  if (value === '' && nullable) return null
  check(typeof value === 'string' && /^\d+(?:[.,]\d+)?$/.test(value.trim()), 'form', 'invalid_number')
  const n = Number(value.trim().replace(',', '.'))
  check(Number.isFinite(n), 'form', 'invalid_number')
  return n
}
export function quantityOptions(snapshot) {
  if (snapshot.kind === 'recipe') return ['serving', ...(snapshot.yield.grams ? Object.keys(MASS_UNITS) : []), ...(snapshot.yield.ml ? Object.keys(VOLUME_UNITS) : [])]
  const mass = snapshot.reference.unit === 'g', density = snapshot.densityGPerMl > 0
  return [...(mass || density ? Object.keys(MASS_UNITS) : []), ...(!mass || density ? Object.keys(VOLUME_UNITS) : []),
    ...snapshot.portions.map(p => `portion:${p.id}`)]
}
export function quantityValue(amount, option) {
  return option.startsWith('portion:') ? { amount: nutritionNumber(amount), unit: 'portion', portionId: option.slice(8) } : { amount: nutritionNumber(amount), unit: option }
}
export function editedQuantity(base, amount, option) {
  const quantity = { ...(base ?? {}), ...quantityValue(amount, option) }
  if (quantity.unit !== 'portion') delete quantity.portionId
  return quantity
}
export const nutritionSearchText = (text, locale) => text.toLocaleLowerCase(locale).normalize('NFKD').replace(/\p{M}/gu, '')
export function goalForDay(goals, day) {
  const applicable = goals.filter(g => g.start <= day && (!g.end || g.end >= day))
  return { goal: applicable.length === 1 ? applicable[0] : null, overlapping: applicable.length > 1 }
}
export function daySummary(entries, goals, day) {
  const sum = sumFoodEntries(entries.filter(row => row.d === day)), selected = goalForDay(goals, day)
  return { ...sum, ...selected, remaining: remainingNutrients(sum.totals, selected.goal?.targets ?? {}) }
}
export function historyDays(entries, goals, start, end) {
  check(isNutritionDate(start) && isNutritionDate(end) && start <= end, 'period', 'invalid_period')
  const days = [], date = new Date(`${start}T12:00:00Z`)
  for (;;) {
    const d = date.toISOString().slice(0, 10)
    if (d > end) break
    check(days.length < 366, 'period', 'ui_period_too_large')
    days.push({ d, ...daySummary(entries, goals, d) })
    if (d === end) break // Do not advance into JavaScript's extended (>9999) ISO year.
    date.setUTCDate(date.getUTCDate() + 1)
  }
  return days
}
export const snapshotSummary = snapshot => nutrientsForQuantity(snapshot, { amount: snapshot.reference.amount, unit: snapshot.reference.unit })

/** Coherent selected view, without reconstructing unrelated journal partitions. */
export async function readNutritionView(service, { date, period, includeEntries = true }) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const library = await service.library()
    if (!includeEntries) return { library: library.domains, entries: [], status: library.status }
    const selected = period ? await service.period(period) : await service.day(date)
    if (canonicalJson(library.head) === canonicalJson(selected.head)) return { library: library.domains, entries: selected.entries, status: selected.status }
  }
  check(false, 'read', 'stale_root')
}

/** Serialized intentional commands over the existing CAS publisher. The captured base is
 * compared on every rebase: concurrent edits are never replaced by a stale form. No outbox
 * acknowledgement/cleanup is performed here. This service has no React dependency. */
export function createNutritionCommands({ store, guard = () => {}, newId = newNutritionId }) {
  let tail = Promise.resolve()
  const execute = async commands => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        guard()
        const state = await store.readForRestore({ maxBytes: MAX_BACKUP_BYTES }); guard()
        check(state.status !== 'recovery-required', 'storage', 'recovery_required')
        // readForRestore returns an exclusively owned, fully reconstructed capture, not
        // reader cache objects. Mutating it cannot affect storage or another command;
        // copying ten years of inline snapshots again only increases latency/heap.
        const domains = state.domains, changed = new Map(), commitId = `ui-${newId()}`
        let highest = state.counter
        for (const part of domains) for (const m of [...part.sync.edits, ...part.sync.tombstones])
          highest = Math.max(highest, m.stamp.counter, ...Object.values(m.fields ?? {}).map(s => s.counter))
        check(highest < Number.MAX_SAFE_INTEGER, 'stamp', 'counter_overflow')
        const stamp = { counter: highest + 1, deviceId: store.deviceId }
        const touch = part => {
          if (changed.has(part.id)) return
          check(part.sync.revision < Number.MAX_SAFE_INTEGER, 'revision', 'counter_overflow')
          part.sync = { ...part.sync, revision: part.sync.revision + 1, writeId: commitId }; changed.set(part.id, part)
        }
        for (const command of commands) {
          const { collection, base, value } = command, id = command.id
          check(Object.hasOwn(validators, collection), 'collection', 'unsupported_ui_collection')
          check(typeof id === 'string' && id.length > 0, 'id', 'text_required')
          if (value !== null) { check(value.id === id, 'id', 'record_id_mismatch'); assertValid(validators[collection](value)) }
          let part = domains.find(p => (p.records[collection] ?? []).some(row => row.id === id))
          const previous = part?.records[collection].find(row => row.id === id) ?? null
          // Retrying after a lost local publication response must not duplicate a record.
          // An exact already-achieved value is a no-op, never an overwrite of newer data.
          if (value !== null && previous !== null && same(previous, value)) continue
          check(same(previous, base), 'form', 'record_changed')
          if (value === null) check(previous !== null, 'form', 'record_changed')
          if (previous && value) check(Object.keys(previous).every(key => Object.hasOwn(value, key)), 'form', 'field_erasure_requires_new_id')
          if (!part) {
            check(!domains.some(p => p.sync.tombstones.some(m => m.collection === collection && m.id === id)), 'id', 'permanently_deleted_id')
            // Append to an owned, monthly/library shard, trying the full portable encoder before
            // choosing it. Existing shards and their metadata are never silently discarded.
            const journal = collection === 'foodEntries', month = journal ? value.d.slice(0, 7) : null
            const prefix = store.deviceId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 36) || 'device'
            for (let shard = 0; shard < 1900; shard++) {
              const partitionId = journal ? journalPartitionId(month, `${prefix}-${shard}`) : libraryPartitionId(`${prefix}-${shard}`)
              part = domains.find(p => p.id === partitionId)
              if (!part) { part = { id: partitionId, kind: journal ? 'journal' : 'library', ...store.scope,
                records: {}, sync: { revision: 0, writeId: null, edits: [], tombstones: [] } }; domains.push(part) }
              const candidate = jsonClone(part)
              candidate.records[collection] ??= []; candidate.records[collection].push(value)
              // Size the actual publication, including field clocks and the new write id.
              // A sparse marker can fit at 512 KiB while the complete marker cannot.
              const fields = Object.fromEntries(Object.keys(value).filter(f => !['id', 'schemaVersion'].includes(f)).map(field => [field, stamp]))
              candidate.sync.edits.push({ collection, id, stamp, fields })
              if (!changed.has(part.id)) candidate.sync.revision++
              candidate.sync.writeId = commitId
              try { await encodePartition(candidate); break }
              catch (error) { if (!error.issues?.some(i => i.code === 'document_too_large')) throw error; part = null }
            }
            check(!!part, 'storage', 'ui_shard_limit')
          }
          touch(part)
          const marker = part.sync.edits.find(m => m.collection === collection && m.id === id)
          part.records[collection] ??= []
          part.records[collection] = part.records[collection].filter(row => row.id !== id)
          part.sync.edits = part.sync.edits.filter(m => m.collection !== collection || m.id !== id)
          if (value === null) part.sync.tombstones.push({ collection, id, stamp })
          else {
            const fields = Object.create(null)
            for (const field of Object.keys(value).filter(f => !['id', 'schemaVersion'].includes(f))) {
              const priorStamp = marker?.fields && Object.hasOwn(marker.fields, field) ? marker.fields[field] : marker?.stamp ?? stamp
              fields[field] = previous && Object.hasOwn(previous, field) && same(previous[field], value[field]) ? priorStamp : stamp
            }
            part.records[collection].push(jsonClone(value)); part.sync.edits.push({ collection, id, stamp, fields })
          }
        }
        const partitions = []
        for (const domain of changed.values()) partitions.push(await encodePartition(domain))
        guard()
        if (!partitions.length) return { head: state.head, repeated: true }
        return await store.commit({ commitId, expectedHead: state.head, partitions }, { guard, maxBytes: MAX_BACKUP_BYTES })
      } catch (error) {
        // A publication can invalidate a capture before commit, too. Re-read the whole
        // authoritative graph and compare the original form base; never reuse that capture.
        if (attempt === 2 || !error.issues?.some(i => ['stale_root', 'read_invalidated'].includes(i.code))) throw error
      }
    }
  }
  return {
    save(collection, value, base = null) { return this.batch([{ collection, id: value.id, value, base }]) },
    remove(collection, base) { return this.batch([{ collection, id: base.id, value: null, base }]) },
    batch(input) {
      const captured = jsonClone(input)
      check(Array.isArray(captured) && captured.length > 0 && captured.length <= 100, 'commands', 'invalid_ui_batch')
      const task = tail.catch(() => {}).then(() => execute(captured)); tail = task; return task
    },
  }
}
