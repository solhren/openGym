import { test, expect, vi, afterAll } from 'vitest'
const bridge = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true }, CapacitorHttp: bridge }))
vi.stubEnv('VITE_MOBILE', '1')
const { directTransport, MAX_RESPONSE_BYTES } = await import('./client.js')
afterAll(() => vi.unstubAllEnvs())
const url = 'https://world.openfoodfacts.org/api/v3/product/3017620422003'
test('native HTTP identifies app, controls redirects/timeouts and sends no openGym auth', async () => {
  bridge.get.mockResolvedValueOnce({ status: 200, data: '{"status":"success"}', headers: {} })
  const r = await directTransport(url, { signal: new AbortController().signal }); expect(await r.text()).toBe('{"status":"success"}')
  expect(bridge.get.mock.calls[0][0]).toMatchObject({ disableRedirects: true, readTimeout: 20000, connectTimeout: 15000, headers: { Accept: 'application/json', 'User-Agent': expect.stringContaining('openGym/') } })
  expect(bridge.get.mock.calls[0][0].headers.Authorization).toBeUndefined()
})
test('native cancellation immediately rejects late data while retaining underlying socket exclusion', async () => {
  let resolve; bridge.get.mockImplementationOnce(() => new Promise(r => { resolve = r })); const controller = new AbortController(), task = directTransport(url, { signal: controller.signal })
  await vi.waitFor(() => expect(resolve).toBeTypeOf('function')); controller.abort(); await expect(task).rejects.toMatchObject({ name: 'AbortError' })
  await expect(directTransport(url, { signal: new AbortController().signal })).rejects.toMatchObject({ code: 'request-in-progress' })
  resolve({ status: 200, data: '{}', headers: {} }); await Promise.resolve()
})
test('native oversized bridge body and already-aborted requests refused', async () => {
  bridge.get.mockResolvedValueOnce({ status: 200, data: ' '.repeat(MAX_RESPONSE_BYTES + 1), headers: {} })
  await expect(directTransport(url, { signal: new AbortController().signal })).rejects.toMatchObject({ code: 'response-too-large' })
  const count = bridge.get.mock.calls.length, c = new AbortController(); c.abort(); await expect(directTransport(url, { signal: c.signal })).rejects.toMatchObject({ name: 'AbortError' }); expect(bridge.get.mock.calls.length).toBe(count)
})

test('Capacitor JSON objects returned despite responseType text are inspected and transported faithfully', async () => {
  const data = { status: 'success', product: { code: '0034000470693', product_name: 'Crème', nutriments: { proteins_100g: 0 } } }
  bridge.get.mockResolvedValueOnce({ status: 200, data, headers: { 'Content-Type': 'application/json' } })
  const r = await directTransport(url, { signal: new AbortController().signal }); expect(JSON.parse(await r.text())).toEqual(data)
})
test('native parsed objects cannot bypass body bounds or execute getters during re-encoding', async () => {
  bridge.get.mockResolvedValueOnce({ status: 200, data: { products: Array.from({ length: 200 }, () => 'x'.repeat(6000)) }, headers: {} })
  await expect(directTransport(url, { signal: new AbortController().signal })).rejects.toMatchObject({ code: 'response-too-large' })
  const getter = vi.fn(() => 'unsafe'), data = {}; Object.defineProperty(data, 'name', { enumerable: true, get: getter })
  bridge.get.mockResolvedValueOnce({ status: 200, data, headers: {} })
  await expect(directTransport(url, { signal: new AbortController().signal })).rejects.toMatchObject({ code: 'invalid-response' }); expect(getter).not.toHaveBeenCalled()
})

test('native error-body content cannot hide rate-limit status and Retry-After', async () => {
  const getter = vi.fn(() => 'unused'), data = {}; Object.defineProperty(data, 'body', { enumerable: true, get: getter })
  bridge.get.mockResolvedValueOnce({ status: 429, data, headers: { 'Retry-After': '60' } })
  const r = await directTransport(url, { signal: new AbortController().signal })
  expect(r.status).toBe(429); expect(r.headers.get('retry-after')).toBe('60'); expect(await r.text()).toBe(''); expect(getter).not.toHaveBeenCalled()
})

test('real native search builder uses a User-Agent header only, never a query identity', async () => {
  const { createFoodCatalog } = await import('./client.js'), { offProduct } = await import('./fixtures.test-util.js')
  bridge.get.mockResolvedValueOnce({ status: 200, data: { count: 1, products: [offProduct()] }, headers: {} })
  const catalog = createFoodCatalog({ limiter: { reserve: async () => {}, block() {} } })
  try {
    expect((await catalog.search('nutella')).products).toHaveLength(1)
    const request = bridge.get.mock.calls.at(-1)[0]; expect(new URL(request.url).searchParams.has('User-Agent')).toBe(false); expect(request.headers['User-Agent']).toContain('openGym/')
  } finally { catalog.close() }
})

test('cancellation during immediate native dispatch cannot let a resolved reply win the abort race', async () => {
  const controller = new AbortController()
  bridge.get.mockImplementationOnce(async () => { controller.abort(); return { status: 200, data: '{}', headers: {} } })
  await expect(directTransport(url, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
})
