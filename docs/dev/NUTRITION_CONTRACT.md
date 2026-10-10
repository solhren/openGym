# Nutrition data contract — step 1

The separate [step 2 persistence contract](NUTRITION_PERSISTENCE.md) now defines versioned
serialization and publication/recovery plans. It leaves these business models, calculations
and the existing profile storage unchanged; real storage and network adapters remain deferred.

This module defines JSON-shaped domain records and pure calculations. It is not wired into the
store, API, sync, screens, or external food services. No dependency was added and no wger code,
data, media, or test fixtures were copied. The concepts informed the design; the implementation
and synthetic examples are native to openGym.

The contract lives in `frontend/src/lib/nutrition/contracts.js`, runtime validation in
`validate.js`, calculations in `calculate.js`, and recipe calculations in `recipe.js`.
Records carry `schemaVersion: 1`. This is a domain version, not the profile's storage key or
server revision. Callers provide stable ids; these functions never create ids, read a clock,
write data, or attach sync stamps.

## Records

| Record | Required fields | Optional fields |
| --- | --- | --- |
| Food | `schemaVersion`, `kind: 'food'`, `id`, `name`, `reference`, `nutrients`, `portions`, `source` | `brand`, `densityGPerMl`, `defaultQuantity` |
| Quantity | Positive numeric `amount`, `unit` | `portionId`, required only with `unit: 'portion'` |
| Recipe | `schemaVersion`, `id`, `name`, nonempty `ingredients`, `yield` | Cooked grams/ml within `yield` |
| Recipe snapshot | `schemaVersion`, `kind: 'recipe'`, `id`, `name`, `reference`, `nutrients`, `yield`, `ingredientSources` | Cooked grams/ml within `yield` |
| Food entry | `schemaVersion`, `id`, `d`, `meal`, `snapshot`, `quantity` | `mealId`, `consumedAt`, `timeZone`, `note`, `copiedFromEntryId` |
| Meal template | `schemaVersion`, `id`, `name`, nonempty `items` | Future descriptive metadata |
| Nutrition goal | `schemaVersion`, `id`, `start`, `mode`, `targets` | `end`, `basis` |

A food reference is `{ amount, unit: 'g' | 'ml' }`. Values apply to that amount: 100 g is usual,
but a label providing values per 250 ml can be represented without inventing a density.
Nutrient keys are `kcal`, `protein`, `carbs`, `fat`, `fiber`, `sugar`, `saturatedFat`, `sodium`.
Energy is kcal; all other values are grams, including sodium. Salt is not sodium and needs an
explicit conversion in a future importer. Images have no place in these calculation records.

```js
const food = {
  schemaVersion: 1, kind: 'food', id: 'custom-oats', name: 'Oats',
  reference: { amount: 100, unit: 'g' },
  nutrients: { kcal: 380, protein: 13, carbs: 60, fat: 7 },
  portions: [{ id: 'scoop', label: 'Scoop', amount: 40, unit: 'g' }],
  source: { kind: 'custom' },
  defaultQuantity: { amount: 1, unit: 'portion', portionId: 'scoop' },
}
const entry = {
  schemaVersion: 1, id: 'entry-1', d: '2026-10-10', meal: 'breakfast',
  snapshot: structuredClone(food), quantity: { amount: 1.5, unit: 'portion', portionId: 'scoop' },
}
```

Food entries own their snapshot; a writer must copy a food before putting it into an entry.
Changes to catalogue foods, portions, or recipes must not silently update previous entries.
`createRecipeSnapshot` already produces an independent snapshot. It records the full batch's
nutrients with reference `{ amount: yield.servings, unit: 'serving' }`, and keeps each ingredient's
source and license attribution. The recipe definition keeps ingredient food snapshots and
quantities, with a unique id per ingredient row; the same food can appear in multiple rows.
Ingredients are foods only, so recipe cycles and unresolved nested references are excluded.

