import { afterEach, test, expect } from 'vitest'
import { nutritionInstallationIdentity } from './ui-identity.js'
import { transactionalIdb, diskBridge } from './local-storage.test-util.js'
import { nutritionIdbBackend } from './local-store-idb.js'
import { nutritionFsBackend } from './local-store-fs.js'
import { hasCode, namespace } from './persistence.test-util.js'
const cleanup = []
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn() })
for (const kind of ['idb', 'fs']) test(`installation identities ${kind} survive reopen and competing initialization`, async () => {
  const engine = kind === 'idb' ? transactionalIdb() : await diskBridge()
  if (engine.cleanup) cleanup.push(engine.cleanup)
  const backend = () => kind === 'idb' ? nutritionIdbBackend({ idb: engine.idb }) : nutritionFsBackend({ loadPlugin: async () => engine.plugin })
  const [a, b] = await Promise.all([nutritionInstallationIdentity({ backend: backend() }), nutritionInstallationIdentity({ backend: backend() })])
  expect(a).toEqual(b); expect(await nutritionInstallationIdentity({ backend: backend() })).toEqual(a)
})
test('identity corruption refuses initialization instead of stranding an older profile', async () => {
  const engine = transactionalIdb(), backend = () => nutritionIdbBackend({ idb: engine.idb })
  await nutritionInstallationIdentity({ backend: backend() })
  const db = [...engine.control.databases.values()][0], before = db.stores.get('roots').get('root')
  db.stores.get('roots').set('root', '{}')
  await expect(nutritionInstallationIdentity({ backend: backend() })).rejects.toThrow()
  expect(db.stores.get('roots').get('root')).toBe('{}'); expect(before).toContain('deviceId')
})
test('same-origin server mounts cannot share one account scope, including after reopen', async () => {
  const engine = transactionalIdb(), backend = () => nutritionIdbBackend({ idb: engine.idb })
  const scope = { namespace: { ...namespace, serverOrigin: 'https://gym.test' }, generation: 'generation-1' }
  const bind = apiBase => nutritionInstallationIdentity({ backend: backend(), binding: { scope, apiBase, hasExistingData: false } })
  const ids = await bind('https://gym.test/one'); expect(await bind('https://gym.test/one/')).toEqual(ids)
  await expect(bind('https://gym.test/two')).rejects.toSatisfy(hasCode('server_mount_scope_mismatch'))
})
test('unbound legacy Nutrition at a subpath refuses silent adoption and does not establish that binding', async () => {
  const engine = transactionalIdb(), backend = () => nutritionIdbBackend({ idb: engine.idb })
  const scope = { namespace: { ...namespace, serverOrigin: 'https://gym.test' }, generation: 'generation-1' }
  await nutritionInstallationIdentity({ backend: backend() })
  const binding = { scope, apiBase: 'https://gym.test/mounted', hasExistingData: true }
  await expect(nutritionInstallationIdentity({ backend: backend(), binding })).rejects.toSatisfy(hasCode('legacy_mount_scope_requires_transfer'))
  expect(await nutritionInstallationIdentity({ backend: backend(), binding: { ...binding, apiBase: 'https://gym.test/' } })).toHaveProperty('deviceId')
})
