import { MEALS, NUTRITION_SCHEMA_VERSION } from './contracts.js'
import { isNutritionDate, validateConsumption } from './validate.js'
import { check } from './persistence-contract.js'
import { nutrientsForQuantity } from './calculate.js'
import { createRecipeSnapshot } from './recipe.js'
import { newNutritionId, nutritionSearchText } from './ui-service.js'

export const DEFAULT_WATER_TARGET_ML = 2500

const WATER_ML_BY_UNIT = { ml: 1, cl: 10, dl: 100, l: 1000 }

export function isWaterEntry(entry) {
  return Boolean(
    entry && (
      entry.entryKind === 'water' ||
      entry.snapshot?.source?.hydration === true ||
      entry.snapshot?.id === 'opengym-water'
    )
  )
}

export function isQuickAddEntry(entry) {
  return Boolean(
    entry && (
      entry.entryKind === 'quick' ||
      entry.snapshot?.source?.quickAdd === true
    )
  )
}

export function createWaterSnapshot() {
  return {
    schemaVersion: NUTRITION_SCHEMA_VERSION,
    id: 'opengym-water',
    kind: 'food',
    name: 'Water',
    brand: '',
    reference: { amount: 100, unit: 'ml' },
    nutrients: {
      kcal: 0,
      protein: 0,
      carbs: 0,
      fat: 0,
      fiber: 0,
      sugar: 0,
      saturatedFat: 0,
      sodium: 0,
    },
    portions: [],
    source: { kind: 'custom', hydration: true },
  }
}

export function createWaterEntry({ id = newNutritionId(), date, ml, consumedAt = null } = {}) {
  check(isNutritionDate(date), 'water', 'invalid_date')
  const amount = Number(ml)
  check(ml !== null && ml !== '' && typeof ml !== 'boolean' && Number.isFinite(amount) && amount > 0, 'water', 'positive_number_required')
  return {
    schemaVersion: NUTRITION_SCHEMA_VERSION,
    id,
    d: date,
    meal: 'snack',
    entryKind: 'water',
    snapshot: createWaterSnapshot(),
    quantity: { amount, unit: 'ml' },
    ...(consumedAt != null ? { consumedAt } : {}),
    note: '',
  }
}

function waterEntryMl(entry) {
  const q = entry?.quantity
  if (!q || !Number.isFinite(q.amount) || q.amount <= 0) return 0
  if (Object.hasOwn(WATER_ML_BY_UNIT, q.unit)) return q.amount * WATER_ML_BY_UNIT[q.unit]
  if (q.unit === 'portion' && Array.isArray(entry.snapshot?.portions)) {
    const portion = entry.snapshot.portions.find(p => p?.id === q.portionId)
    if (portion && Number.isFinite(portion.amount) && Object.hasOwn(WATER_ML_BY_UNIT, portion.unit)) {
      return q.amount * portion.amount * WATER_ML_BY_UNIT[portion.unit]
    }
  }
  return 0
}

export function sumWaterEntries(entries = []) {
  const indexed = []
  Array.from(entries ?? []).forEach((entry, idx) => {
    if (isWaterEntry(entry)) indexed.push({ entry, idx })
  })
  indexed.sort((a, b) => {
    const dCmp = String(a.entry.d ?? '').localeCompare(String(b.entry.d ?? ''))
    if (dCmp !== 0) return dCmp
    if (a.entry.consumedAt && b.entry.consumedAt) {
      const tCmp = Date.parse(a.entry.consumedAt) - Date.parse(b.entry.consumedAt)
      if (Number.isFinite(tCmp) && tCmp !== 0) return tCmp
    }
    return a.idx - b.idx
  })
  const waterEntries = indexed.map(item => item.entry)
  const rawTotal = waterEntries.reduce((sum, e) => sum + waterEntryMl(e), 0)
  return {
    totalMl: Math.round(rawTotal * 100) / 100,
    entries: waterEntries,
  }
}

function optionalMacro(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  check(typeof v !== 'boolean' && Number.isFinite(n) && n >= 0, 'quickAdd', 'nonnegative_number_required')
  return n
}

