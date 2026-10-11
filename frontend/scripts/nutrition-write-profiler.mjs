// Optional Node-only instrumentation for the disposable benchmark. No production imports.
// Timings are inclusive/nested and diagnostic: sampling/uninstrumented runs establish latency.
import { registerHooks } from 'node:module'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'

const key = Symbol.for('opengym.nutrition.benchmark.stages')
globalThis[key] = { timings: {}, measure(name, work, asynchronous) {
  const started = performance.now()
  const done = () => {
    const row = this.timings[name] ??= { calls: 0, ms: 0 }
    row.calls++; row.ms += performance.now() - started
  }
  if (asynchronous) return (async () => { try { return await work() } finally { done() } })()
  try { return work() } finally { done() }
} }
const targets = {
  'api/nutrition/core/persistence-contract.js': ['canonicalJson', 'jsonClone', 'contentHash', 'sealDocument', 'verifiedDocument'],
  'api/nutrition/core/validate.js': ['validateJsonValue'],
  'api/nutrition/core/serialization.js': ['validateDomain', 'hydrate', 'encodePartition', 'decodePartition', 'decodePartitionDocument'],
  'api/nutrition/core/persistence-commit.js': ['prepareCommit', 'recoverCommit', 'assertPublishable'],
  'frontend/src/lib/nutrition/local-store.js': ['resolveRoot', 'readSnapshot'],
}
registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context)
  if (!url.startsWith('file:')) return result
  const path = fileURLToPath(url)
  // A diagnostic before-run can load captured pre-optimization modules without replacing
  // the working files. Only the explicitly captured relative paths can be overridden.
  const relative = path.slice(path.indexOf('/openGym/') + '/openGym/'.length)
  const saved = process.env.NUTRITION_BENCHMARK_BASELINE && `${process.env.NUTRITION_BENCHMARK_BASELINE}/${relative}`
  let source = saved && existsSync(saved) ? readFileSync(saved, 'utf8') : result.source?.toString()
  const names = process.env.NUTRITION_BENCHMARK_STAGES === '0' ? null : targets[relative]
  if (!source || !names) return saved && existsSync(saved) ? { ...result, source } : result
  for (const name of names) {
    const pattern = new RegExp(`(export )?(async )?function ${name}\\(`)
    const match = source.match(pattern)
    if (!match) continue // decodePartitionDocument is absent in the captured baseline.
    const exported = !!match[1], asynchronous = !!match[2], implementation = `__benchmark_${name}`
    source = source.replace(pattern, `${asynchronous ? 'async ' : ''}function ${implementation}(`)
    source += `\n${exported ? 'export ' : ''}function ${name}(...args) { return globalThis[Symbol.for('opengym.nutrition.benchmark.stages')].measure(${JSON.stringify(`${relative}:${name}`)}, () => ${implementation}(...args), ${asynchronous}) }\n`
  }
  return { ...result, source }
} })
