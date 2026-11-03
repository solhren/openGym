// Disposable disk corpus; no provider requests or production/profile storage.
import { performance } from 'node:perf_hooks'
import { platform, arch, cpus } from 'node:os'
import { createNutritionLocalStore } from '../src/lib/nutrition/local-store.js'
import { nutritionFsBackend } from '../src/lib/nutrition/local-store-fs.js'
import { diskBridge } from '../src/lib/nutrition/local-storage.test-util.js'
import { namespace } from '../src/lib/nutrition/persistence.test-util.js'
import { tenYearBackupFixture } from '../src/lib/nutrition/backup-volume.test-util.js'
import { createNutritionUISession } from '../src/lib/nutrition/ui-session.js'
import { normalizeProduct } from '../src/lib/nutrition/catalog/normalize.js'
import { offProduct, response } from '../src/lib/nutrition/catalog/fixtures.test-util.js'
const disk = await diskBridge(), rows = []; let store, ui, requests = 0
const measure = async (name, fn) => {
  globalThis.gc?.(); const start = performance.now(), before = process.memoryUsage(), reads = disk.control.documentReads
  const result = await fn(), after = process.memoryUsage()
  rows.push({ name, ms: +(performance.now() - start).toFixed(2), reads: disk.control.documentReads - reads,
    heapBeforeMiB: +(before.heapUsed / 1048576).toFixed(2), heapAfterMiB: +(after.heapUsed / 1048576).toFixed(2), rssAfterMiB: +(after.rss / 1048576).toFixed(2) }); return result
}
try {
  store = await createNutritionLocalStore({ namespace, generation: 'generation-1', deviceId: 'catalog-benchmark', backend: nutritionFsBackend({ loadPlugin: async () => disk.plugin }) })
  const corpus = process.env.NUTRITION_CATALOG_TEN_YEARS === '1' ? await tenYearBackupFixture(store) : null
  const products = Array.from({ length: 20 }, (_, i) => offProduct({ code: `301762042${String(i).padStart(4, '0')}` }))
  const payload = { count: 20, products }, bytes = new TextEncoder().encode(JSON.stringify(payload)).length
  const session = { userId: namespace.profileId, serverOrigin: namespace.serverOrigin, epoch: 1 }
  ui = createNutritionUISession({ store, session, getSession: () => session, online: () => false,
    catalogLimiter: { reserve: async () => {}, block() {} }, catalogTransport: async () => { requests++; return response(payload) } })
  const food = await measure('normalize one product', async () => (await normalizeProduct(offProduct())).food)
  const found = await measure('parse/normalize 20 product search (zero network latency)', () => ui.catalog.search('hazelnut'))
  await measure('same cached search', () => ui.catalog.search('hazelnut'))
  const row = { schemaVersion: 1, id: 'catalog-benchmark-entry', d: '2025-12-20', meal: 'lunch', snapshot: food, quantity: { amount: 50, unit: 'g' } }
  await measure('durable product + intake publication', () => ui.batch([{ collection: 'savedFoods', id: food.id, value: food, base: null }, { collection: 'foodEntries', id: row.id, value: row, base: null }]))
  await measure('selected day reload', () => ui.day(row.d))
  console.log(JSON.stringify({ environment: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model }, corpus, responseBytes: bytes, requests, results: found.products.length, cache: ui.catalog.cacheInfo(), measurements: rows }, null, 2))
} finally { ui?.close(); store?.close(); await disk.cleanup() }
