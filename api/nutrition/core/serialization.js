import { assertValid } from './contracts.js'
import { validateFood, validateRecipe, validateSnapshot, validateFoodEntry, validateMealTemplate, validateNutritionGoal } from './validate.js'
import {
  STORAGE_VERSION, DOMAIN_VERSION, COLLECTIONS, HASH_PATTERN, check, isObject, exactKeys,
  jsonClone, canonicalJson, boundedJson, byteLength, contentHash, sealDocument, verifiedDocument,
  validateScope, validateSync, partitionKind,
} from './persistence-contract.js'

export const PARTITION_FORMAT = 'opengym-nutrition-partition'
const validators = { foodEntries: validateFoodEntry, customFoods: validateFood, savedFoods: validateFood,
  recipes: validateRecipe, mealTemplates: validateMealTemplate, nutritionGoals: validateNutritionGoal }
const domainKeys = ['id', 'kind', 'namespace', 'generation', 'records', 'sync', 'extensions']
const requiredKeys = domainKeys.filter(key => key !== 'extensions')
const without = (value, key) => Object.fromEntries(Object.entries(value).filter(([k]) => k !== key))

function validateDomain(input) {
  exactKeys(input, domainKeys, '$', requiredKeys)
  validateScope({ ...input, domainVersion: DOMAIN_VERSION })
  check(input.kind === partitionKind(input.id), 'kind', 'partition_kind_mismatch')
  check(isObject(input.records), 'records', 'object_required')
  for (const [collection, rows] of Object.entries(input.records)) {
    check(COLLECTIONS.includes(collection) && (input.kind === 'journal') === (collection === 'foodEntries'), `records.${collection}`, 'invalid_collection')
    if (collection === 'nutritionSettings') check(isObject(rows), 'records.nutritionSettings', 'object_required')
    else {
      check(Array.isArray(rows), `records.${collection}`, 'array_required')
      rows.forEach((row, i) => assertValid(validators[collection](row, `records.${collection}[${i}]`)))
    }
  }
  if (Object.hasOwn(input, 'extensions')) check(isObject(input.extensions), 'extensions', 'object_required')
  validateSync(input.sync, input.records, input.kind)
}

/** Domain -> independent storage rows. Identical complete snapshots share a SHA-256 key.
 * Dictionary ownership is partition-local: no cross-partition dependency for historical food. */
export async function encodePartition(input) {
  const domain = jsonClone(input)
  validateDomain(domain)
  const snapshots = new Map(), cache = new Map()
  const intern = async snapshot => {
    assertValid(validateSnapshot(snapshot))
    const text = canonicalJson(snapshot)
    if (!cache.has(text)) {
      const hash = await contentHash(snapshot)
      check(!snapshots.has(hash) || canonicalJson(snapshots.get(hash)) === text, 'snapshots', 'hash_collision')
      cache.set(text, hash); snapshots.set(hash, snapshot)
    }
    return cache.get(text)
  }
  const records = {}
  for (const [collection, rows] of Object.entries(domain.records)) {
    if (collection === 'nutritionSettings') { records[collection] = rows; continue }
    records[collection] = []
    for (const row of rows) {
      let packed
      if (['customFoods', 'savedFoods'].includes(collection)) packed = { foodRef: await intern(row) }
      else if (collection === 'foodEntries') packed = { value: without(row, 'snapshot'), snapshotRef: await intern(row.snapshot) }
      else if (collection === 'recipes') {
        const ingredients = []
        for (const item of row.ingredients) ingredients.push({ value: without(item, 'food'), foodRef: await intern(item.food) })
        packed = { value: without(row, 'ingredients'), ingredients }
      } else if (collection === 'mealTemplates') {
        const items = []
        for (const item of row.items) items.push({ value: without(item, 'snapshot'), snapshotRef: await intern(item.snapshot) })
        packed = { value: without(row, 'items'), items }
      } else packed = { value: row }
      records[collection].push(packed)
    }
  }
  return sealDocument({ ...domain, format: PARTITION_FORMAT, storageVersion: STORAGE_VERSION,
    domainVersion: DOMAIN_VERSION, records, snapshots: Object.fromEntries(snapshots) })
}

