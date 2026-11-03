// Local IPC timings, not HTTP or a browser benchmark. Same bounded reader/queue.
import { performance } from 'node:perf_hooks'
import { CatalogWorker } from './worker-client.mjs'
const [workspace = 'bench50k-ranking', count = '30'] = process.argv.slice(2)
const iterations = Number(count)
if (!Number.isInteger(iterations) || iterations < 1 || iterations > 200) throw Error('invalid-benchmark-iterations')
const worker = new CatalogWorker(workspace)
const summary = times => { times.sort((a,b)=>a-b); return { meanMs: times.reduce((a,b)=>a+b,0)/times.length, p95Ms: times[Math.ceil(times.length*.95)-1], maxMs: times.at(-1) } }
const request = (query, page = 1) => worker.request('search', { query, page, pageSize: 20 })
try {
  const opening = performance.now(), manifest = await worker.request('inspect')
  const report = { sourceKind: manifest.source.kind, products: manifest.products, catalogueFormat: manifest.version, databaseBytes: manifest.bytes, iterations, coldStartupVerificationMs: performance.now()-opening, searches: {} }
  const queries = ['Nutella','Coca-Cola','lait','riz','pâtes','yaourt', ...(manifest.source.kind === 'fixture' ? [] : ['pâte','Bovetti','dinde','herbal tea'])]
  for (const query of queries) {
    const times=[]
    let result
    for(let i=0;i<iterations;i++) { const start=performance.now(); result = await request(query); times.push(performance.now()-start) }
    report.searches[query]={...summary(times), count: result.count, firstNames: result.products.slice(0,3).map(r=>r.nameFr||r.name)}
  }
  const first = (await request('lait')).products[0]?.code ?? '0000101209159'
  const times=[]
  for(let i=0;i<iterations;i++) { const start=performance.now(); await worker.request('barcode',{code:first}); times.push(performance.now()-start) }
  report.barcode=summary(times)
  const started=performance.now()
  const queued=await Promise.all(Array.from({length:4},async()=>{const start=performance.now();await request('lait');return performance.now()-start}))
  report.fourQueuedSearches={seconds:(performance.now()-started)/1000,...summary(queued)}
  report.nodePeakRssKiB=process.resourceUsage().maxRSS
  report.node=process.version
  console.log(JSON.stringify(report,null,2))
} finally { await worker.close() }
