import { MOBILE } from '../mobile.js'
import { DEMO } from '../demo.js'
import { canonicalJson, check, contentHash, exactKeys, verifiedDocument } from './persistence-contract.js'
import { nutritionIdbBackend } from './local-store-idb.js'
import { nutritionFsBackend } from './local-store-fs.js'
import { nutritionLocalReader } from './local-reader.js'
import { remainingNutrients, sumFoodEntries } from './calculate.js'
import { goalForDay } from './ui-service.js'

const IDENTITY_SCOPE_DESCRIPTOR = { format: 'opengym-nutrition-installation-identity', storageVersion: 1 }

const emptySummary = isTrainingDay => ({
  hasData: false,
  hasGoal: false,
  consumedKcal: 0,
  targetKcal: null,
  remainingKcal: null,
  consumedProtein: 0,
  targetProtein: null,
  remainingProtein: null,
  isTrainingDay: !!isTrainingDay,
})

const isFoodEntry = entry =>
  entry.entryKind !== 'water' && !entry.snapshot?.source?.hydration && entry.snapshot?.id !== 'opengym-water'

function resolveTargets(goal, isTrainingDay) {
  if (!goal) return null
  const base = goal.targets ?? {}
  if (!isTrainingDay || !goal.trainingTargets) return base
  const merged = { ...base }
  for (const [key, value] of Object.entries(goal.trainingTargets)) {
    if (value != null) merged[key] = value
  }
  return merged
}

async function acquireBackend(scopeId, openBackend) {
  let backend
  if (openBackend) {
    backend = await openBackend(scopeId)
  } else {
    const isNative = MOBILE ? (await import('@capacitor/core')).Capacitor.isNativePlatform() : false
    backend = isNative ? nutritionFsBackend() : nutritionIdbBackend()
  }
  if (typeof backend?.open === 'function') {
    try {
      await backend.open(scopeId)
    } catch (error) {
      if (!error?.issues?.some(i => i.code === 'storage_already_open')) {
        try { backend.close?.() } catch { /* ignore close error */ }
        throw error
      }
    }
  }
  return backend
}

/**
 * Lightweight, read-only loader for today's Nutrition summary on Home.
 * Never creates an installation identity or triggers network sync.
 */
export async function readHomeNutritionSummary({
  date,
  user = null,
  isGuestMode = false,
  serverUrl = null,
  isTrainingDay = false,
  openBackend = undefined,
} = {}) {
  if (!user && !isGuestMode) return null
  if (!openBackend && !MOBILE && typeof globalThis.indexedDB === 'undefined') return null

  let scope
  if (user) {
    if (!user.id || !serverUrl) return null
    let serverOrigin
    try {
      serverOrigin = new URL(serverUrl).origin
    } catch {
      return null
    }
    scope = { namespace: { profileId: user.id, serverOrigin }, generation: 'generation-1' }
  } else {
    const identityScopeId = await contentHash(IDENTITY_SCOPE_DESCRIPTOR)
    const identityBackend = await acquireBackend(identityScopeId, openBackend)
    let profileId
    try {
      const headers = await identityBackend.headers()
      if (headers.root === null) return null
      const value = await verifiedDocument(headers.root, 'opengym-nutrition-installation-identity')
      exactKeys(value, ['format', 'storageVersion', 'profileId', 'deviceId', 'serverBindings', 'integrity'], 'identity',
        ['format', 'storageVersion', 'profileId', 'deviceId', 'integrity'])
      check([value.profileId, value.deviceId].every(v => typeof v === 'string' && /^[a-f0-9]{32}$/.test(v)), 'identity', 'invalid_local_identity')
      profileId = value.profileId
    } finally {
      identityBackend.close()
    }
    scope = { namespace: { profileId: `${DEMO ? 'demo' : 'local'}-${profileId}`, serverOrigin: null }, generation: 'generation-1' }
  }

  const scopeId = await contentHash(scope)
  const backend = await acquireBackend(scopeId, openBackend)
  let closed = false
  const assertOpen = () => check(!closed, 'storage', 'storage_closed')
  try {
    const reader = nutritionLocalReader({ backend, scope, assertOpen })
    const inspected = await reader.inspect()
    if (inspected.status === 'empty' || inspected.status === 'recovery-required') {
      return emptySummary(isTrainingDay)
    }
    let library, day
    for (let attempt = 0; attempt < 3; attempt++) {
      library = await reader.library()
      if (library.status === 'empty' || library.status === 'recovery-required') {
        return emptySummary(isTrainingDay)
      }
      day = await reader.period({ start: date, end: date })
      if (day.status === 'empty' || day.status === 'recovery-required') {
        return emptySummary(isTrainingDay)
      }
      if (canonicalJson(library.head) === canonicalJson(day.head)) break
      check(attempt < 2, 'read', 'stale_root')
    }
    const foodEntries = day.entries.filter(isFoodEntry)
    const sum = sumFoodEntries(foodEntries)
    const goals = library.domains.flatMap(domain => domain.records.nutritionGoals ?? [])
    const { goal, overlapping } = goalForDay(goals, date)
    const resolvedTargets = resolveTargets(goal, !!isTrainingDay)
    const remaining = resolvedTargets ? remainingNutrients(sum.totals, resolvedTargets) : null
    return {
      hasData: true,
      hasGoal: !!goal && !overlapping,
      overlapping,
      goalMode: goal?.mode ?? null,
      consumedKcal: sum.totals.kcal,
      targetKcal: resolvedTargets?.kcal ?? null,
      remainingKcal: remaining?.kcal ?? null,
      consumedProtein: sum.totals.protein,
      targetProtein: resolvedTargets?.protein ?? null,
      remainingProtein: remaining?.protein ?? null,
      entryCount: foodEntries.length,
      isTrainingDay: !!isTrainingDay,
    }
  } finally {
    closed = true
    backend.close()
  }
}
