// Local-only measurements in separate processes. Every directory is created by this script;
// no development/production state or native application directory is read or changed.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createNutritionLocalStore } from '../src/lib/nutrition/local-store.js'
import { nutritionFsBackend } from '../src/lib/nutrition/local-store-fs.js'
import { diskBridge } from '../src/lib/nutrition/local-storage.test-util.js'
import { namespace } from '../src/lib/nutrition/persistence.test-util.js'
import { tenYearBackupFixture } from '../src/lib/nutrition/backup-volume.test-util.js'
import { createNutritionBackup, readNutritionBackup } from '../src/lib/nutrition/backup.js'
const script = fileURLToPath(import.meta.url), mb = b => Math.round(b / 1048576 * 100) / 100
const openStore = async directory => {
  const disk = await diskBridge({ baseDirectory: directory })
  return createNutritionLocalStore({ namespace, generation: 'generation-1', deviceId: 'target-device',
    backend: nutritionFsBackend({ loadPlugin: async () => disk.plugin }) })
}
if (process.argv[2] === '--scenario') {
  const scenario = process.argv[3], directory = process.argv[4]
  let store, service, file, preview
  if (scenario === 'export') { store = await openStore(join(directory, 'source')); service = createNutritionBackup({ store, getSession: () => ({ userId: namespace.profileId, serverOrigin: null, epoch: 1 }) }) }
  else {
    file = new Blob([await readFile(join(directory, 'backup.zip'))])
    if (scenario !== 'validation') {
      store = await openStore(join(directory, scenario)); service = createNutritionBackup({ store, getSession: () => ({ userId: namespace.profileId, serverOrigin: null, epoch: 1 }) })
      if (scenario === 'restore') preview = await service.preview(file, { restoreId: 'benchmark', mode: 'empty' })
    }
  }
  globalThis.gc?.()
  const before = process.memoryUsage(), start = performance.now()
  const result = scenario === 'export' ? await service.export() : scenario === 'validation' ? await readNutritionBackup(file) :
    scenario === 'preparation' ? await service.preview(file, { restoreId: 'benchmark', mode: 'empty' }) : await service.restore(preview)
  const elapsedMs = Math.round((performance.now() - start) * 100) / 100, after = process.memoryUsage()
  if (scenario === 'validation') assert.equal(result.manifest.sections.nutrition.counts.foodEntries, 10959)
  if (scenario === 'preparation') assert.equal(result.applicable, true)
  if (scenario === 'restore') assert.equal((await store.verify()).records, 10959)
  const report = { scenario, elapsedMs, beforeHeapMiB: mb(before.heapUsed), afterHeapMiB: mb(after.heapUsed),
    beforeRssMiB: mb(before.rss), afterRssMiB: mb(after.rss), peakProcessRssMiB: mb(process.resourceUsage().maxRSS * 1024) }
  store?.close()
  await writeFile(join(directory, `result-${scenario}.json`), JSON.stringify(report))
  console.log(JSON.stringify(report))
} else {
  const directory = await mkdtemp(join(tmpdir(), 'opengym-backup-benchmark-'))
  let store
  try {
    store = await openStore(join(directory, 'source')); const corpus = await tenYearBackupFixture(store)
    const exported = await createNutritionBackup({ store, getSession: () => ({ userId: namespace.profileId, serverOrigin: null, epoch: 1 }) }).export(); store.close()
    await writeFile(join(directory, 'backup.zip'), new Uint8Array(await exported.blob.arrayBuffer()))
    const results = []
    for (const scenario of ['export', 'validation', 'preparation', 'restore']) results.push(await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--expose-gc', script, '--scenario', scenario, directory], { stdio: ['ignore', 'pipe', 'pipe'] })
      let out = '', errors = ''; child.stdout.on('data', chunk => { out += chunk }); child.stderr.on('data', chunk => { errors += chunk })
      child.on('error', reject); child.on('exit', async code => {
        try { if (code !== 0) throw Error(errors || out || `scenario ${scenario} failed`)
          resolve(JSON.parse(await readFile(join(directory, `result-${scenario}.json`), 'utf8')))
        } catch (error) { reject(error) }
      })
    }))
    console.log(JSON.stringify({ corpus, bytes: exported.bytes, node: process.version, platform: process.platform,
      adapter: 'private JSON simulator with real fsync/rename; isolated Node process per operation; GC before measurement', results }, null, 2))
  } finally { store?.close(); await rm(directory, { recursive: true, force: true }) }
}
