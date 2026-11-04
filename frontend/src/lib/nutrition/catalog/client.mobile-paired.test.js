// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { localBody, localCapabilities, localRecord, localSearchBody } from './local-fixtures.test-util.js'
import { offProduct } from './fixtures.test-util.js'

const bridge = vi.hoisted(() => ({ get: vi.fn() }))
const files = vi.hoisted(() => ({ writeFile: vi.fn() }))
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true }, CapacitorHttp: { get: bridge.get } }))
vi.mock('@capacitor/filesystem', () => ({ Filesystem: files, Directory: { Data: 'DATA' }, Encoding: { UTF8: 'utf8' } }))
const origin = 'https://my-own-gym.example'
let catalog, api, fetcher
const answer = (body, url, status = 200) => {
  const response = new Response(JSON.stringify(body), { status })
  Object.defineProperty(response, 'url', { value: url })
  return response
}
beforeEach(async () => {
  vi.resetModules()
  vi.stubEnv('VITE_MOBILE', '1')
  vi.stubEnv('VITE_OPENGYM_PERSONAL_BETA', '0')
  vi.stubEnv('VITE_NUTRITION_LOCAL_V1', '1')
  vi.stubEnv('VITE_NUTRITION_CATALOG_ORIGIN', '')
  bridge.get.mockReset()
  files.writeFile.mockReset()
  fetcher = vi.fn(async url => answer(url.endsWith('capabilities') ? localCapabilities : url.includes('/search?') ? localSearchBody() : localBody({ product: localRecord() }), url))
  vi.stubGlobal('fetch', fetcher)
  api = await import('../../api.js')
})
afterEach(() => { catalog?.close(); catalog = null; vi.unstubAllGlobals(); vi.unstubAllEnvs() })
const create = async options => { catalog = (await import('./client.js')).createFoodCatalog({ serverOrigin: origin, ...options }); return catalog }

test('one generic Android build reads its paired HTTPS catalogue with session and scoped Access headers', async () => {
  api.setRemoteAuth(origin, 'synthetic-session')
  api.setAccessHeaders({ 'CF-Access-Client-Id': 'fixture-id', 'CF-Access-Client-Secret': 'fixture-secret' }, origin)
  await create()
  expect((await catalog.capabilities()).available).toBe(true)
  expect((await catalog.search('riz')).products[0].id).toBe(localRecord().id)
  expect((await catalog.localProduct(localRecord().id)).product.id).toBe(localRecord().id)
  expect(fetcher).toHaveBeenCalledTimes(3)
  for (const [url, init] of fetcher.mock.calls) {
    expect(new URL(url).origin).toBe(origin)
    expect(init).toMatchObject({ credentials: 'omit', redirect: 'error', headers: { Authorization: 'Bearer synthetic-session', 'CF-Access-Client-Secret': 'fixture-secret' } })
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(init).not.toHaveProperty('expectedBase')
  }
  expect(bridge.get).not.toHaveBeenCalled()
})

test('an unpaired or mismatched session cannot send an old account query to another server', async () => {
  await create()
  expect((await catalog.capabilities()).available).toBe(false)
  api.setRemoteAuth('https://different-gym.example', 'other-session')
  expect((await catalog.capabilities()).available).toBe(false)
  api.setRemoteAuth(origin + '/different-mount', 'mount-session')
  expect((await catalog.capabilities()).available).toBe(false)
  expect(fetcher).not.toHaveBeenCalled()
  expect(bridge.get).not.toHaveBeenCalled()
})

test('401 and offline keep the catalogue unavailable without anonymous or provider fallback', async () => {
  api.setRemoteAuth(origin, 'refused-session')
  fetcher.mockImplementationOnce(async url => answer({ error: 'not signed in' }, url, 401))
  await create()
  expect((await catalog.capabilities()).available).toBe(false)
  expect(() => catalog.search('riz')).toThrow()
  fetcher.mockRejectedValueOnce(new TypeError('offline'))
  expect((await catalog.capabilities()).available).toBe(false)
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(bridge.get).not.toHaveBeenCalled()
})

test('requests use the renewed token and refuse a changed pairing before dispatch', async () => {
  api.setRemoteAuth(origin, 'old-session')
  await create(); await catalog.capabilities()
  api.setRemoteAuth(origin, 'renewed-session')
  await catalog.search('riz')
  expect(fetcher.mock.calls.at(-1)[1].headers.Authorization).toBe('Bearer renewed-session')
  api.setRemoteAuth('https://different-gym.example', 'other-session')
  await expect(catalog.search('avoine')).rejects.toThrow()
  expect(fetcher).toHaveBeenCalledTimes(2)
})

test('late capability replies cannot publish into a closed account session', async () => {
  api.setRemoteAuth(origin, 'session')
  let deliver
  fetcher.mockImplementationOnce(url => new Promise(resolve => { deliver = () => resolve(answer(localCapabilities, url)) }))
  await create()
  const pending = catalog.capabilities()
  await vi.waitFor(() => expect(deliver).toBeTypeOf('function'))
  catalog.close(); deliver()
  await expect(pending).rejects.toThrow()
  expect(catalog.localReady).toBe(false)
})

