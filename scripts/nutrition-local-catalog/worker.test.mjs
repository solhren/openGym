import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { once } from 'node:events'
import { CatalogWorker } from './worker-client.mjs'
import { fixture } from './fixtures.mjs'
import { build } from './build.mjs'
const execute = promisify(execFile)
const base = fileURLToPath(new URL('./artifacts/', import.meta.url))
const script = fileURLToPath(new URL('./catalog.py', import.meta.url))
async function setup(t, options) {
  fs.mkdirSync(base, { recursive: true })
  const root = fs.mkdtempSync(path.join(base, 'worker-test-')), workspace = path.basename(root)
  const source = path.join(root, 'input.jsonl')
  const write = async (rows = [fixture(2)]) => { fs.writeFileSync(source, rows.map(r => JSON.stringify(r)+'\n').join('')); return build({ workspace, input: source, source: 'fixture', version: 'worker-test-v1', format: 'jsonl' }) }
  await write()
  const worker = new CatalogWorker(workspace, options)
  t.after(async () => { await worker.close(); fs.rmSync(root, { recursive: true, force: true }) })
  return { worker, write, root, workspace }
}
const search = worker => worker.request('search', { query: 'lait', page: 1, pageSize: 20 })
test('integrity startup has a bounded separate deadline; warm requests keep the normal deadline', async t => {
  const { worker } = await setup(t, { timeoutMs: 150, startupTimeoutMs: 1200,
    spawnProcess() { return spawn('python3', ['-u','-c', 'import sys,time,json;\nfor i,line in enumerate(sys.stdin):\n time.sleep(0.35); msg=json.loads(line); print(json.dumps(dict(v=1,id=msg["id"],ok=True,result={})),flush=True)'], { stdio:['pipe','pipe','pipe'] }) } })
  assert.deepEqual(await worker.request('inspect'), {})
  await assert.rejects(worker.request('inspect'), { code:'worker-timeout' })
  await once(worker.child, 'close')
  assert.deepEqual(await worker.request('inspect'), {})
  assert.throws(() => new CatalogWorker('trial', { startupTimeoutMs: 90001 }), {code:'invalid-worker-options'})
})
test('real Python persistent worker serializes concurrent requests and stays read-only', async t => {
  const { worker } = await setup(t)
  const results = await Promise.all([search(worker), search(worker), worker.request('barcode', { code: fixture(2).code })])
  assert.equal(results[0].count, 1); assert.equal(results[2].nutrients.protein, 3.2)
  assert.equal(worker.starts.length, 1)
  await assert.rejects(worker.request('build'), { code: 'invalid-worker-request' })
  await assert.rejects(worker.request('search', { query: 'x', page: 1, pageSize: 21 }))
  assert.equal((await search(worker)).count, 1)
})
test('publication and rollback switch validated reader; corrupt manifest fails closed', async t => {
  const { worker, write, root, workspace } = await setup(t)
  const old = (await search(worker)).catalogueVersion
  await write([fixture(2), fixture(8)])
  assert.equal((await search(worker)).count, 2)
  await execute('python3', [script, '--workspace', workspace, 'rollback'])
  assert.equal((await search(worker)).catalogueVersion, old)
  const manifest = fs.readFileSync(path.join(root, 'current.json'))
  fs.writeFileSync(path.join(root, 'current.json'), '{bad}\n')
  await assert.rejects(search(worker))
  fs.writeFileSync(path.join(root, 'current.json'), manifest)
  assert.equal((await search(worker)).count, 1)
})
test('missing database is unavailable, never an empty successful search', async t => {
  const { worker, root } = await setup(t)
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'current.json')))
  fs.renameSync(path.join(root, manifest.file), path.join(root, manifest.file+'.test-hold'))
  await assert.rejects(search(worker), { code: 'missing-or-unsafe-generation' })
})
test('SIGKILL releases worker and next read restarts without replaying failed mutation', async t => {
  const { worker } = await setup(t)
  await search(worker)
  const ended = once(worker.child, 'close'); worker.child.kill('SIGKILL'); await ended
  assert.equal((await search(worker)).count, 1)
  assert.equal(worker.starts.length, 2)
})
test('timeout kills real hung child; queued read starts only after its exit', async t => {
  let calls = 0
  const { worker } = await setup(t, { timeoutMs: 500, spawnProcess(...args) { return ++calls === 1 ? spawn('python3', ['-u', '-c', 'import time; time.sleep(5)'], { stdio: ['pipe','pipe','pipe'] }) : spawn(...args) } })
  const first = assert.rejects(search(worker), { code: 'worker-timeout' })
  await new Promise(resolve=>setTimeout(resolve,200))
  const second = search(worker)
  await first; assert.equal((await second).count, 1)
})
test('cancelled queued reads are removed and active cancellation drains safely', async t => {
  const {worker}=await setup(t)
  await search(worker)
  const active=new AbortController(),queued=new AbortController()
  const first=worker.request('inspect',{}, {signal:active.signal})
  const second=worker.request('inspect',{}, {signal:queued.signal})
  queued.abort();active.abort()
  await assert.rejects(first,{code:'worker-cancelled'});await assert.rejects(second,{code:'worker-cancelled'})
  assert.equal(worker.queue.length,0)
  assert.equal((await search(worker)).count,1)
})
test('bounded queue, unsafe arguments and close reject pending work', async t => {
  const { worker } = await setup(t, { spawnProcess() { return spawn('python3', ['-u','-c','import time; time.sleep(5)'], { stdio: ['pipe','pipe','pipe'] }) } })
  const pending = Array.from({ length: 17 }, () => assert.rejects(search(worker), { code: 'worker-closed' }))
  await assert.rejects(search(worker), { code: 'worker-busy' })
  await assert.rejects(worker.request('search', { query: 'x'.repeat(5000) }))
  await worker.close(); await Promise.all(pending)
  await assert.rejects(search(worker), { code: 'worker-closed' })
})
test('wrong response id and restart storm are bounded with real bad child', async t => {
  const { worker } = await setup(t, { spawnProcess() { return spawn('python3', ['-u','-c', 'import sys;sys.stdin.readline();print(\'{"v":1,"id":999,"ok":true,"result":{}}\');sys.stdin.read()'], { stdio: ['pipe','pipe','pipe'] }) } })
  for (let i=0; i<3; i++) await assert.rejects(search(worker), { code: 'worker-invalid-response' })
  await assert.rejects(search(worker), { code: 'worker-restart-limited' })
})
test('large protocol responses can span pipe chunks without being treated as corrupt', async t => {
  const { worker, write } = await setup(t)
  await write(Array.from({ length: 20 }, (_, i) => ({ ...fixture(i*6+2), countries_tags: Array.from({ length: 90 }, (_, n) => 'en:'+'x'.repeat(55)+n) })))
  const result = await search(worker)
  assert.equal(result.products.length, 20)
  assert.ok(Buffer.byteLength(JSON.stringify(result)) > 65536)
})
test('malformed, scalar, poison and oversized worker responses never crash the supervisor', async t => {
  for (const wire of ['null\n', '{bad}\n', '{"v":1,"id":1,"ok":true,"result":{"__proto__":{}}}\n', 'x'.repeat(256*1024+1)]) {
    const expression = wire.length > 256*1024 ? "'x'*262145" : JSON.stringify(wire)
    const f = await setup(t, { spawnProcess() { return spawn('python3', ['-u','-c', 'import sys;sys.stdin.readline();sys.stdout.write('+expression+');sys.stdout.flush();sys.stdin.read()'], { stdio: ['pipe','pipe','pipe'] }) } })
    await assert.rejects(search(f.worker), { code: 'worker-invalid-response' })
    await f.worker.close()
  }
})
test('development Docker source layout loads supervisor and queries a copied private fixture', async t => {
  const f=await setup(t), repository=fileURLToPath(new URL('../../',import.meta.url)), runtime=path.join(f.root,'layout')
  fs.mkdirSync(runtime); fs.writeFileSync(path.join(runtime,'package.json'),'{"type":"module"}')
  const files=['scripts/nutrition-local-catalog/catalog.py','scripts/nutrition-local-catalog/fuzzy.py','scripts/nutrition-local-catalog/worker.py','scripts/nutrition-local-catalog/worker-client.mjs','frontend/src/lib/nutrition/catalog/normalize.js','frontend/src/lib/nutrition/validate.js','frontend/src/lib/nutrition/persistence-contract.js','api/shared/sha256.js']
  for(const file of files) { fs.mkdirSync(path.dirname(path.join(runtime,file)),{recursive:true}); fs.copyFileSync(path.join(repository,file),path.join(runtime,file)) }
  fs.cpSync(path.join(repository,'api/nutrition/core'),path.join(runtime,'api/nutrition/core'),{recursive:true})
  const privateRoot=path.join(runtime,'scripts/nutrition-local-catalog/artifacts/trial'); fs.mkdirSync(privateRoot,{recursive:true})
  const manifest=JSON.parse(fs.readFileSync(path.join(f.root,'current.json')))
  for(const file of ['current.json',manifest.file]) fs.copyFileSync(path.join(f.root,file),path.join(privateRoot,file))
  const {CatalogWorker: PackagedWorker}=await import(pathToFileURL(path.join(runtime,'scripts/nutrition-local-catalog/worker-client.mjs')))
  const packaged=new PackagedWorker('trial')
  try { assert.equal((await search(packaged)).count,1) } finally { await packaged.close() }
})
