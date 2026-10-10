import { check, exactKeys, isText, jsonClone } from './persistence-contract.js'
import { capturePublication, captureRead, captureIndex, isDocumentKey, manifestKey, storageError } from './local-contract.js'

// One database per hashed (server origin, profile, generation). IDB serializes readwrite
// transactions across connections/tabs; comparison, objects, outbox and head share one tx.
export function nutritionIdbBackend({ idb = globalThis.indexedDB } = {}) {
  let db, opening = false, epoch = 0
  const transaction = mode => {
    check(!!db, 'storage', 'storage_not_open')
    try {
      const tx = db.transaction(['roots', 'documents'], mode, { durability: 'strict' })
      if (mode === 'readwrite' && tx.durability !== 'strict') {
        tx.abort()
        throw { code: 'UNSUPPORTED_DURABILITY' }
      }
      return tx
    }
    catch (error) {
      // An engine without explicit strict durability cannot promise durable publications.
      throw storageError(error)
    }
  }
  const run = (mode, work) => new Promise((resolve, reject) => {
    let tx, result, failure
    try {
      tx = transaction(mode)
      tx.oncomplete = () => resolve(result)
      tx.onerror = () => { failure ??= tx.error }
      tx.onabort = () => reject(storageError(failure ?? tx.error ?? new Error('transaction aborted')))
      work(tx, value => { result = value }, error => { failure = error; tx.abort() })
    } catch (error) { if (tx) { try { tx.abort() } catch { /* already finished */ } }; reject(storageError(error)) }
  })
  return {
    name: 'indexeddb',
    async open(scopeId) {
      check(typeof scopeId === 'string' && /^[a-f0-9]{64}$/.test(scopeId), 'scope', 'invalid_scope_id')
      check(!!idb, 'storage', 'storage_unavailable')
      check(!db && !opening, 'storage', 'storage_already_open')
      opening = true
      const attempt = ++epoch
      try {
        const connection = await new Promise((resolve, reject) => {
          let blocked = false
          const request = idb.open(`opengym-nutrition-${scopeId}`, 1)
          request.onupgradeneeded = () => {
            for (const name of ['roots', 'documents']) {
              if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name)
            }
          }
          request.onsuccess = () => {
            if (blocked || attempt !== epoch) {
              request.result.close()
              if (!blocked) reject(new Error('storage closed during open'))
            } else resolve(request.result)
          }
          request.onerror = () => reject(request.error)
          request.onblocked = () => { blocked = true; reject(new Error('database upgrade blocked')) }
        })
        if (attempt !== epoch) { connection.close(); throw new Error('storage closed during open') }
        db = connection
        connection.onversionchange = () => { connection.close(); if (db === connection) db = null }
        connection.onclose = () => { if (db === connection) db = null }
      } catch (error) { throw storageError(error) }
      finally { if (attempt === epoch) opening = false }
    },
    snapshot() {
      return run('readonly', (tx, finish) => {
        const roots = tx.objectStore('roots'), objects = []
        const result = { root: null, previous: null, objects }
        for (const key of ['root', 'previous']) roots.get(key).onsuccess = event => { result[key] = event.target.result ?? null }
        const cursor = tx.objectStore('documents').openCursor()
        cursor.onsuccess = () => {
          const row = cursor.result
          if (row) { objects.push({ key: row.key, text: row.value }); row.continue() }
        }
        finish(result)
      })
    },
    headers() {
      return run('readonly', (tx, finish) => {
        const roots = tx.objectStore('roots'), documents = tx.objectStore('documents'), seen = new Set()
        const result = { root: null, previous: null, index: null, objects: [], hasDocuments: false }
        roots.get('index').onsuccess = event => { result.index = event.target.result ?? null }
        for (const key of ['root', 'previous']) roots.get(key).onsuccess = event => {
          result[key] = event.target.result ?? null
          const name = manifestKey(result[key])
          if (name && !seen.has(name)) {
            seen.add(name)
            documents.get(name).onsuccess = event => {
              if (event.target.result !== undefined) result.objects.push({ key: name, text: event.target.result })
            }
          }
        }
        documents.openKeyCursor().onsuccess = event => { result.hasDocuments = !!event.target.result }
        finish(result)
      })
    },
    async readDocuments(input) {
      const value = captureRead(input)
      return run('readonly', (tx, finish, abort) => {
        const roots = tx.objectStore('roots'), objects = []
        let answered = 0, matches = true
        for (const [key, expected] of [['root', value.expectedRoot], ['previous', value.expectedPrevious]]) {
          roots.get(key).onsuccess = event => {
            matches &&= (event.target.result ?? null) === expected
            if (++answered !== 2) return
            if (!matches) { abort({ code: 'STALE_ROOT' }); return }
            for (const key of value.keys) tx.objectStore('documents').get(key).onsuccess = event => {
              if (event.target.result !== undefined) objects.push({ key, text: event.target.result })
            }
            finish({ objects })
          }
        }
      })
    },
    async saveIndex(input) {
      const value = captureIndex(input)
      return run('readwrite', (tx, finish, abort) => {
        const roots = tx.objectStore('roots')
        let answered = 0, matches = true
        for (const [key, expected] of [['root', value.expectedRoot], ['previous', value.expectedPrevious]]) roots.get(key).onsuccess = event => {
          matches &&= (event.target.result ?? null) === expected
          if (++answered !== 2) return
          if (!matches) { abort({ code: 'STALE_ROOT' }); return }
          roots.put(value.index, 'index'); finish({ saved: true })
        }
      })
    },
    async publish(input) {
      const value = capturePublication(input)
      return run('readwrite', (tx, finish, abort) => {
        const roots = tx.objectStore('roots'), documents = tx.objectStore('documents')
        roots.get('root').onsuccess = event => {
          const current = event.target.result ?? null
          if (current === value.root) { finish({ repeated: true }); return }
          if (current !== value.expectedRoot) { abort({ code: 'STALE_ROOT' }); return }
          for (const row of value.writes) {
            documents.get(row.key).onsuccess = event => {
              if (event.target.result !== undefined && event.target.result !== row.text) abort({ code: 'INTEGRITY_CONFLICT' })
              else documents.put(row.text, row.key)
            }
          }
          // Requests queued by get callbacks still belong to this transaction. No async work here.
          if (current !== null) roots.put(current, 'previous')
          roots.put(value.root, 'root')
          finish({ repeated: false })
        }
      })
    },
    async collect(input) {
      const { expectedRoot, expectedPrevious, keys } = jsonClone(input)
      exactKeys(input, ['expectedRoot', 'expectedPrevious', 'keys'], '$')
      check(Array.isArray(keys) && keys.every(isDocumentKey), 'keys', 'invalid_document_key')
      check(isText(expectedRoot), 'expectedRoot', 'text_required')
      return run('readwrite', (tx, finish, abort) => {
        const roots = tx.objectStore('roots')
        let current, previous, answered = 0
        const remove = () => {
          if (++answered !== 2) return
          if ((current ?? null) !== expectedRoot || (previous ?? null) !== expectedPrevious) { abort({ code: 'STALE_ROOT' }); return }
          for (const key of keys) tx.objectStore('documents').delete(key)
          finish({ deleted: keys.length })
        }
        roots.get('root').onsuccess = event => { current = event.target.result; remove() }
        roots.get('previous').onsuccess = event => { previous = event.target.result; remove() }
      })
    },
    close() { epoch++; opening = false; db?.close(); db = null },
  }
}
