// Reproducible local-only benchmark. Each measurement runs in a fresh Node process so that
// a legacy full read's peak RSS cannot contaminate a targeted reader's memory measurement.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createNutritionLocalStore } from '../src/lib/nutrition/local-store.js'
import { nutritionFsBackend } from '../src/lib/nutrition/local-store-fs.js'
import { diskBridge } from '../src/lib/nutrition/local-storage.test-util.js'
import { encodePartition } from '../src/lib/nutrition/serialization.js'
import { createRecipeSnapshot } from '../src/lib/nutrition/recipe.js'
import { recipe, entry } from '../src/lib/nutrition/fixtures.test-util.js'
import { journal, namespace } from '../src/lib/nutrition/persistence.test-util.js'

const options = { namespace, generation: 'generation-1', deviceId: 'device-a' }
const script = fileURLToPath(import.meta.url), scenario = process.argv[2]
const mb = bytes => Math.round(bytes / 1024 / 1024 * 100) / 100
const storeFor = async disk => createNutritionLocalStore({ ...options,
  backend: nutritionFsBackend({ loadPlugin: async () => disk.plugin }) })
if (scenario === '--scenario') {
  const name = process.argv[3], disk = await diskBridge({ baseDirectory: process.argv[4] })
  const startMemory = process.memoryUsage(), opening = performance.now(), store = await storeFor(disk)
  const openMs = performance.now() - opening
  let warmMs = null
  if (name.endsWith('-hot')) {
    const warm = performance.now()
    await (name.startsWith('day') ? store.readDay('2026-10-10') : store.readMonth('2026-10'))
    warmMs = performance.now() - warm
  }
  globalThis.gc?.()
  const before = process.memoryUsage(), reads = disk.control.documentReads, start = performance.now()
  let result, count
  if (name === 'full' || name === 'baseline-day' || name === 'baseline-month') {
    const state = await store.read()
    const entries = state.domains.flatMap(domain => domain.records.foodEntries ?? [])
    result = name === 'baseline-day' ? entries.filter(row => row.d === '2026-10-10') :
      name === 'baseline-month' ? entries.filter(row => row.d.startsWith('2026-10')) : entries
    count = result.length
  } else if (name.startsWith('day')) { result = await store.readDay('2026-10-10'); count = result.entries.length }
  else if (name.startsWith('month')) { result = await store.readMonth('2026-10'); count = result.entries.length }
  else if (name === 'verify') { result = await store.verify(); count = result.records }
  else if (name === 'open') { result = await store.inspect(); count = 0 }
  else throw new Error(`Unknown benchmark scenario: ${name}`)
  const elapsedMs = performance.now() - start, after = process.memoryUsage()
  assert.equal(count, name === 'open' ? 0 : name.includes('day') ? 10 : name.includes('month') ? 300 : 36000)
  const report = { scenario: name, openMs, elapsedMs, warmMs, records: count,
    documentReads: disk.control.documentReads - reads, cache: store.cacheStatus(),
    baselineRssMiB: mb(startMemory.rss), beforeHeapMiB: mb(before.heapUsed), afterHeapMiB: mb(after.heapUsed),
    endRssMiB: mb(after.rss), peakRssMiB: mb(process.resourceUsage().maxRSS * 1024) }
  // Keep the result alive through memory sampling, including complete reconstruction.
  assert.ok(result)
  store.close()
  if (process.argv[5]) await writeFile(process.argv[5], JSON.stringify(report) + '\n')
  else process.stdout.write(JSON.stringify(report) + '\n')
} else {
  const disk = await diskBridge(), report = { runtime: process.version, platform: process.platform,
    fixture: { months: 120, entries: 36000, recipes: 'one complete recurring recipe per partition' }, measurements: [] }
  let store
  try {
    process.stderr.write('Preparing 120 monthly partitions and 36,000 entries...\n')
    store = await storeFor(disk)
    const snapshot = createRecipeSnapshot(recipe()), partitions = []
    for (let i = 0; i < 120; i++) {
      const month = `${2017 + Math.floor(i / 12)}-${String(i % 12 + 1).padStart(2, '0')}`
      const end = new Date(`${month}-01T00:00:00Z`); end.setUTCMonth(end.getUTCMonth() + 1); end.setUTCDate(0)
      const rows = Array.from({ length: 300 }, (_, j) => entry({ id: `${month}-${j}`,
        d: `${month}-${String(j % end.getUTCDate() + 1).padStart(2, '0')}`, snapshot, quantity: { amount: 0.5, unit: 'serving' } }))
      partitions.push(await encodePartition(journal({ id: `journal-${month}-device-a-0`, records: { foodEntries: rows } })))
    }
    await store.commit({ commitId: 'ten-year-fixture', partitions })
    partitions.length = 0
    store.close(); store = null; globalThis.gc?.()
    for (const name of ['open', 'day-cold', 'day-hot', 'month-cold', 'month-hot', 'verify', 'baseline-day', 'baseline-month', 'full']) {
      process.stderr.write(`Measuring ${name} in an isolated process...\n`)
      const resultPath = join(disk.control.base, `benchmark-${name}.json`)
      await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--expose-gc', script, '--scenario', name, disk.control.base, resultPath],
          { stdio: ['ignore', 'ignore', 'inherit'] })
        child.on('error', reject)
        child.on('close', code => {
          if (code !== 0) reject(new Error(`${name} failed (${code})`))
          else resolve()
        })
      })
      const measurement = JSON.parse(await readFile(resultPath, 'utf8'))
      report.measurements.push(measurement)
    }
    const output = scenario ?? '/tmp/opengym-nutrition-progressive-benchmark.json'
    await writeFile(output, JSON.stringify(report, null, 2) + '\n')
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    process.stderr.write(`Benchmark written to ${output}\n`)
  } finally { store?.close(); await disk.cleanup() }
}