// Only for the private JSON tree returned by loadPartition, never caller objects.
// Its descriptors have already been inspected and captured before any await. Copying
// own data preserves independent historical snapshots without re-encoding/re-inspecting
// every recurring snapshot. fromEntries also preserves own __proto__ keys safely.
function copyCapturedJson(value) {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(copyCapturedJson)
  return Object.fromEntries(Object.keys(value).map(key => [key, copyCapturedJson(value[key])]))
}

async function hydrate(doc) {
  exactKeys(doc, [...domainKeys, 'format', 'storageVersion', 'domainVersion', 'snapshots', 'integrity'], '$',
    [...requiredKeys, 'format', 'storageVersion', 'domainVersion', 'snapshots', 'integrity'])
  validateScope(doc)
  check(doc.kind === partitionKind(doc.id), 'kind', 'partition_kind_mismatch')
  check(isObject(doc.snapshots), 'snapshots', 'object_required')
  for (const [hash, snapshot] of Object.entries(doc.snapshots)) {
    check(HASH_PATTERN.test(hash), `snapshots.${hash}`, 'invalid_snapshot_key')
    assertValid(validateSnapshot(snapshot, `snapshots.${hash}`))
    check(await contentHash(snapshot) === hash, `snapshots.${hash}`, 'snapshot_checksum_mismatch')
  }
  const resolve = (ref, path, foodOnly = false) => {
    check(typeof ref === 'string' && HASH_PATTERN.test(ref), path, 'invalid_snapshot_reference')
    check(Object.hasOwn(doc.snapshots, ref), path, 'missing_snapshot')
    const value = copyCapturedJson(doc.snapshots[ref])
    if (foodOnly) check(value.kind === 'food', path, 'food_reference_required')
    return value
  }
  const valueOf = (row, excluded, path) => {
    check(isObject(row.value), `${path}.value`, 'object_required')
    check(!Object.hasOwn(row.value, excluded), `${path}.value.${excluded}`, 'reserved_storage_field')
    return copyCapturedJson(row.value)
  }
  check(isObject(doc.records), 'records', 'object_required')
  const records = {}
  for (const [collection, rows] of Object.entries(doc.records)) {
    check(COLLECTIONS.includes(collection) && (doc.kind === 'journal') === (collection === 'foodEntries'), `records.${collection}`, 'invalid_collection')
    if (collection === 'nutritionSettings') { records[collection] = copyCapturedJson(rows); continue }
    check(Array.isArray(rows), `records.${collection}`, 'array_required')
    records[collection] = rows.map((row, i) => {
      const path = `records.${collection}[${i}]`
      if (['customFoods', 'savedFoods'].includes(collection)) {
        exactKeys(row, ['foodRef'], path)
        return resolve(row.foodRef, `${path}.foodRef`, true)
      }
      if (collection === 'foodEntries') {
        exactKeys(row, ['value', 'snapshotRef'], path)
        return { ...valueOf(row, 'snapshot', path), snapshot: resolve(row.snapshotRef, `${path}.snapshotRef`) }
      }
      if (['recipes', 'mealTemplates'].includes(collection)) {
        const key = collection === 'recipes' ? 'ingredients' : 'items'
        const refKey = collection === 'recipes' ? 'foodRef' : 'snapshotRef'
        const field = collection === 'recipes' ? 'food' : 'snapshot'
        exactKeys(row, ['value', key], path)
        check(Array.isArray(row[key]), `${path}.${key}`, 'array_required')
        const items = row[key].map((item, index) => {
          const p = `${path}.${key}[${index}]`
          exactKeys(item, ['value', refKey], p)
          return { ...valueOf(item, field, p), [field]: resolve(item[refKey], `${p}.${refKey}`, field === 'food') }
        })
        return { ...valueOf(row, key, path), [key]: items }
      }
      exactKeys(row, ['value'], path)
      return copyCapturedJson(row.value)
    })
  }
  const domain = Object.fromEntries(requiredKeys.map(key => [key, key === 'records' ? records : copyCapturedJson(doc[key])]))
  if (Object.hasOwn(doc, 'extensions')) domain.extensions = copyCapturedJson(doc.extensions)
  validateDomain(domain)
  return domain
}