export function createQuickAddEntry({
  id = newNutritionId(),
  existing = null,
  date,
  meal,
  name,
  kcal,
  protein = null,
  carbs = null,
  fat = null,
  fiber = null,
  note = '',
} = {}) {
  check(isNutritionDate(date), 'quickAdd', 'invalid_date')
  check(MEALS.includes(meal), 'quickAdd', 'unknown_meal')
  const kcalNum = Number(kcal)
  check(kcal !== null && kcal !== '' && typeof kcal !== 'boolean' && Number.isFinite(kcalNum) && kcalNum >= 0, 'quickAdd', 'nonnegative_number_required')

  const p = optionalMacro(protein)
  const c = optionalMacro(carbs)
  const fa = optionalMacro(fat)
  const fi = optionalMacro(fiber)

  const cleanName = String(name ?? '').trim() || 'Ajout rapide'
  const entryId = existing?.id ?? id
  const refGrams = Math.max(100, Math.ceil((p || 0) + (c || 0) + (fa || 0) + (fi || 0) + 1))

  const snapshot = {
    schemaVersion: NUTRITION_SCHEMA_VERSION,
    id: existing?.snapshot?.id || `quick-${entryId}`,
    kind: 'food',
    name: cleanName,
    brand: '',
    reference: { amount: refGrams, unit: 'g' },
    nutrients: {
      kcal: kcalNum,
      protein: p,
      carbs: c,
      fat: fa,
      fiber: fi,
      sugar: null,
      saturatedFat: null,
      sodium: null,
    },
    portions: [{ id: 'quick', label: '1×', amount: refGrams, unit: 'g' }],
    defaultQuantity: { amount: 1, unit: 'portion', portionId: 'quick' },
    source: { kind: 'custom', quickAdd: true },
  }

  return {
    ...(existing ?? {}),
    schemaVersion: NUTRITION_SCHEMA_VERSION,
    id: entryId,
    d: date,
    meal,
    entryKind: 'quick',
    snapshot,
    quantity: { amount: 1, unit: 'portion', portionId: 'quick' },
    note: note ?? '',
  }
}

export function buildMealCopyCommands({
  entries = [],
  sourceMeal = null,
  targetDate,
  targetMeal = null,
  idFactory = newNutritionId,
} = {}) {
  check(isNutritionDate(targetDate), 'copy', 'invalid_date')
  if (sourceMeal != null) check(MEALS.includes(sourceMeal), 'copy', 'unknown_meal')
  if (targetMeal != null) check(MEALS.includes(targetMeal), 'copy', 'unknown_meal')

  return Array.from(entries ?? [])
    .filter(e => e && !isWaterEntry(e) && (sourceMeal == null || e.meal === sourceMeal))
    .map(e => {
      const id = idFactory()
      return {
        collection: 'foodEntries',
        id,
        value: {
          schemaVersion: NUTRITION_SCHEMA_VERSION,
          id,
          d: targetDate,
          meal: targetMeal || e.meal,
          ...(e.entryKind ? { entryKind: e.entryKind } : {}),
          snapshot: structuredClone(e.snapshot),
          quantity: structuredClone(e.quantity),
          copiedFromEntryId: e.id,
          note: e.note ?? '',
        },
        base: null,
      }
    })
}

function defaultReferenceQuantity(snapshot) {
  return {
    amount: snapshot.kind === 'recipe' ? 1 : snapshot.reference.amount,
    unit: snapshot.kind === 'recipe' ? 'serving' : snapshot.reference.unit,
  }
}

function resolveSuggestedQuantity(snapshot, candidateQuantity) {
  for (const qty of [candidateQuantity, snapshot.defaultQuantity, defaultReferenceQuantity(snapshot)]) {
    if (!qty) continue
    try {
      if (validateConsumption(snapshot, qty).length > 0) continue
      nutrientsForQuantity(snapshot, qty)
      return structuredClone(qty)
    } catch {
      // Incompatible legacy quantity; fall through to defaultQuantity or reference.
    }
  }
  return defaultReferenceQuantity(snapshot)
}

function isBetterQuantityEntry(candidate, currentBest, targetMeal) {
  if (!currentBest) return true
  const dCmp = String(candidate.entry.d ?? '').localeCompare(String(currentBest.entry.d ?? ''))
  if (dCmp !== 0) return dCmp > 0
  const candSameMeal = candidate.entry.meal === targetMeal ? 1 : 0
  const bestSameMeal = currentBest.entry.meal === targetMeal ? 1 : 0
  if (candSameMeal !== bestSameMeal) return candSameMeal > bestSameMeal
  if (candidate.entry.consumedAt && currentBest.entry.consumedAt) {
    const tCmp = Date.parse(candidate.entry.consumedAt) - Date.parse(currentBest.entry.consumedAt)
    if (Number.isFinite(tCmp) && tCmp !== 0) return tCmp > 0
  }
  return candidate.idx >= currentBest.idx
}

