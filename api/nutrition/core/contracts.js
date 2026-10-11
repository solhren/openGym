// Nutrition's JSON contract. No persistence or UI here; callers own ids and edit stamps.
// Values are numbers (not form strings), energy is kcal, nutrients are grams.
export const NUTRITION_SCHEMA_VERSION = 1
export const NUTRIENTS = Object.freeze(['kcal', 'protein', 'carbs', 'fat', 'fiber', 'sugar', 'saturatedFat', 'sodium'])
export const MEALS = Object.freeze(['breakfast', 'lunch', 'dinner', 'snack'])
export const MASS_UNITS = Object.freeze({ mg: 0.001, g: 1, kg: 1000, oz: 28.349523125, lb: 453.59237 })
export const VOLUME_UNITS = Object.freeze({ ml: 1, cl: 10, dl: 100, l: 1000 })
export const QUANTITY_UNITS = Object.freeze([...Object.keys(MASS_UNITS), ...Object.keys(VOLUME_UNITS), 'portion', 'serving'])

/** @typedef {{kcal?: number|null, protein?: number|null, carbs?: number|null, fat?: number|null,
 * fiber?: number|null, sugar?: number|null, saturatedFat?: number|null, sodium?: number|null}} Nutrients */
/** @typedef {{amount: number, unit: 'mg'|'g'|'kg'|'oz'|'lb'|'ml'|'cl'|'dl'|'l'|'portion'|'serving', portionId?: string}} Quantity */
/** @typedef {{id: string, label: string, amount: number, unit: 'g'|'ml'}} Portion */
/** @typedef {{kind: 'custom'|'open-food-facts', externalId?: string, url?: string,
 * license?: {id: string, url: string, attribution: string}}} FoodSource */
/** @typedef {{schemaVersion: 1, kind: 'food', id: string, name: string, brand?: string,
 * reference: {amount: number, unit: 'g'|'ml'}, nutrients: Nutrients, portions: Portion[],
 * densityGPerMl?: number|null, source: FoodSource, defaultQuantity?: Quantity}} Food */
/** @typedef {{schemaVersion: 1, id: string, name: string,
 * ingredients: {id: string, food: Food, quantity: Quantity}[],
 * yield: {servings: number, grams?: number|null, ml?: number|null}}} Recipe */
/** @typedef {{schemaVersion: 1, kind: 'recipe', id: string, name: string,
 * reference: {amount: number, unit: 'serving'}, nutrients: Nutrients,
 * yield: {servings: number, grams?: number|null, ml?: number|null},
 * ingredientSources: {id: string, foodId: string, name: string, source: FoodSource}[]}} RecipeSnapshot */
/** @typedef {Food|RecipeSnapshot} NutritionSnapshot */
/** @typedef {{schemaVersion: 1, id: string, d: string, meal: string, mealId?: string|null,
 * snapshot: NutritionSnapshot, quantity: Quantity, consumedAt?: string|null,
 * timeZone?: string|null, note?: string, copiedFromEntryId?: string|null}} FoodEntry */
/** @typedef {{schemaVersion: 1, id: string, name: string,
 * items: {id: string, snapshot: NutritionSnapshot, quantity: Quantity}[]}} MealTemplate */
/** @typedef {{schemaVersion: 1, id: string, start: string, end?: string|null,
 * mode: 'custom'|'maintenance'|'bulk'|'cut', targets: Nutrients,
 * basis?: {weightKg?: number|null, maintenanceKcal?: number|null, energyAdjustmentKcal?: number|null}}} NutritionGoal */

export class NutritionValidationError extends Error {
  constructor(issues) {
    super(issues.map(i => `${i.path}: ${i.code}`).join('; '))
    this.name = 'NutritionValidationError'
    this.issues = issues
  }
}

export function assertValid(issues) {
  if (issues.length) throw new NutritionValidationError(issues)
}