/** v0 is the explicit inline import/draft format, not an earlier shipped database.
 * Versions are migrated before use, with all ids, provenance, revisions and values retained. */
async function loadPartition(value) {
  const doc = await verifiedDocument(value, PARTITION_FORMAT, [0, STORAGE_VERSION])
  validateScope(doc)
  if (doc.storageVersion === 0) {
    exactKeys(doc, [...domainKeys, 'format', 'storageVersion', 'domainVersion', 'integrity'], '$',
      [...requiredKeys, 'format', 'storageVersion', 'domainVersion', 'integrity'])
    const domain = Object.fromEntries(domainKeys.filter(key => Object.hasOwn(doc, key)).map(key => [key, doc[key]]))
    return encodePartition(domain)
  }
  return doc
}
export async function migratePartition(value) {
  return (await decodePartitionDocument(value)).partition
}
/** Conservative JSON-size estimate before allocating repeated dictionary snapshots.
 * A small packed partition may expand enormously; resource-sensitive callers must gate it
 * before hydration. This adds no incompatible field or default limit to portable v1. */
export function estimateHydratedPartitionBytes(doc) {
  let bytes = byteLength(canonicalJson(doc))
  const sizes = new Map(Object.entries(doc.snapshots ?? {}).map(([hash, value]) => [hash, byteLength(canonicalJson(value))]))
  const add = ref => {
    check(typeof ref === 'string' && sizes.has(ref), 'snapshots', 'missing_snapshot')
    bytes += sizes.get(ref) + 16
  }
  for (const [collection, rows] of Object.entries(doc.records ?? {})) {
    if (collection === 'nutritionSettings') continue
    check(Array.isArray(rows), 'records', 'array_required')
    for (const row of rows) {
      if (collection === 'foodEntries') add(row?.snapshotRef)
      else if (collection === 'customFoods' || collection === 'savedFoods') add(row?.foodRef)
      else if (collection === 'recipes' || collection === 'mealTemplates') {
        const items = collection === 'recipes' ? row?.ingredients : row?.items
        check(Array.isArray(items), 'records', 'array_required')
        for (const item of items) add(collection === 'recipes' ? item?.foodRef : item?.snapshotRef)
      }
    }
  }
  return bytes
}
/** Capture and validate once, returning both portable document and hydrated domain.
 * Recovery needs both; calling migrate then decode used to hydrate everything twice.
 * Neither result shares objects with the caller, nor snapshot objects with each other. */
export async function decodePartitionDocument(value, { maxHydratedBytes } = {}) {
  const doc = await loadPartition(value)
  if (maxHydratedBytes !== undefined) {
    check(Number.isSafeInteger(maxHydratedBytes) && maxHydratedBytes > 0, 'limits', 'invalid_hydration_limit')
    check(estimateHydratedPartitionBytes(doc) <= maxHydratedBytes, 'snapshots', 'partition_hydration_limit')
  }
  return { partition: doc, domain: await hydrate(doc) }
}
export async function decodePartition(value, options) {
  return (await decodePartitionDocument(value, options)).domain
}
export async function stringifyPartition(value) { return boundedJson(await migratePartition(value)) }
export async function parsePartition(text) {
  check(typeof text === 'string', '$', 'string_required')
  return migratePartition(text)
}
