import { afterEach } from 'vitest'
import { createNutritionLocalStore } from './local-store.js'
import { nutritionIdbBackend } from './local-store-idb.js'
import { nutritionFsBackend } from './local-store-fs.js'
import { transactionalIdb, diskBridge } from './local-storage.test-util.js'
import { createNutritionSync } from './sync.js'
import { encodePartition } from './serialization.js'
import { fixture, scope, domain, entry } from '../../../../api/test/nutrition-fixtures.mjs'

const cleanups = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
export { scope, entry }
export const marker = (id = 'entry-a', counter = 1, deviceId = 'a', fields) => ({ collection: 'foodEntries', id,
  stamp: { counter, deviceId }, ...(fields ? { fields } : {}) })
export const markedDomain = (over = {}) => domain(0, { sync: { revision: 0, writeId: null,
  edits: [marker()], tombstones: [] }, ...over })
export function gate() {
  let release, enter
  const entered = new Promise(resolve => { enter = resolve }), released = new Promise(resolve => { release = resolve })
  return { entered, release, async wait() { enter(); await released } }
}
export async function environment() {
  const server = await fixture({ after: fn => cleanups.push(fn) })
  let tail = Promise.resolve()
  const calls = [], hooks = { before: null, after: null }
  const transport = async (path, options = {}) => {
    const call = { path, method: options.method ?? 'GET', body: options.body ? JSON.parse(options.body) : null }
    calls.push(call); await hooks.before?.(call)
    const work = async () => {
      if (path === '/api/me') return { user: { id: scope.namespace.profileId } }
      const url = new URL(path, scope.namespace.serverOrigin), digest = url.pathname.split('/').at(-1)
      if (url.pathname === '/api/nutrition/head') return server.store.head()
      if (url.pathname === '/api/nutrition/publications') return server.store.publish(call.body)
      if (url.pathname.includes('/partitions/')) return call.method === 'PUT' ? server.store.upload(digest, call.body) :
        server.store.partition(digest, url.searchParams.get('manifest'))
      if (url.pathname.includes('/manifests/')) return server.store.manifest(digest)
      throw Object.assign(new Error('unknown route'), { status: 404 })
    }
    const result = tail.then(work)
    tail = result.catch(() => {})
    let response
    try { response = JSON.parse(JSON.stringify(await result)) }
    catch (error) { throw Object.assign(new Error(error.code ?? error.message), { status: error.status,
      ...(error.status ? { data: { code: error.code, ...error.extra } } : {}) }) }
    await hooks.after?.(call, response)
    return response
  }
  let sequence = 0
  const client = async (device = 'a', kind = 'idb', idb = transactionalIdb()) => {
    const disk = kind === 'fs' ? await diskBridge() : null
    if (disk) cleanups.push(disk.cleanup)
    const options = { ...scope, deviceId: device }
    const backend = () => disk ? nutritionFsBackend({ loadPlugin: async () => disk.plugin }) : nutritionIdbBackend({ idb: idb.idb })
    let store = await createNutritionLocalStore({ ...options, backend: backend() })
    cleanups.push(() => store.close())
    const session = { value: { userId: scope.namespace.profileId, serverOrigin: scope.namespace.serverOrigin, epoch: 1 } }
    const makeSync = extra => createNutritionSync({ store, getSession: () => session.value, transport, newId: () => `${device}-${++sequence}`, ...extra })
    return { get store() { return store }, idb, disk, session, makeSync,
      async reopen() { store.close(); store = await createNutritionLocalStore({ ...options, backend: backend() }); return store },
      async commit(part = markedDomain()) { return store.commit({ commitId: `edit-${device}-${++sequence}`, partitions: [await encodePartition(part)] }) },
      async edit(change, counter = 10) {
        const state = await store.read(), part = structuredClone(state.domains[0])
        const row = part.records.foodEntries[0], previous = part.sync.edits.find(m => m.id === row.id)
        change(row, part)
        part.sync = { ...part.sync, revision: part.sync.revision + 1, writeId: `edit-${device}-${++sequence}`,
          edits: part.records.foodEntries.length ? [{ ...previous, stamp: { counter, deviceId: device } }] : [],
          tombstones: part.records.foodEntries.length ? part.sync.tombstones : [marker(row.id, counter, device)] }
        return this.commit(part)
      },
    }
  }
  return { server, calls, hooks, transport, client }
}
