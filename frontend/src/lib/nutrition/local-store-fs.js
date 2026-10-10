import { check, jsonClone } from './persistence-contract.js'
import { capturePublication, isDocumentKey, storageError } from './local-contract.js'

// Filesystem alone has no lock/fsync/CAS API. The small project-owned native bridge performs
// each call under an OS file lock and forces files/directories before publishing the root.
export function nutritionFsBackend({ loadPlugin = async () => {
  const { registerPlugin } = await import('@capacitor/core')
  return registerPlugin('NutritionStorage')
} } = {}) {
  let plugin, scope, opening = false, epoch = 0
  const call = async (method, args = {}) => {
    check(!!plugin, 'storage', 'storage_not_open')
    try { return await plugin[method]({ scope, ...args }) } catch (error) { throw storageError(error) }
  }
  return {
    name: 'private-json',
    async open(scopeId) {
      check(typeof scopeId === 'string' && /^[a-f0-9]{64}$/.test(scopeId), 'scope', 'invalid_scope_id')
      check(!plugin && !opening, 'storage', 'storage_already_open')
      opening = true
      const attempt = ++epoch
      try {
        const loaded = await loadPlugin()
        await loaded.snapshot({ scope: scopeId })
        if (attempt !== epoch) throw new Error('storage closed during open')
        scope = scopeId; plugin = loaded
      } catch (error) { throw storageError(error) }
      finally { if (attempt === epoch) opening = false }
    },
    snapshot() { return call('snapshot') },
    async publish(input) { return call('publish', capturePublication(input)) },
    async collect(input) {
      const value = jsonClone(input)
      check(Array.isArray(value.keys) && value.keys.every(isDocumentKey), 'keys', 'invalid_document_key')
      return call('collect', value)
    },
    close() { epoch++; opening = false; plugin = null },
  }
}