test('a pairing changed during fetch cannot publish its late capability reply', async () => {
  api.setRemoteAuth(origin, 'session')
  let deliver
  fetcher.mockImplementationOnce(url => new Promise(resolve => { deliver = () => resolve(answer(localCapabilities, url)) }))
  await create(); const pending = catalog.capabilities()
  await vi.waitFor(() => expect(deliver).toBeTypeOf('function'))
  api.setRemoteAuth('https://different-gym.example', 'other-session'); deliver()
  expect((await pending).available).toBe(false)
  expect(catalog.localReady).toBe(false)
})

test('an account changed while reading a search body cannot receive late results', async () => {
  api.setRemoteAuth(origin, 'session')
  let current = true, deliver
  await create({ guard: () => { if (!current) throw Error('account changed') } })
  await catalog.capabilities()
  fetcher.mockResolvedValueOnce({ status: 200, headers: { get: () => null }, text: () => new Promise(resolve => { deliver = () => resolve(JSON.stringify(localSearchBody())) }) })
  const pending = catalog.search('riz')
  const rejection = expect(pending).rejects.toThrow()
  await vi.waitFor(() => expect(deliver).toBeTypeOf('function'))
  current = false; deliver()
  await rejection
})

test.each([[origin, false], ['https://different-gym.example', false], [origin, true], ['https://different-gym.example', true]])('pairing to %s during a body read (stream=%s) rejects stale results before pairing persistence completes', async (newBase, stream) => {
  api.setRemoteAuth(origin, 'old-session')
  await create(); await catalog.capabilities()
  let deliverBody, finishPersistence
  const text = JSON.stringify(localSearchBody())
  const body = stream ? new ReadableStream({ pull(controller) { deliverBody = () => { controller.enqueue(new TextEncoder().encode(text)); controller.close() } } }, { highWaterMark: 0 }) : null
  fetcher.mockResolvedValueOnce({ status: 200, headers: { get: () => null }, body,
    text: () => new Promise(resolve => { deliverBody = () => resolve(text) }) })
  const pending = catalog.search('riz')
  // Consume the outcome immediately so a rejected late body is always observed.
  const outcome = pending.then(value => ({ value }), error => ({ error }))
  await vi.waitFor(() => expect(deliverBody).toBeTypeOf('function'))
  files.writeFile.mockImplementationOnce(() => new Promise(resolve => { finishPersistence = resolve }))
  fetcher.mockResolvedValueOnce(answer({ token: 'new-account-session', user: { id: 'new-account', name: 'Fixture' } }, newBase + '/api/pair/redeem'))
  const remote = await import('../../remote.js')
  let paired = false
  const connecting = remote.connect(newBase, 'PAIR1234').then(() => { paired = true })
  await vi.waitFor(() => expect(finishPersistence).toBeTypeOf('function'))
  try {
    expect(paired).toBe(false) // connectToServer cannot update its user/server yet.
    deliverBody()
    expect((await outcome).error).toBeTruthy()
  } finally { finishPersistence(); await connecting }
})

test('noncanonical account addresses are refused before a request', async () => {
  for (const serverOrigin of ['file:///private', origin + '/', origin + '?other', 'https://user:password@my-own-gym.example']) {
    const { createFoodCatalog } = await import('./client.js')
    expect(() => createFoodCatalog({ serverOrigin })).toThrow()
  }
  expect(fetcher).not.toHaveBeenCalled()
  expect(bridge.get).not.toHaveBeenCalled()
})

test('older local suggestion contracts also use the paired session', async () => {
  vi.stubEnv('VITE_NUTRITION_LOCAL_V1', '0')
  api.setRemoteAuth(origin, 'session')
  fetcher.mockImplementation(async url => answer(url.endsWith('capabilities') ? { schemaVersion: 1, textSearch: 'local' } : { count: 1, products: [offProduct()] }, url))
  await create()
  expect(await catalog.capabilities()).toEqual({ textSearch: 'local' })
  expect((await catalog.search('riz', { localOnly: true })).products).toHaveLength(1)
  expect(fetcher.mock.calls.at(-1)[0]).toContain(origin + '/api/nutrition/catalog/search?')
  expect(fetcher.mock.calls.at(-1)[1].headers.Authorization).toBe('Bearer session')
  expect(bridge.get).not.toHaveBeenCalled()
})

test('injected catalogue transports remain independent of native account authentication', async () => {
  const capabilitiesTransport = vi.fn(async () => answer(localCapabilities, origin))
  const localTransport = vi.fn(async () => answer(localSearchBody(), origin))
  const transport = vi.fn()
  await create({ transport, capabilitiesTransport, localTransport })
  expect((await catalog.capabilities()).available).toBe(true)
  expect((await catalog.search('riz')).products).toHaveLength(1)
  expect(localTransport).toHaveBeenCalledTimes(1)
  expect(fetcher).not.toHaveBeenCalled()
  expect(bridge.get).not.toHaveBeenCalled()
})