export function rankMealCandidates({
  foods = [],
  recipes = [],
  recentEntries = [],
  todayEntries = [],
  meal = 'breakfast',
  query = '',
  locale = 'fr',
  referenceDate = null,
} = {}) {
  const byKey = new Map()

  for (const f of foods ?? []) {
    if (!f?.id) continue
    const snap = structuredClone(f)
    byKey.set(`food:${snap.id}`, { snapshot: snap, fromLibrary: true })
  }

  for (const r of recipes ?? []) {
    if (!r?.id) continue
    const snap = r.kind === 'recipe' && r.reference?.unit === 'serving'
      ? structuredClone(r)
      : createRecipeSnapshot(r)
    byKey.set(`recipe:${snap.id}`, { snapshot: snap, fromLibrary: true })
  }

  // Deduplicate combined recent + today entries by entry.id while preserving latest occurrence.
  const combinedMap = new Map()
  let autoSeq = 0
  for (const entry of [...(recentEntries ?? []), ...(todayEntries ?? [])]) {
    if (!entry || isWaterEntry(entry) || isQuickAddEntry(entry)) continue
    if (!entry.snapshot?.id || !['food', 'recipe'].includes(entry.snapshot.kind)) continue
    const mapKey = entry.id ? `id:${entry.id}` : `anon:${autoSeq++}`
    combinedMap.set(mapKey, entry)
  }

  const statsByKey = new Map()
  let maxLoggedDate = null
  let idx = 0

  for (const entry of combinedMap.values()) {
    const key = `${entry.snapshot.kind}:${entry.snapshot.id}`
    const d = isNutritionDate(entry.d) ? entry.d : null
    if (d && (!maxLoggedDate || d > maxLoggedDate)) maxLoggedDate = d

    let stats = statsByKey.get(key)
    if (!stats) {
      stats = { mealCount: 0, totalCount: 0, lastDate: null, bestQtyWrap: null, latestEntryWrap: null }
      statsByKey.set(key, stats)
    }

    stats.totalCount += 1
    if (entry.meal === meal) stats.mealCount += 1
    if (d && (!stats.lastDate || d > stats.lastDate)) stats.lastDate = d

    const wrapped = { entry, idx: idx++ }
    if (isBetterQuantityEntry(wrapped, stats.bestQtyWrap, meal)) {
      stats.bestQtyWrap = wrapped
    }
    if (!stats.latestEntryWrap || String(entry.d ?? '') >= String(stats.latestEntryWrap.entry.d ?? '')) {
      stats.latestEntryWrap = wrapped
    }

    if (!byKey.has(key)) {
      byKey.set(key, { snapshot: structuredClone(entry.snapshot), fromLibrary: false })
    } else if (!byKey.get(key).fromLibrary && stats.latestEntryWrap === wrapped) {
      byKey.set(key, { snapshot: structuredClone(entry.snapshot), fromLibrary: false })
    }
  }

  const refDate = isNutritionDate(referenceDate) ? referenceDate : maxLoggedDate
  const normQuery = nutritionSearchText(String(query ?? '').trim(), locale)
  const queryTokens = normQuery ? normQuery.split(/\s+/).filter(Boolean) : []

  const ranked = []

  for (const [key, { snapshot }] of byKey.entries()) {
    const normName = nutritionSearchText(String(snapshot.name ?? ''), locale)
    const normBrand = nutritionSearchText(String(snapshot.brand ?? ''), locale)
    const fullText = normBrand ? `${normName} ${normBrand}` : normName

    let prefixTier = 0
    if (normQuery) {
      const matches = fullText.includes(normQuery) || (queryTokens.length > 1 && queryTokens.every(t => fullText.includes(t)))
      if (!matches) continue
      if (normName.startsWith(normQuery)) prefixTier = 2
      else if (normName.split(/\s+/).some(w => w.startsWith(normQuery)) || (normBrand && normBrand.startsWith(normQuery))) prefixTier = 1
    }

    const stats = statsByKey.get(key)
    const mealCount = stats?.mealCount ?? 0
    const totalCount = stats?.totalCount ?? 0
    const lastDate = stats?.lastDate ?? null

    let recencyBonus = 0
    if (lastDate && refDate) {
      const daysAgo = Math.max(0, Math.round((Date.parse(`${refDate}T00:00:00Z`) - Date.parse(`${lastDate}T00:00:00Z`)) / 86400000))
      recencyBonus = Math.max(0, 25 - daysAgo) + 5 / (1 + daysAgo)
    }

    const habitScore = mealCount * 30 + totalCount * 10 + recencyBonus
    const suggestedQuantity = resolveSuggestedQuantity(snapshot, stats?.bestQtyWrap?.entry?.quantity ?? null)

    ranked.push({
      key,
      snapshot,
      suggestedQuantity,
      mealCount,
      totalCount,
      lastDate,
      isHabit: mealCount > 0 || totalCount > 0,
      _prefixTier: prefixTier,
      _habitScore: habitScore,
      _normName: normName,
    })
  }

  ranked.sort((a, b) => {
    if (normQuery && b._prefixTier !== a._prefixTier) return b._prefixTier - a._prefixTier
    if (b._habitScore !== a._habitScore) return b._habitScore - a._habitScore
    const nameCmp = a._normName.localeCompare(b._normName, locale)
    if (nameCmp !== 0) return nameCmp
    return a.key.localeCompare(b.key)
  })

  return ranked.map(({ _prefixTier, _habitScore, _normName, ...publicFields }) => publicFields)
}