Meals are `breakfast`, `lunch`, `dinner`, `snack`. The explicit local day `d` is a valid
`YYYY-MM-DD` calendar date. `consumedAt`, if supplied, is an ISO timestamp with seconds, an
explicit UTC offset or `Z`, and optionally 1–3 fractional digits. `timeZone` is an optional
IANA time zone. Validation does not derive or change `d` from the timestamp, so travel or a
backdated entry does not move the meal to another day.

Goals have modes `custom`, `maintenance`, `bulk`, `cut`. `start` and optional `end` are inclusive
local days. At least one nonnegative target must be provided; missing targets remain unknown.
Optional `basis` holds `weightKg`, `maintenanceKcal`, and signed `energyAdjustmentKcal` to retain
the inputs used to choose targets. These are metadata, not a metabolic-rate formula. Selection
between overlapping goals and persistence of target changes belong to later stages.

## Calculations and validation

- Functions accept finite numbers, not strings from forms. `null` or an omitted nutrient is
  unknown; `0` is a real value. `normalizeNutrients` returns every key with explicit nulls.
- Validators return `{ path, code }[]`, suitable for future field-level feedback. They do not
  modify input, coerce values, or migrate versions. `assertValid` and calculation functions throw
  `NutritionValidationError` for invalid data. Unknown extra metadata is tolerated only when
  it follows the same JSON data rules as the declared fields.
- Records and metadata use ordinary or null-prototype objects with own, enumerable data
  properties, and ordinary dense arrays with no extra properties. Custom prototypes, accessors,
  non-enumerable properties and symbol keys are rejected before reading business fields.
  JSON values are strings, booleans, finite numbers, null, arrays and such objects. Explicit
  `undefined`, functions, symbols, bigint, dates, maps, sets and boxed values are rejected rather
  than dropped or coerced by `JSON.stringify`. Omit an optional field instead of setting it to
  `undefined`; use null for an explicitly unknown nutrient.
- `validateJsonValue` returns structured `json_*` errors with the offending path. Ancestor
  references are rejected as cycles, while shared acyclic references are accepted. Validation
  never invokes getters or `toJSON` hooks and reports inspection failures as domain issues.
  Recipe validation checks all metadata and ingredient provenance before snapshot creation or
  source cloning, so invalid JSON produces `NutritionValidationError`, not a cloning `TypeError`.
- `validateNutrients` shares the nonnegative-number and subcomponent rules between foods,
  recipe ingredients, computed recipe nutrients and snapshots. Sugar cannot exceed known
  carbohydrates, nor saturated fat known fat. Individual gram nutrients cannot exceed a food's
  gram reference amount. This last bound remains specific to a food's mass reference. There is
  no equivalent gram cap on a ml reference and no forced energy/macro equality.
- Supported mass units: `mg`, `g`, `kg`, avoirdupois `oz`, `lb`. Supported volume units: `ml`,
  `cl`, `dl`, `l`. `oz` is a mass, never a fluid ounce. Cups, spoons and pieces must be defined
  as food-specific portions, not generic units with guessed regional sizes.
- A food portion stores `{ id, label, amount, unit: 'g' | 'ml' }`; consuming half a portion is
  allowed. Gram/ml conversion requires explicit `densityGPerMl`; 1 ml is never assumed to be 1 g.
- Recipe yield has positive `servings` (fractional counts allowed), optional positive cooked
  `grams` and/or `ml`. Calculation by mass or volume requires the corresponding measured yield.
  Ingredient weights are not used to guess cooked weight. Recipe quantities use `serving`,
  or a supported mass/volume unit; food quantities use mass/volume or named `portion`.
- `nutrientsForQuantity` scales declared nutrients by the consumed/reference ratio. It never
  substitutes reconstructed energy for declared kcal. kJ/kcal conversion uses 4.184.
