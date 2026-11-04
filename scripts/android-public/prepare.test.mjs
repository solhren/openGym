import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GENERIC_ENV, prepareAndroid } from './prepare.mjs'

const GiB = 1024 ** 3
const fixture = extra => ({
  root: '/synthetic-checkout', nodeVersion: '22.23.3',
  disk: () => ({ bavail: 21 * GiB, bsize: 1 }), availableMemory: () => 3 * GiB,
  read: path => JSON.stringify(path.endsWith('package.json') ? { scripts: { 'build:mobile': 'existing command' } } : { appId: 'org.example.opengym' }),
  ...extra,
})
test('generic profile needs no personal domain, account, credentials or signing file', () => {
  const result = prepareAndroid(fixture())
  assert.deepEqual(result.build.env, GENERIC_ENV)
  assert.equal(result.build.env.VITE_OPENGYM_PERSONAL_BETA, '0')
  assert.equal(result.build.env.VITE_NUTRITION_CATALOG_ORIGIN, '')
  assert.equal(result.build.env.VITE_NUTRITION_LOCAL_V1, '1')
  assert.deepEqual(result.build.command, ['npm', 'run', 'build:mobile'])
  assert.equal(result.apkBuilt, false)
  assert.equal(result.appId, 'org.example.opengym')
})
test('reads only public project manifests, without executing or writing anything', () => {
  const reads = []
  const options = fixture()
  const read = options.read
  prepareAndroid({ ...options, read: path => { reads.push(path); return read(path) } })
  assert.deepEqual(reads, ['/synthetic-checkout/frontend/package.json', '/synthetic-checkout/frontend/capacitor.config.json'])
})
test('resource and Node guards fail closed at the documented limits', () => {
  assert.throws(() => prepareAndroid(fixture({ nodeVersion: '20.0.0' })), /Node 22/)
  assert.throws(() => prepareAndroid(fixture({ disk: () => ({ bavail: 20 * GiB - 1, bsize: 1 }) })), /20 GiB/)
  assert.throws(() => prepareAndroid(fixture({ availableMemory: () => 2 * GiB - 1 })), /2 GiB/)
  assert.doesNotThrow(() => prepareAndroid(fixture({ disk: () => ({ bavail: 20 * GiB, bsize: 1 }), availableMemory: () => 2 * GiB })))
})
test('refuses a remote WebView shell or missing build command', () => {
  for (const config of [{ appId: 'org.example', server: { url: 'https://foreign.example' } }, {}]) {
    assert.throws(() => prepareAndroid(fixture({ read: path => JSON.stringify(path.endsWith('package.json') ? { scripts: { 'build:mobile': 'existing' } } : config) })), /local Capacitor/)
  }
  assert.throws(() => prepareAndroid(fixture({ read: () => '{}' })), /local Capacitor/)
})
