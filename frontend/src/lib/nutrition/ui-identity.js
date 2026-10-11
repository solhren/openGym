import { check, contentHash, exactKeys, boundedJson, verifiedDocument, sealDocument, validateScope, HASH_PATTERN, isObject } from './persistence-contract.js'
import { nutritionIdbBackend } from './local-store-idb.js'
import { nutritionFsBackend } from './local-store-fs.js'
import { newNutritionId } from './ui-service.js'

/** Installation identities need the same private durability as the data they address.
 * In particular, WebView localStorage eviction must not strand native Nutrition files.
 * This isolated root uses the existing physical atomic CAS, not the portable v1 graph. */
export async function nutritionInstallationIdentity({ backend, native, newId = newNutritionId, binding = null } = {}) {
  let bindingKey = null, bindingValue = null, mounted = false
  if (binding) {
    exactKeys(binding, ['scope', 'apiBase', 'hasExistingData'], 'binding')
    validateScope({ ...binding.scope, domainVersion: 1 })
    const base = new URL(binding.apiBase)
    check(base.origin === binding.scope.namespace.serverOrigin && !base.search && !base.hash && !base.username && !base.password &&
      typeof binding.hasExistingData === 'boolean', 'binding', 'invalid_server_binding')
    mounted = base.pathname !== '/'
    bindingKey = await contentHash(binding.scope)
    bindingValue = await contentHash({ apiBase: base.origin + base.pathname.replace(/\/+$/, '') })
  }
  if (!backend) {
    const isNative = native ?? (await import('@capacitor/core')).Capacitor.isNativePlatform()
    backend = isNative ? nutritionFsBackend() : nutritionIdbBackend()
  }
  await backend.open(await contentHash({ format: 'opengym-nutrition-installation-identity', storageVersion: 1 }))
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const headers = await backend.headers()
      if (headers.root !== null) {
        const value = await verifiedDocument(headers.root, 'opengym-nutrition-installation-identity')
        exactKeys(value, ['format', 'storageVersion', 'profileId', 'deviceId', 'serverBindings', 'integrity'], 'identity',
          ['format', 'storageVersion', 'profileId', 'deviceId', 'integrity'])
        check([value.profileId, value.deviceId].every(v => typeof v === 'string' && /^[a-f0-9]{32}$/.test(v)), 'identity', 'invalid_local_identity')
        const bindings = value.serverBindings ?? {}
        check(isObject(bindings) && Object.entries(bindings).every(([key, hash]) => HASH_PATTERN.test(key) && typeof hash === 'string' && HASH_PATTERN.test(hash)), 'identity', 'invalid_server_bindings')
        if (bindingKey !== null) {
          check(!Object.hasOwn(bindings, bindingKey) || bindings[bindingKey] === bindingValue, 'identity', 'server_mount_scope_mismatch')
          if (!Object.hasOwn(bindings, bindingKey)) {
            // Portable v1 has only an origin. Legacy unbound data on a subpath cannot
            // establish which installation owned it. Refuse adoption, never guess.
            check(!mounted || !binding.hasExistingData, 'identity', 'legacy_mount_scope_requires_transfer')
            check(Object.keys(bindings).length < 1024, 'identity', 'server_binding_limit')
            const { integrity: ignored, ...payload } = value
            const next = await sealDocument({ ...payload, serverBindings: { ...bindings, [bindingKey]: bindingValue } })
            try { await backend.publish({ expectedRoot: headers.root, root: boundedJson(next), writes: [] }) }
            catch (error) { if (!error.issues?.some(i => i.code === 'stale_root')) throw error }
            continue
          }
        }
        return { profileId: value.profileId, deviceId: value.deviceId }
      }
      check(headers.previous === null && !headers.hasDocuments, 'identity', 'identity_recovery_required')
      const value = await sealDocument({ format: 'opengym-nutrition-installation-identity', storageVersion: 1, profileId: newId(), deviceId: newId() })
      try {
        await backend.publish({ expectedRoot: null, root: boundedJson(value), writes: [] })
        // Read the committed value, including after a competing initialization.
      } catch (error) { if (!error.issues?.some(i => i.code === 'stale_root')) throw error }
    }
    check(false, 'identity', 'identity_initialization_busy')
  } finally { backend.close() }
}
