// Curated OFF-shaped fixtures. Tests never require Internet.
export const offProduct = (extra = {}) => ({ code: '3017620422003', product_name: 'Hazelnut spread', product_name_fr: 'Pâte à tartiner', brands: 'Example', nutrition_data_per: '100g',
  nutriments: { 'energy-kcal_100g': 539, proteins_100g: 6.3, carbohydrates_100g: 57.5, fat_100g: 30.9, sugars_100g: 56.3, 'saturated-fat_100g': 10.6, sodium_100g: .042 },
  serving_size: 'Spoon (15 g)', serving_quantity: 15, serving_quantity_unit: 'g', ...extra })
export const v3Product = (extra = {}) => offProduct({ nutriments: null, nutrition: { aggregated_set: { per: '100ml', preparation: 'as_sold', nutrients: { 'energy-kcal': { value: 46, source: 'packaging' }, proteins: { value: 3.2 }, carbohydrates: { value: 4.8 }, fat: { value: 1.5 } } } }, ...extra })
export const response = (value, status = 200, headers = {}) => ({ status, headers: { get: k => headers[k] ?? null }, text: async () => JSON.stringify(value) })
