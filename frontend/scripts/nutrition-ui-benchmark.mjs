// Uses only a disposable private JSON fixture; never opens application/user storage.
import { writeFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { Session } from 'node:inspector'
import { cpus, platform, release } from 'node:os'
import { diskBridge } from '../src/lib/nutrition/local-storage.test-util.js'
import { namespace } from '../src/lib/nutrition/persistence.test-util.js'
import { tenYearBackupFixture } from '../src/lib/nutrition/backup-volume.test-util.js'
import { createNutritionLocalStore } from '../src/lib/nutrition/local-store.js'
import { nutritionFsBackend } from '../src/lib/nutrition/local-store-fs.js'
import { createNutritionUISession } from '../src/lib/nutrition/ui-session.js'
import { fixture as serverFixture } from '../../api/test/nutrition-fixtures.mjs'
import { readNutritionView, daySummary } from '../src/lib/nutrition/ui-service.js'

const synchronize = process.env.NUTRITION_BENCHMARK_SYNC === '1'
const actualNamespace = synchronize ? { serverOrigin: 'https://gym.example.com', profileId: 'alice' } : namespace
const disk = await diskBridge(), results = [], options = { namespace: actualNamespace, generation: 'generation-1', deviceId: 'ui-benchmark' }
const cleanups = [], calls = []
const server = synchronize ? await serverFixture({ after: fn => cleanups.push(fn) }, { scope: { namespace: actualNamespace, generation: options.generation } }) : null
let online = false, sequence = 0
const transport = async (path, options = {}) => {
  const start = performance.now(), method = options.method ?? 'GET', url = new URL(path, actualNamespace.serverOrigin)
  const digest = url.pathname.split('/').at(-1), body = options.body ? JSON.parse(options.body) : null
  try {
    if (path === '/api/me') return { user: { id: actualNamespace.profileId } }
    if (url.pathname === '/api/nutrition/head') return await server.store.head()
    if (url.pathname === '/api/nutrition/publications') return await server.store.publish(body)
    if (url.pathname.includes('/partitions/')) return method === 'PUT' ? await server.store.upload(digest, body) : await server.store.partition(digest, url.searchParams.get('manifest'))
    if (url.pathname.includes('/manifests/')) return await server.store.manifest(digest)
    throw new Error('unknown benchmark route')
  } finally { calls.push({ method, path, ms: performance.now() - start }) }
}
let store, ui, reads = 0, timings = {}
const timed = (object, method, label = method) => {
  const original = object[method].bind(object)
  object[method] = async (...args) => {
    const start = performance.now()
    try { return await original(...args) }
    finally { const row = timings[label] ??= { calls: 0, ms: 0 }; row.calls++; row.ms += performance.now() - start }
  }
}
const profile = process.env.NUTRITION_CPU_PROFILE ? new Session() : null
const post = (method, params = {}) => new Promise((resolve, reject) => profile.post(method, params, (error, value) => error ? reject(error) : resolve(value)))
if (profile) { profile.connect(); await post('Profiler.enable'); await post('Profiler.setSamplingInterval', { interval: 1000 }) }
const open = async () => {
  const backend = nutritionFsBackend({ loadPlugin: async () => disk.plugin }), original = backend.readDocuments.bind(backend)
  backend.readDocuments = input => { reads += input.keys.length; return original(input) }
  for (const method of ['headers', 'snapshot', 'readDocuments', 'publish', 'saveIndex']) timed(backend, method, `backend.${method}`)
  store = await createNutritionLocalStore({ ...options, backend })
  for (const method of ['readForRestore', 'commit', 'inspect']) timed(store, method, `store.${method}`)
  const session = { userId: actualNamespace.profileId, serverOrigin: actualNamespace.serverOrigin, epoch: 1 }
  ui = createNutritionUISession({ store, session, getSession: () => session, transport, online: () => online, newId: () => `benchmark-${++sequence}` })
}
const measure = async (name, fn) => {
  globalThis.gc?.(); const before = process.memoryUsage(), start = performance.now(), initial = reads, initialPhysicalReads = disk.control.documentReads
  timings = {}
  const stages = globalThis[Symbol.for('opengym.nutrition.benchmark.stages')]
  if (stages) stages.timings = {}
  const profiled = profile && name.startsWith('one intentional')
  if (profiled) await post('Profiler.start')
  const value = await fn(), after = process.memoryUsage()
  if (profiled) { const { profile: cpu } = await post('Profiler.stop'); await writeFile(process.env.NUTRITION_CPU_PROFILE, JSON.stringify(cpu)) }
  results.push({ name, ms: +(performance.now() - start).toFixed(2), reads: reads - initial, physicalDocumentReads: disk.control.documentReads - initialPhysicalReads,
    heapBeforeMiB: +(before.heapUsed / 1048576).toFixed(2), heapAfterMiB: +(after.heapUsed / 1048576).toFixed(2),
    rssBeforeMiB: +(before.rss / 1048576).toFixed(2), rssAfterMiB: +(after.rss / 1048576).toFixed(2),
    ...(stages ? { stages: Object.fromEntries(Object.entries(stages.timings).map(([label, row]) => [label, { calls: row.calls, ms: +row.ms.toFixed(2) }])) } : {}),
    timings: Object.fromEntries(Object.entries(timings).map(([label, row]) => [label, { calls: row.calls, ms: +row.ms.toFixed(2) }])) })
  console.error(`${name}: ${results.at(-1).ms} ms`)
  return value
}
try {
  await open(); const corpus = await tenYearBackupFixture(store); ui.close(); await open()
  const sourceManifestDigest = (await store.inspect()).manifest.integrity.digest
  const view = await measure('cold day + library + engine indicators', async () => {
    const data = await readNutritionView(ui, { date: '2025-12-20' })
    daySummary(data.entries, [], '2025-12-20'); return data
  })
  await measure('warm day + library', () => readNutritionView(ui, { date: '2025-12-20' }))
  ui.close(); await open()
  await measure('cold month + library', () => readNutritionView(ui, { period: { start: '2025-12-01', end: '2025-12-31' } }))
  await measure('full graph verification including outbox', () => store.verify())
  await measure('one intentional entry edit (complete validation + publication)', () => ui.save('foodEntries', { ...view.entries[0], quantity: { amount: 2, unit: 'serving' } }, view.entries[0]))
  if (synchronize) {
    online = true
    const result = await measure('synchronization of both pending checkpoints (real isolated server, direct transport)', () => ui.synchronize())
    if (result.status !== 'synced' || (await store.inspect()).manifest.pendingOperations.length !== 0) throw new Error('benchmark synchronization failed')
  }
  const report = { sourceManifestDigest, syncTransport: synchronize ? { kind: 'direct service calls, no HTTP latency', requests: calls.length,
    uploads: calls.filter(c => c.method === 'PUT').length, publications: calls.filter(c => c.method === 'POST').length,
    serverCallMs: +calls.reduce((total, call) => total + call.ms, 0).toFixed(2) } : null, node: process.version, environment: { platform: platform(), release: release(), cpu: cpus()[0]?.model, cpus: cpus().length }, backend: 'temporary private JSON/fsync simulator', corpus, results,
    cache: store.cacheStatus(), processPeakRssMiB: +(process.resourceUsage().maxRSS / 1024).toFixed(2),
    limits: 'One process; peak includes fixture construction. Endpoint heap, not peak heap. reads counts readDocuments partition bodies only; physicalDocumentReads includes immutable p/m reads by headers, snapshot and publication; root/index files are excluded. Nested timings overlap. No React rendering/browser/native measurement.' }
  await writeFile(process.env.NUTRITION_BENCHMARK_OUTPUT ?? '/tmp/opengym-nutrition-ui-benchmark.json', JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally { profile?.disconnect(); ui?.close(); await disk.cleanup(); for (const cleanup of cleanups.reverse()) await cleanup() }
