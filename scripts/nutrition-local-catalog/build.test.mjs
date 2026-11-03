import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const execute = promisify(execFile)
import { gzipSync } from 'node:zlib'
import { fixture } from './fixtures.mjs'
import { build } from './build.mjs'
import { projectHuggingFace } from './huggingface.mjs'
const dir = fileURLToPath(new URL('.', import.meta.url)), base = path.join(dir, 'artifacts')
fs.mkdirSync(base, { recursive: true })
function setup(t) {
  const root = fs.mkdtempSync(path.join(base, 'tests-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true })) // Only this test's created workspace.
  const name = path.basename(root)
  return { root, async run(data, args = [], suffix = '.jsonl') {
    const file = path.join(root, 'input' + suffix); fs.writeFileSync(file, data)
    const options = { input: file, workspace: name, source: 'fixture', version: 'test-v1', format: 'jsonl' }
    for (let i=0; i<args.length; i++) {
      if (args[i] === '--skip-invalid') options.skipInvalid = true
      else options[args[i].slice(2)] = args[++i]
    }
    return build(options)
  }, async read(command, ...args) { return JSON.parse((await execute('python3', [path.join(dir, 'catalog.py'), '--workspace', name, command, ...args], { encoding: 'utf8', timeout: 10000 })).stdout) } }
}
const jsonl = rows => rows.map(r => JSON.stringify(r)+'\n').join('')

test('Hugging Face structs -> engine -> actual SQLite retain float32, nulls, ml and zeroes', async t => {
  const f = setup(t)
  const raw = projectHuggingFace({ code: '00012345', product_name: [{ lang: 'fr', text: 'Lait écrémé' }], nutrition_data_per: '100ml', nutriments: [{ name: 'energy-kcal', '100g': 35.5 }, { name: 'proteins', '100g': 0 }, { name: 'carbohydrates', '100g': 8.890000343322754 }, { name: 'fat', '100g': null }] })
  await f.run(jsonl([raw]))
  const actual = await f.read('barcode', '00012345')
  assert.deepEqual(actual.nutrients, { kcal: 35.5, protein: 0, carbs: 8.890000343322754, fat: null })
  assert.equal(actual.reference.unit, 'ml')
  assert.equal((await f.read('search', 'ecreme')).count, 1)
})

test('full raw JSONL -> actual normalizer -> durable SQLite -> query preserves decimals and units', async t => {
  const f = setup(t), expected = { ...fixture(2), code: '00012345' }
  const r = await f.run(jsonl([expected]))
  assert.equal(r.products, 1)
  assert.equal(r.temporaryStorage, 'workspace') // Import sort files must not fall back to /tmp tmpfs.
  const value = await f.read('barcode', expected.code)
  assert.equal(value.nutrients.protein, 3.2)
  assert.equal(value.nutrients.carbs, 4.8)
  assert.equal(value.reference.unit, 'ml')
  assert.ok(value.code.startsWith('0'))
  assert.equal((await f.read('search', 'lait')).products.length, 1)
})
test('bounded gzip input imports, records hash of decompressed content', async t => {
  const f = setup(t), body = jsonl([fixture(5)])
  const result = await f.run(gzipSync(body), [], '.jsonl.gz')
  assert.equal(result.inputBytes, Buffer.byteLength(body))
  assert.equal((await f.read('search', 'yaourt')).products.length, 1)
})
test('corrupt gzip CRC cannot publish a partially decoded catalogue', async t => {
  const f = setup(t)
  await f.run(jsonl([fixture(2)]))
  const before = fs.readFileSync(path.join(f.root, 'current.json'), 'utf8')
  const bad = gzipSync(jsonl([fixture(1)]))
  bad[bad.length-8] ^= 1
  await assert.rejects(f.run(bad, [], '.jsonl.gz'))
  assert.equal(fs.readFileSync(path.join(f.root, 'current.json'), 'utf8'), before)
})
test('country filtering is counted and does not alter selected products', async t => {
  const f = setup(t), other = { ...fixture(2), countries_tags: ['en:spain'] }
  const r = await f.run(jsonl([fixture(1), other]), ['--country', 'en:france'])
  assert.equal(r.filtered, 1)
  assert.equal(r.scanned, 2)
  assert.equal(r.products, 1)
})
test('malformed JSON and truncated input cannot replace a previous generation', async t => {
  const f = setup(t); await f.run(jsonl([fixture(2)]))
  const before = fs.readFileSync(path.join(f.root, 'current.json'), 'utf8')
  for (const invalid of [jsonl([fixture(1)])+'{bad}\n', jsonl([fixture(1)]).trimEnd()]) {
    await assert.rejects(f.run(invalid))
    assert.equal(fs.readFileSync(path.join(f.root, 'current.json'), 'utf8'), before)
  }
  assert.equal((await f.read('search', 'lait')).products.length, 1)
})
test('invalid product policy explicit, default failure versus counted skip', async t => {
  const f = setup(t), bad = { ...fixture(2), code: 'bad' }
  await assert.rejects(f.run(jsonl([fixture(1), bad])))
  const r = await f.run(jsonl([fixture(1), bad]), ['--skip-invalid'])
  assert.equal(r.rejected, 1)
  assert.equal(r.products, 1)
  assert.equal(r.reasons['invalid-barcode'], 1)
  await assert.rejects(f.run(jsonl([fixture(1)])+'{bad}\n', ['--skip-invalid']))
})
test('full TSV converter respects known ml and unknown reference, ignores private columns', async t => {
  const f = setup(t)
  const header = 'code\tproduct_name\tproduct_name_fr\tnutrition_data_per\tenergy-kcal_100g\tproteins_100g\tfat_100g\tcountries_tags\tprivate\n'
  const rows = '00012345\tLait\tLait\t100ml\t46.5\t3.2\t0\ten:france\tDO_NOT_STORE\n00012346\tBoisson\tBoisson\t\t46.5\t3.2\t\ten:france\tDO_NOT_STORE\n'
  const r = await f.run(header+rows, ['--format', 'tsv'])
  assert.equal(r.products, 2)
  const known = await f.read('barcode', '00012345'), unknown = await f.read('barcode', '00012346')
  assert.equal(known.nutrients.kcal, 46.5)
  assert.equal(known.nutrients.fat, 0)
  assert.equal(known.reference.unit, 'ml')
  assert.equal(unknown.reference, null)
  assert.equal(unknown.nutrients.kcal, null)
  assert.ok(!JSON.stringify(known).includes('DO_NOT_STORE'))
})
test('invalid TSV header/column count fails without publication', async t => {
  const f = setup(t)
  for (const raw of ['code\tcode\n1234\t1234\n', 'code\tproduct_name\n00012345\tPâtes\textra\n']) await assert.rejects(f.run(raw, ['--format', 'tsv']))
  assert.equal(fs.existsSync(path.join(f.root, 'current.json')), false)
})
test('duplicate provider identifiers are accepted only with identical content', async t => {
  const f = setup(t), raw = fixture(1)
  assert.equal((await f.run(jsonl([raw, raw]))).duplicates, 1)
  const before = fs.readFileSync(path.join(f.root, 'current.json'), 'utf8')
  await assert.rejects(f.run(jsonl([raw, { ...raw, product_name: 'Collision' }])))
  assert.equal(fs.readFileSync(path.join(f.root, 'current.json'), 'utf8'), before)
})
test('mismatched supplied source checksum cannot publish any received rows', async t => {
  const f = setup(t)
  await f.run(jsonl([fixture(2)]))
  const before = fs.readFileSync(path.join(f.root, 'current.json'), 'utf8')
  await assert.rejects(f.run(jsonl([fixture(1)]), ['--expected-input-sha256', '0'.repeat(64)]), /input-checksum-mismatch/)
  assert.equal(fs.readFileSync(path.join(f.root, 'current.json'), 'utf8'), before)
})

test('official-shaped TSV gzip streams literal names and quality errors into identity-only descriptors',async t=>{
  const f=setup(t)
  // Columns from current official exporter, synthetic values explicitly labelled.
  const header='code\tproduct_name\tbrands\tquantity\tserving_size\tserving_quantity\tproduct_quantity\tcountries_tags\tdata_quality_errors_tags\tenergy-kcal_100g\tproteins_100g\tcarbohydrates_100g\tfat_100g\tcreator\n'
  const rows='00012345\t"Literal synthetic name\tExample\t500 g\t30 g\t30\t500\ten:france\t\t6000\t3.125\t40\t2\tPRIVATE\n00012346\tSynthetic milk\tExample\t1 l\t200 ml\t200\t1000\ten:france\ten:nutrition-value-over-105\t42\t0\t10\t0\tPRIVATE\n'
  const r=await f.run(gzipSync(header+rows),['--format','tsv'],'.tsv.gz')
  assert.equal(r.products,2);assert.equal(r.rejected,0)
  for(const code of ['00012345','00012346']){const stored=await f.read('barcode',code);assert.equal(stored.reference,null);assert.ok(Object.values(stored.nutrients).every(v=>v===null));assert.ok(!JSON.stringify(stored).includes('PRIVATE'))}
  assert.equal((await f.read('barcode','00012345')).name,'"Literal synthetic name')
  assert.ok((await f.read('barcode','00012346')).warnings.includes('nutrition-rejected'))
})
