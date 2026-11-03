// Explicit local-file validation, not a representative benchmark. Tests every
// captured barcode against real read-only SQLite, including rejected identities.
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { validateEnvelope, classifyHuggingFace } from './huggingface.mjs'
const execute = promisify(execFile)
const [input, workspace, mode] = process.argv.slice(2)
if (!input || !/^[a-zA-Z0-9_-]{1,40}$/.test(workspace ?? '') || fs.statSync(input).size > 8*1024*1024 || (mode && mode !== '--retain-unusable-nutrition') || process.argv.length > 5) throw Error('invalid-audit-arguments')
const bytes = fs.readFileSync(input), envelope = validateEnvelope(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
const tool = fileURLToPath(new URL('./catalog.py', import.meta.url))
const records = [], rejected = [], recoveredNutrition = []
const metadata = { originalSha256: createHash('sha256').update(bytes).digest('hex'), source: 'https://huggingface.co/datasets/openfoodfacts/product-database', attribution: 'Open Food Facts contributors', license: 'ODbL-1.0', contentLicense: 'DbCL-1.0', representativeBenchmark: false, inputBytes: bytes.length, sourceRows: envelope.rows.length, sourceTotalReported: envelope.num_rows_total }
const query = async (command, ...args) => JSON.parse((await execute('python3', [tool, '--workspace', workspace, command, ...args], { maxBuffer: 256*1024, timeout: 10000 })).stdout)
const start = performance.now()
for (const item of envelope.rows) {
  let expected
  try {
    const result = await classifyHuggingFace(item.row, { retainUnusableNutrition: Boolean(mode) })
    expected = result.record
    if (result.originalError) recoveredNutrition.push({ rowIndex: item.row_idx, code: expected.code, reason: result.originalError })
  }
  catch (error) { rejected.push({ code: item.row.code, stage: error.code?.startsWith('hf-') ? 'projection' : 'normalization', reason: error.code }); assert.equal(await query('barcode', item.row.code), null); continue }
  const actual = await query('barcode', item.row.code)
  assert.deepEqual(actual, expected)
  assert.equal(actual.code, expected.code) // Engine canonical aliases; never numeric conversion.
  const nutrients = Object.fromEntries((item.row.nutriments ?? []).map(n => [n.name, n]))
  for (const [target, source] of [['kcal','energy-kcal'], ['protein','proteins'], ['carbs','carbohydrates'], ['fat','fat']]) {
    if (actual.reference && nutrients[source]?.['100g'] != null) assert.equal(actual.nutrients[target], nutrients[source]['100g'])
  }
  records.push({ rowIndex: item.row_idx, capturedCode: item.row.code, ...actual, sourceUrl: `https://world.openfoodfacts.org/product/${actual.code}` })
}
const searches = {}
for (const text of ['Nutella', 'Coca-Cola', 'lait', 'riz', 'pâtes', 'yaourt', 'pâte', 'pate', 'tartiner', 'Bovetti', 'dinde', 'framboise', 'croissant', 'herbal tea']) {
  const result = await query('search', text)
  searches[text] = { count: result.count, codes: result.products.map(p => p.code), names: result.products.map(p => p.nameFr || p.name) }
}
assert.deepEqual(searches['pâte'], searches.pate)
if (metadata.originalSha256 === '7d340dbe507a5256c45efafc60f3cb8312910f748dd9bff6c9272a8cd14e5be5') {
  assert.equal(searches.tartiner.count, 1)
  assert.equal(searches.dinde.count, 1)
  assert.ok(records.every(r => r.code === r.capturedCode))
}
console.log(JSON.stringify({ ...metadata, accepted: records.length, rejected, recoveredNutrition, completeFourNutrients: records.filter(r => Object.values(r.nutrients).every(v => v !== null)).length, partial: records.filter(r => Object.values(r.nutrients).some(v => v !== null) && Object.values(r.nutrients).some(v => v === null)).length, unusable: records.filter(r => Object.values(r.nutrients).every(v => v === null)).length, frenchNames: records.filter(r => r.nameFr).length, importedUnits: [...new Set(records.map(r => r.reference?.unit ?? null))], allBarcodesChecked: envelope.rows.length, searches, records, auditSecondsIncludingProcessStarts: (performance.now()-start)/1000 }, null, 2))
