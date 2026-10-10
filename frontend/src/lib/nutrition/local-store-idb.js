import { check, exactKeys, isText, jsonClone } from './persistence-contract.js'
import { capturePublication, isDocumentKey, storageError } from './local-contract.js'

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