- `sumNutrients` returns `totals`, `knownTotals`, `missing`, `count`. For each nutrient, `totals`
  is null if any item is unknown; `knownTotals` is explicitly a partial sum and `missing` counts
  affected items. An empty selection has zero totals and `count: 0`, distinct from logged zeros.
- `sumFoodEntries` validates entries and rejects duplicate ids before summing. Callers filter
  entries by day/meal; the calculator neither accesses the store nor chooses a date.
- `macroEnergy` uses 4/4/9 kcal per gram for protein/carbs/fat and percentages of that estimated
  energy. Unknown macros produce unknown percentages. Zero macro energy produces zero percentages.
  This estimate excludes fiber, alcohol, etc., and can differ from declared energy.
- `remainingNutrients` preserves unknown targets/intakes and returns negative exceedances.
- Arithmetic uses JavaScript numbers without intermediate display rounding. Overflow is rejected.
  UI formatting will round values at the display boundary.

## Later recipes, duplication and fast logging

Recipe math is already usable, but recipe CRUD and screens are intentionally deferred.
Adding a recipe to the journal uses `createRecipeSnapshot` and a quantity. Later edits to the
recipe definition will not affect that entry.

`mealId` can associate multiple entries with one meal occurrence, beyond the initial day/category
grouping. A later duplicate-meal action should copy snapshots and quantities, assign new entry
and meal ids, set the destination day/category, and record `copiedFromEntryId`. It must not carry
the originals' consumption timestamps or sync edit/deletion stamps. No duplication action is
implemented in this step.

`defaultQuantity` on foods and the recipe serving unit support quick entry. Recent foods and
previous quantities can be derived from journal entries. Meal templates store the same snapshot
and quantity shape as journal entries, without dates or consumption timestamps, so a later
"usual breakfast" shortcut will not require a second nutrition model. Default quantity updates
must not retroactively change logged quantities.

These contracts reserve future `customFoods`, `savedFoods`, `recipes`, `foodEntries`,
`mealTemplates`, `nutritionGoals`, `nutritionSettings` integration. No collection is added to
`S` yet. Sync merge/deletion registries, guest adoption, unknown-field preservation, reset,
import/export and storage quotas must be integrated and tested before enabling writes.
Quantity is one atomic value; each snapshot is another, so future field-level merging must
not combine half a quantity or half a historical nutrient reference from different devices.

External foods require source kind, external id, HTTP(S) source URL, license id/URL and
attribution. This records provenance; it does not certify a source's license or grant rights.
Recipe snapshots retain these notices. Custom foods do not imply a public redistribution
license. An actual OFF adapter, image licenses, additional datasets and public exports must
be reviewed independently in later stages.

## Initial volume estimate

Measured with `Buffer.byteLength(JSON.stringify(entry))` using the synthetic test fixtures:
415 bytes for a food entry and 554 bytes for an entry containing the two-ingredient recipe
snapshot. At ten entries per day, three years of these entries alone are approximately
4.33 MiB and 5.79 MiB respectively. These are examples, not capacity guarantees: long names,
external attributions, ingredient counts, sync stamps and the existing training history add
more bytes. Browser storage accounting also differs from UTF-8 payload sizes.

The current API body limit is 5 MiB. Before step 2 enables persistence, choose and test a bounded
serialization strategy (for example deduplicated immutable snapshots or separately transported
history partitions). Keep the domain records unchanged at the calculation boundary; the chosen
storage representation need not force a change in recipe or journal semantics. No storage or
sync limit is raised, and no history is truncated, in this step.

## Tests

The three adjacent `*.test.js` files use Vitest registration with Node's strict assertions.
They test conversions, fractional portions, missing values, invalid records, aggregation,
goals, cooked recipe yields, provenance, snapshots, and frozen inputs. Fixtures are synthetic.

```sh
cd frontend
npm test -- src/lib/nutrition
```

The module itself imports no React, browser globals, store, network client or dependencies.
It can also be loaded directly as Node ES modules. No API/Docker changes are included here.
