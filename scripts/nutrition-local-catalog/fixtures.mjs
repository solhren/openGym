// Synthetic OFF-shaped data. Brand names/query vocabulary are test labels;
// declared nutrients are invented examples, never genuine product information.
import fs from 'node:fs'
import { once } from 'node:events'
const names = ['Nutella pâte à tartiner', 'Coca-Cola boisson', 'Lait demi-écrémé', 'Riz basmati', 'Pâtes complètes', 'Yaourt nature']
const brands = ['Ferrero exemple', 'Coca-Cola exemple', 'Laiterie exemple', 'Rizière exemple', 'Panzani exemple', 'Danone exemple']
export function fixture(index) {
  const category = index % names.length
  const incomplete = index % 10 === 0
  const liquid = category === 1 || category === 2
  return { code: String(index + 10000001).padStart(13, '0'), product_name: `${names[category]} série ${Math.floor(index / 6)}`, product_name_fr: names[category], brands: brands[category], countries_tags: ['en:france', 'en:belgium'], last_modified_t: 1700000000 + index,
    nutrition: { aggregated_set: { preparation: 'as_sold', per: liquid ? '100ml' : '100g', nutrients: incomplete ? {} : {
      'energy-kcal': { value: [530, 42, 46, 350, 355, 60][category] }, proteins: { value: [6, 0, 3.2, 7, 12, 4][category] }, carbohydrates: { value: [56, 10.6, 4.8, 78, 70, 5][category] }, fat: { value: [30, 0, 1.5, 1, 2, 3][category] } } } }, serving_size: liquid ? 'Verre (200 ml)' : 'Portion (30 g)', serving_quantity: liquid ? 200 : 30, serving_quantity_unit: liquid ? 'ml' : 'g' }
}
if (process.argv[1]?.endsWith('/fixtures.mjs')) {
  const [destination, countText = '120'] = process.argv.slice(2)
  const count = Number(countText)
  if (!destination || !Number.isSafeInteger(count) || count < 1 || count > 100000) throw Error('invalid-fixture-arguments')
  const file = fs.createWriteStream(destination, { flags: 'wx' })
  file.on('error', () => {})
  for (let i = 0; i < count; i++) if (!file.write(JSON.stringify(fixture(i)) + '\n')) await once(file, 'drain')
  file.end(); await once(file, 'finish')
  console.log(JSON.stringify({ fixture: true, products: count, bytes: fs.statSync(destination).size }))
}
