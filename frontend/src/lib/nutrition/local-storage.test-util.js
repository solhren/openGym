import { mkdtemp, mkdir, readdir, readFile, rename, open, unlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { manifestKey } from './local-contract.js'

// Transactional IDB model: isolated working copies, serialized transactions across connections,
// asynchronous requests, automatic commit and rollback on abort/quota. Not a browser substitute.
export function transactionalIdb() {
  const databases = new Map()
  const control = { databases, connections: [], failAt: null, operations: 0, options: [], documentReads: 0 }
  const idb = {
    open(name) {
      const request = {}
      queueMicrotask(() => {
        const fresh = !databases.has(name)
        if (fresh) databases.set(name, { stores: new Map(), tail: Promise.resolve() })
        const database = databases.get(name)
        let closed = false
        const transactions = new Set()
        const connection = {
          objectStoreNames: { contains: key => database.stores.has(key) },
          createObjectStore: key => database.stores.set(key, new Map()),
          close() { closed = true },
          forceClose() {
            closed = true
            for (const tx of transactions) {
              tx.error = Object.assign(new Error('connection forcibly closed'), { name: 'AbortError' }); tx.abort()
            }
            queueMicrotask(() => connection.onclose?.())
          },
          transaction(names, mode, options) {
            if (closed) throw new Error('connection closed')
            control.options.push(options)
            let active = true, started = false, scheduled = false, working
            const tasks = []
            const tx = { durability: control.durability ?? options.durability, error: null, abort() {
              if (!active) return
              active = false
              transactions.delete(tx)
              queueMicrotask(() => { tx.onabort?.(); release() })
            } }
            transactions.add(tx)
            let release
            const finished = new Promise(resolve => { release = resolve })
            const advance = () => {
              if (!started || scheduled || !active) return
              scheduled = true
              queueMicrotask(() => {
                scheduled = false
                if (!active) return
                const task = tasks.shift()
                if (task) {
                  try {
                    task.request.result = task.run()
                    if (active) task.request.onsuccess?.({ target: task.request })
                  } catch (error) { tx.error = error; tx.onerror?.(); tx.abort() }
                  advance()
                } else {
                  active = false
                  transactions.delete(tx)
                  if (mode === 'readwrite') database.stores = working
                  tx.oncomplete?.(); release()
                }
              })
            }
            const enqueue = run => {
              if (!active) throw new Error('TransactionInactiveError')
              const request = {}; tasks.push({ request, run }); advance(); return request
            }
            const mutation = run => () => {
              if (++control.operations === control.failAt) throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' })
              const result = run()
              control.afterMutation?.(connection)
              return result
            }
            tx.objectStore = key => ({
              get: id => enqueue(() => { if (key === 'documents') control.documentReads++; return structuredClone(working.get(key).get(id)) }),
              put: (value, id) => enqueue(mutation(() => working.get(key).set(id, structuredClone(value)))),
              delete: id => enqueue(mutation(() => working.get(key).delete(id))),
              openKeyCursor: () => tx.objectStore(key).openCursor(true),
              openCursor: (keyOnly = false) => {
                const request = {}
                let list, index = 0
                const step = () => {
                  tasks.push({ request, run: () => {
                    list ??= [...working.get(key).entries()]
                    return index < list.length ? { key: list[index][0], value: keyOnly ? undefined : structuredClone(list[index][1]),
                      continue: () => { index++; step() } } : null
                  } }); advance()
                }
                step(); return request
              },
            })
            const before = database.tail; database.tail = finished
            before.then(() => {
              working = new Map([...database.stores].map(([key, values]) => [key, new Map(values)]))
              started = true; advance()
            })
            return tx
          },
        }
        control.connections.push(connection)
        request.result = connection
        if (fresh) request.onupgradeneeded?.()
        request.onsuccess?.()
      })
      return request
    },
  }
  return { idb, control }
}

// Simulator of the native bridge protocol, using real temporary files and fsync/rename.
// Faults occur AFTER each durable phase (including after publication but before its response).
// OS-level Android/iOS locking and hardware durability still require device validation.
export async function diskBridge({ baseDirectory } = {}) {
  const base = baseDirectory ?? await mkdtemp(join(tmpdir(), 'opengym-nutrition-'))
  const control = { failAt: null, phases: 0, base, beforeCollect: null, documentReads: 0 }
  const queues = new Map()
  const lock = async (scope, work) => {
    const previous = queues.get(scope) ?? Promise.resolve()
    let release
    const next = new Promise(resolve => { release = resolve }); queues.set(scope, next)
    await previous
    try { const directory = join(base, scope); await mkdir(directory, { recursive: true }); return await work(directory) }
    finally { release() }
  }
  const read = async path => {
    if (/\/[pm]-[a-f0-9]{64}\.json$/.test(path)) control.documentReads++
    try { return new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path)) }
    catch (error) { if (error.code === 'ENOENT') return null; throw Object.assign(error, { code: 'IO_FAILED' }) }
  }
  const atomic = async (directory, name, text) => {
    const temporary = join(directory, randomUUID() + '.tmp')
    const handle = await open(temporary, 'wx', 0o600)
    try { await handle.writeFile(text); await handle.sync() } finally { await handle.close() }
    await rename(temporary, join(directory, name))
    const parent = await open(directory, 'r'); try { await parent.sync() } finally { await parent.close() }
    if (++control.phases === control.failAt) throw Object.assign(new Error('interruption'), { code: 'IO_FAILED' })
  }
  const plugin = {
    headers: ({ scope }) => lock(scope, async directory => {
      const root = await read(join(directory, 'root.json')), previous = await read(join(directory, 'previous.json'))
      const objects = []
      for (const key of new Set([manifestKey(root), manifestKey(previous)].filter(Boolean))) {
        const text = await read(join(directory, key + '.json'))
        if (text !== null) objects.push({ key, text })
      }
      let index = null
      try { index = await read(join(directory, 'index.json')) } catch { /* derived hint only */ }
      return { root, previous, index, objects,
        hasDocuments: (await readdir(directory)).some(name => /^[pm]-[a-f0-9]{64}\.json$/.test(name)) }
    }),
    readDocuments: ({ scope, expectedRoot, expectedPrevious, keys }) => lock(scope, async directory => {
      if (await read(join(directory, 'root.json')) !== expectedRoot || await read(join(directory, 'previous.json')) !== expectedPrevious) throw { code: 'STALE_ROOT' }
      const objects = []
      for (const key of keys) {
        const text = await read(join(directory, key + '.json'))
        if (text !== null) objects.push({ key, text })
      }
      return { objects }
    }),
    saveIndex: ({ scope, expectedRoot, expectedPrevious, index }) => lock(scope, async directory => {
      if (await read(join(directory, 'root.json')) !== expectedRoot || await read(join(directory, 'previous.json')) !== expectedPrevious) throw { code: 'STALE_ROOT' }
      await atomic(directory, 'index.json', index)
      return { saved: true }
    }),
    snapshot: ({ scope }) => lock(scope, async directory => ({ root: await read(join(directory, 'root.json')),
      previous: await read(join(directory, 'previous.json')), objects: await Promise.all(
        (await readdir(directory)).filter(name => /^[pm]-[a-f0-9]{64}\.json$/.test(name)).map(async name =>
          ({ key: name.slice(0, -5), text: await read(join(directory, name)) }))) })),
    publish: ({ scope, expectedRoot, root, writes }) => lock(scope, async directory => {
      const current = await read(join(directory, 'root.json'))
      if (current === root) return { repeated: true }
      if (current !== expectedRoot) throw { code: 'STALE_ROOT' }
      for (const row of writes) {
        const existing = await read(join(directory, row.key + '.json'))
        if (existing !== null && existing !== row.text) throw { code: 'INTEGRITY_CONFLICT' }
        if (existing === null) await atomic(directory, row.key + '.json', row.text)
      }
      if (current !== null) await atomic(directory, 'previous.json', current)
      await atomic(directory, 'root.json', root)
      return { repeated: false }
    }),
    collect: async input => {
      await control.beforeCollect?.()
      return lock(input.scope, async directory => {
        if (await read(join(directory, 'root.json')) !== input.expectedRoot ||
          await read(join(directory, 'previous.json')) !== input.expectedPrevious) throw { code: 'STALE_ROOT' }
        for (const key of input.keys) await unlink(join(directory, key + '.json'))
        for (const name of await readdir(directory)) if (name.endsWith('.tmp')) await unlink(join(directory, name))
        return { deleted: input.keys.length }
      })
    },
  }
  return { plugin, control, cleanup: () => baseDirectory ? Promise.resolve() : rm(base, { recursive: true, force: true }) }
}
