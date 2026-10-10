import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { NutritionValidationError } from './contracts.js'
import { canonicalJson } from './persistence-contract.js'
import { entry, food, recipe } from './fixtures.test-util.js'
import { createRecipeSnapshot } from './recipe.js'

export const namespace = { serverOrigin: null, profileId: 'local-profile' }
export const stamp = (counter = 1) => ({ counter, deviceId: 'device-a' })
export const sync = (revision = 0) => ({ revision, writeId: revision ? `write-${revision}` : null, edits: [], tombstones: [] })
export const journal = (overrides = {}) => ({ id: 'journal-2026-10-device-a-0', kind: 'journal', namespace,
  generation: 'generation-1', records: { foodEntries: [entry()] }, sync: sync(), ...overrides })
export const library = (overrides = {}) => ({ id: 'library-device-a-0', kind: 'library', namespace,
  generation: 'generation-1', records: {
    customFoods: [food()], savedFoods: [], recipes: [recipe()],
    mealTemplates: [{ schemaVersion: 1, id: 'breakfast', name: 'Breakfast', items: [
      { id: 'item-a', snapshot: food(), quantity: { amount: 1, unit: 'portion', portionId: 'scoop' } },
      { id: 'item-b', snapshot: createRecipeSnapshot(recipe()), quantity: { amount: 0.5, unit: 'serving' } },
    ] }],
    nutritionGoals: [{ schemaVersion: 1, id: 'bulk', start: '2026-10-01', mode: 'bulk', targets: { kcal: 2700, protein: 140 } }],
    nutritionSettings: { quickEntry: true, unknownFutureSetting: { first: null } },
  }, sync: sync(), extensions: { imported: false }, ...overrides })

// Test-only resealing models structurally invalid but correctly checksummed imports.
// Node's independent SHA-256 also cross-checks the production Web Crypto implementation.
export function reseal(doc) {
  const { integrity: ignored, ...payload } = JSON.parse(JSON.stringify(doc))
  return { ...payload, integrity: { algorithm: 'sha256', digest: createHash('sha256').update(canonicalJson(payload)).digest('hex') } }
}
export function hasCode(code) {
  return error => {
    assert.ok(error instanceof NutritionValidationError)
    assert.ok(error.issues.some(issue => issue.code === code), `Expected ${code}: ${error.message}`)
    assert.ok(error.issues.every(issue => typeof issue.path === 'string'))
    return true
  }
}
