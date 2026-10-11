import assert from 'node:assert/strict'
import { test } from 'vitest'
import { performance } from 'node:perf_hooks'
import { backupFixture } from './backup.test-util.js'
import { tenYearBackupFixture } from './backup-volume.test-util.js'
import { readNutritionBackup } from './backup.js'

const mb = bytes => Math.round(bytes / 1048576 * 100) / 100
test('ten-year recipe history exports, validates, previews and restores with bounded progressive reads', async () => {
  const a = await backupFixture('fs'), b = await backupFixture('fs')
  const corpus = await tenYearBackupFixture(a.store), count = corpus.entries
  const metrics = {}, startMemory = process.memoryUsage(), serviceA = a.service()
  const measure = async (name, operation) => {
    const before = performance.now(), value = await operation()
    metrics[name] = { ms: Math.round((performance.now() - before) * 100) / 100, heapUsedMiB: mb(process.memoryUsage().heapUsed), rssMiB: mb(process.memoryUsage().rss) }
    return value
  }
  const output = await measure('export', () => serviceA.export())
  const read = await measure('validation', () => readNutritionBackup(output.blob))
  assert.equal(read.manifest.sections.nutrition.counts.foodEntries, count); assert.equal(read.retained.length, 1)
  const serviceB = b.service(), preview = await measure('preparationIncludingValidation', () => serviceB.preview(output.blob, { restoreId: 'ten-years', mode: 'empty' }))
  assert.equal(preview.applicable, true); await measure('restore', () => serviceB.restore(preview))
  const verification = await measure('completeVerification', () => b.store.verify()); assert.equal(verification.records, count)
  assert.equal((await b.store.readDay('2025-12-01')).entries.length, 3)
  assert.equal((await b.store.read()).domains.some(p => p.extensions?.nutritionSyncConflicts), true)
  assert.equal((await a.store.read()).pendingOperations.length, 2)
  console.info(JSON.stringify({ nutritionBackupVolume: { ...corpus, bytes: output.bytes,
    initialHeapMiB: mb(startMemory.heapUsed), peakProcessRssMiB: mb(process.resourceUsage().maxRSS * 1024), metrics,
    environment: `${process.version} Linux; Vitest; real temporary JSON/fsync/rename, simulated native bridge; no forced GC; process-wide memory` } }))
}, 300000)
