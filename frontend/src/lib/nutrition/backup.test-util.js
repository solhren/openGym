import { afterEach } from 'vitest'
import { createNutritionLocalStore } from './local-store.js'
import { nutritionIdbBackend } from './local-store-idb.js'
import { nutritionFsBackend } from './local-store-fs.js'
import { transactionalIdb, diskBridge } from './local-storage.test-util.js'
import { namespace, journal, sync } from './persistence.test-util.js'
import { encodePartition } from './serialization.js'
import { createNutritionBackup } from './backup.js'
const cleanups = []
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn() })
export async function backupFixture(kind = 'idb', overrides = {}) {
  const memory = transactionalIdb(), disk = kind === 'fs' ? await diskBridge() : null
  if (disk) cleanups.push(disk.cleanup)
  const options = { namespace, generation: 'generation-1', deviceId: 'target-device', ...overrides }
  const backend = () => disk ? nutritionFsBackend({ loadPlugin: async () => disk.plugin }) : nutritionIdbBackend({ idb: memory.idb })
  let store = await createNutritionLocalStore({ ...options, backend: backend() })
  cleanups.push(() => store.close())
  const session = { value: { userId: options.namespace.profileId, serverOrigin: options.namespace.serverOrigin, epoch: 1 } }
  return { get store() { return store }, control: disk?.control ?? memory.control, session,
    service(extra = {}) { return createNutritionBackup({ store, getSession: () => session.value, getWorkoutRevision: () => ({ namespace: options.namespace, revision: 'fixture-version' }), ...extra }) },
    async fork() {
      const other = await createNutritionLocalStore({ ...options, backend: backend() })
      cleanups.push(() => other.close()); return other
    },
    async reopen() { store.close(); store = await createNutritionLocalStore({ ...options, backend: backend() }); return store },
    async commit(domain = journal(), id = 'initial') { return store.commit({ commitId: id, partitions: [await encodePartition({ ...domain, namespace: options.namespace, generation: options.generation })] }) },
  }
}
export const revised = (value, revision = 1, counter = 10) => {
  const domain = structuredClone(value)
  domain.sync = { ...sync(revision), edits: (domain.records.foodEntries ?? []).map(row => ({ collection: 'foodEntries', id: row.id, stamp: { counter, deviceId: 'target-device' } })), tombstones: [] }
  return domain
}
