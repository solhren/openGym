import { NUTRITION_SCHEMA_VERSION, assertValid } from './contracts.js'
import { validateRecipe, validateSnapshot } from './validate.js'
import { nutrientsForQuantity, sumNutrients } from './calculate.js'

/** Batch nutrients, with the same missing-value accounting as a meal. Recipes contain foods,
 * not other recipes: no cycles, recursive resolution or external catalogue is needed. */
export function recipeNutrients(recipe) {
  assertValid(validateRecipe(recipe))
  return sumNutrients(recipe.ingredients.map(item => nutrientsForQuantity(item.food, item.quantity)))
}

/** Capture calculated batch values in an independent JSON snapshot. Cooked mass is the measured yield,
 * never the sum of raw ingredient weights (water can be gained or lost during cooking). */
export function createRecipeSnapshot(recipe) {
  const { totals } = recipeNutrients(recipe)
  const snapshot = {
    schemaVersion: NUTRITION_SCHEMA_VERSION,
    kind: 'recipe', id: recipe.id, name: recipe.name,
    reference: { amount: recipe.yield.servings, unit: 'serving' },
    nutrients: totals,
    yield: { servings: recipe.yield.servings, grams: recipe.yield.grams ?? null, ml: recipe.yield.ml ?? null },
    ingredientSources: recipe.ingredients.map(item => ({
      id: item.id, foodId: item.food.id, name: item.food.name,
      source: JSON.parse(JSON.stringify(item.food.source)),
    })),
  }
  assertValid(validateSnapshot(snapshot))
  return snapshot
}
