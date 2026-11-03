import { afterEach, test, expect, vi } from 'vitest'
import { createFoodCatalog, createRateLimiter, MAX_RESPONSE_BYTES } from './client.js'
import { offProduct, response } from './fixtures.test-util.js'
const limiter = () => ({ reserve: vi.fn(async () => {}), block: vi.fn() }), searchResponse = () => response({ count: 1, products: [offProduct()] })
const clients = []; afterEach(() => { clients.splice(0).forEach(c => c.close()) })
const client = options => { const c = createFoodCatalog({ limiter: limiter(), ...options }); clients.push(c); return c }
test('local catalogue 503 without Retry-After shows unavailable without a fabricated wait',async()=>{
  const transport=async()=>Object.assign(response({code:'catalog-local-unavailable'},503),{catalogRelay:true}),c=client({transport})
  await expect(c.search('lait')).rejects.toMatchObject({code:'provider-unavailable'})
  try {await c.search('lait')}catch(error){expect(error.retryAfter).toBeUndefined()}
})
test('CGI text search has bounded fields/pages, app identity and no private data', async () => {
  const transport = vi.fn(async () => searchResponse()), c = client({ transport }); await c.search('  pâte  Example ', { language: 'fr' })
  const u = new URL(transport.mock.calls[0][0]); expect(u.origin).toBe('https://world.openfoodfacts.org'); expect(u.pathname).toBe('/cgi/search.pl'); expect(u.searchParams.get('search_terms')).toBe('pâte Example'); expect(u.searchParams.get('page_size')).toBe('20'); expect(u.searchParams.has('User-Agent')).toBe(false); expect([...u.searchParams.keys()]).not.toContain('userId')
})
test('v3 barcode endpoint and exact barcode check', async () => {
  const transport = vi.fn(async () => response({ status: 'success', product: offProduct() })), c = client({ transport })
  expect((await c.product('3017620422003')).product.food).toBeTruthy(); expect(new URL(transport.mock.calls[0][0]).pathname).toBe('/api/v3/product/3017620422003')
})
test('cache reuse is immutable and does not reserve request budget; clear only cache', async () => {
  const transport = vi.fn(async () => searchResponse()), limits = limiter(), c = client({ transport, limiter: limits })
  await c.search('pâte'); const cached = await c.search('PÂTE'); expect(cached.cached).toBe(true); expect(transport).toHaveBeenCalledTimes(1)
  cached.products[0].name = 'mutated'; expect((await c.search('pâte')).products[0].name).not.toBe('mutated'); c.clear(); expect(c.cacheInfo().entries).toBe(0); await c.search('pâte'); expect(transport).toHaveBeenCalledTimes(2)
})
test('TTL and bounded LRU 50 entries/1MiB', async () => {
  let now = 0; const transport = vi.fn(async () => searchResponse()), c = client({ transport, now: () => now })
  for (let i = 0; i < 55; i++) await c.search(`query${i}`)
  expect(c.cacheInfo().entries).toBe(50); expect(c.cacheInfo().bytes).toBeLessThanOrEqual(MAX_RESPONSE_BYTES); now = 300001; await c.search('query54'); expect(transport).toHaveBeenCalledTimes(56)
})
test.each([429, 503])('HTTP %i backoff without retry', async status => {
  const transport = vi.fn(async () => response({}, status, { 'retry-after': '120' })), limits = limiter(), c = client({ transport, limiter: limits })
  await expect(c.search('pâte')).rejects.toMatchObject({ code: status === 503 ? 'provider-unavailable' : 'rate-limited', retryAfter: 120 }); if (status === 503) expect(limits.block).toHaveBeenCalledWith(120, 'search'); else expect(limits.block).toHaveBeenCalledWith(120); expect(transport).toHaveBeenCalledTimes(1)
})
test.each([404, 500])('HTTP %i cannot be successful lookup', async status => await expect(client({ transport: async () => response({}, status) }).product('3017620422003')).rejects.toThrow())
test.each([{ count: 0, products: [] }, { count: 2, products: [offProduct(), offProduct()] }])('empty/duplicate result %j', async value => expect((await client({ transport: async () => response(value) }).search('pâte')).products.length).toBe(value.count ? 1 : 0))
test('invalid products omitted, incomplete products stay visible', async () => {
  const found = await client({ transport: async () => response({ count: 2, products: [{}, offProduct({ nutriments: {} })] }) }).search('pâte')
  expect(found.rejected).toBe(1); expect(found.products[0].food).toBeNull()
})
test.each([{ count: '1', products: [] }, { count: 1, products: Array(21).fill(offProduct()) }, { count: 1 }, { count: -1, products: [] }])('invalid envelope rejected %j', async value => await expect(client({ transport: async () => response(value) }).search('pâte')).rejects.toThrow())
test('byte ceiling and malformed JSON rejected', async () => {
  for (const response of [{ status: 200, headers: { get: () => String(MAX_RESPONSE_BYTES + 1) } }, { status: 200, text: async () => '{bad' }, { status: 200, text: async () => ' '.repeat(MAX_RESPONSE_BYTES + 1) }]) await expect(client({ transport: async () => response }).search('pâte')).rejects.toThrow()
})
test('aborted late response cannot populate cache', async () => {
  let resolve; const c = client({ transport: () => new Promise(r => { resolve = r }) }), abort = new AbortController(), task = c.search('pâte', { signal: abort.signal }); await Promise.resolve(); abort.abort(); resolve(searchResponse()); await expect(task).rejects.toMatchObject({ name: 'AbortError' }); expect(c.cacheInfo().entries).toBe(0)
})
test('account guard checked after network and close clears access', async () => {
  let current = true; const c = client({ guard: () => { if (!current) throw Error('changed') }, transport: async () => { current = false; return searchResponse() } })
  await expect(c.search('pâte')).rejects.toThrow(); expect(c.cacheInfo().entries).toBe(0); c.close(); await expect(c.search('pâte')).rejects.toThrow()
})
test('shared concurrent requests bounded', async () => {
  let resolve; const c = client({ transport: () => new Promise(r => { resolve = r }) }), task = c.search('pâte'); await Promise.resolve(); await expect(c.product('3017620422003')).rejects.toMatchObject({ code: 'request-in-progress' }); resolve(searchResponse()); await task
})
test('web limiter does not reserve an independent quota; provider cooldown survives account change', async () => {
  let time = Date.now() + 86400000; const data = new Map(), storage = () => ({ getItem: k => data.get(k), setItem: (k, v) => data.set(k, v) }), a = createRateLimiter({ now: () => time, storage })
  for (let i = 0; i < 25; i++) await a.reserve('search')
  await createRateLimiter({ now: () => time, storage }).reserve('search')
  a.block(12); await expect(createRateLimiter({ now: () => time, storage }).reserve('product')).rejects.toMatchObject({ code: 'rate-limited', retryAfter: 12 })
  time += 12000; await a.reserve('product')
})

test('browser uses only same-origin relay, without credentials, referrer or fake identity parameter', async () => {
  const { directTransport } = await import('./client.js'), original = globalThis.fetch, fetcher = vi.fn(async () => searchResponse()); globalThis.fetch = fetcher
  try { await directTransport('https://world.openfoodfacts.org/cgi/search.pl?search_terms=nutella&lc=fr&page=1', { signal: new AbortController().signal }); expect(fetcher.mock.calls[0][0]).toBe('/api/nutrition/catalog/search?lc=fr&staging=0&q=nutella&page=1'); expect(fetcher.mock.calls[0][1].headers).toMatchObject({ Accept: 'application/json', 'X-openGym-Catalog-Client': expect.stringMatching(/^[a-f0-9]{32}$/) }); expect(fetcher.mock.calls[0][1]).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' }) } finally { globalThis.fetch = original }
})
test('streamed oversized response is cancelled before parsing', async () => {
  const cancel = vi.fn(async () => {}), reader = { read: async () => ({ done: false, value: new Uint8Array(MAX_RESPONSE_BYTES + 1) }), cancel, releaseLock: vi.fn() }
  const c = client({ transport: async () => ({ status: 200, body: { getReader: () => reader } }) })
  await expect(c.search('pâte')).rejects.toMatchObject({ code: 'response-too-large' }); expect(cancel).toHaveBeenCalled(); expect(c.cacheInfo().bytes).toBe(0)
})
test('modifier values remain unknown instead of becoming exact nutrient claims', async () => {
  const { normalizeProduct } = await import('./normalize.js'), { v3Product } = await import('./fixtures.test-util.js'), raw = v3Product(); raw.nutrition.aggregated_set.nutrients.fat = { value: .5, modifier: '<' }
  expect((await normalizeProduct(raw)).food.nutrients.fat).toBeNull()
})

test('transport is not a generic proxy: arbitrary destinations/paths/userinfo refused', async () => {
  const { directTransport } = await import('./client.js')
  for (const url of ['https://evil.test/cgi/search.pl', 'http://world.openfoodfacts.org/cgi/search.pl', 'https://world.openfoodfacts.org/admin', 'https://user@world.openfoodfacts.org/cgi/search.pl']) await expect(directTransport(url, { signal: new AbortController().signal })).rejects.toThrow()
})
test('browser staging selection is explicit and never sends provider basic-auth from JavaScript', async () => {
  const { directTransport } = await import('./client.js'), original = globalThis.fetch, fetcher = vi.fn(async () => searchResponse()); globalThis.fetch = fetcher
  try {
    await directTransport('https://world.openfoodfacts.net/cgi/search.pl', { signal: new AbortController().signal }); expect(fetcher.mock.calls[0][0]).toContain('staging=1'); expect(fetcher.mock.calls[0][1].headers.Authorization).toBeUndefined()
    await directTransport('https://world.openfoodfacts.org/cgi/search.pl', { signal: new AbortController().signal }); expect(fetcher.mock.calls[1][1].headers.Authorization).toBeUndefined()
  } finally { globalThis.fetch = original }
})

test('a transport timeout is a visible network failure, not a voluntary cancellation', async () => {
  vi.useFakeTimers()
  try {
    const c = client({ transport: async (_, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })) })
    const rejected = expect(c.search('pâte')).rejects.toMatchObject({ code: 'network-error' })
    await vi.advanceTimersByTimeAsync(20000); await rejected
    expect(c.cacheInfo().entries).toBe(0); c.close()
  } finally { vi.useRealTimers() }
})


test.each([429, 503])('default web transport exposes HTTP %i without provider CORS headers', async status => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>upstream error</html>', { status, headers: { 'Retry-After': '90' } })))
  try {
    const c = client({}); await expect(c.search('nutella')).rejects.toMatchObject({ code: status === 503 ? 'provider-unavailable' : 'rate-limited', retryAfter: 90 })
    expect(fetch.mock.calls[0][0]).toContain('/api/nutrition/catalog/search?'); expect(fetch).toHaveBeenCalledTimes(1)
  } finally { vi.unstubAllGlobals() }
})
test('default web transport simulated nutella query normalizes results and caches without external browser fetch', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ count: 1, products: [offProduct({ product_name: 'Nutella', product_name_fr: 'Nutella', product_name_en: 'Nutella' })] }))))
  try {
    const c = client({}); const r = await c.search('nutella'); expect(r.products[0].name).toBe('Nutella')
    expect((await c.search('nutella')).cached).toBe(true); expect(fetch).toHaveBeenCalledTimes(1)
    const u = new URL(fetch.mock.calls[0][0], 'http://localhost'); expect(u.searchParams.get('q')).toBe('nutella'); expect(u.searchParams.has('User-Agent')).toBe(false)
  } finally { vi.unstubAllGlobals() }
})
test('default web transport network failure remains an error and creates no cache', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
  try { const c = client({}); await expect(c.search('nutella')).rejects.toMatchObject({ code: 'network-error' }); expect(c.cacheInfo().entries).toBe(0) }
  finally { vi.unstubAllGlobals() }
})

test('web searches have no artificial per-request delay or quota for relay cache hits', async () => {
  const time = Date.now() + 2 * 86400000, limits = createRateLimiter({ now: () => time, storage: () => null }), transport = vi.fn(async () => searchResponse())
  const c = client({ transport, limiter: limits, now: () => time })
  for (let i = 0; i < 25; i++) await c.search('different' + i)
  expect(transport).toHaveBeenCalledTimes(25)
})
test('short exhaustion Retry-After does not become an artificial sixty seconds', async () => {
  const limits = limiter(), c = client({ transport: async () => response({}, 429, { 'retry-after': '3' }), limiter: limits })
  await expect(c.search('nutella')).rejects.toMatchObject({ code: 'rate-limited', retryAfter: 3 }); expect(limits.block).toHaveBeenCalledWith(3)
})
test('local relay abuse response has no external quota countdown or persistent cooldown', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 'catalog-client-rate-limited' }), { status: 429 })))
  try {
    const limits = limiter(), c = client({ limiter: limits }); await expect(c.search('nutella')).rejects.toMatchObject({ code: 'request-in-progress' }); expect(limits.block).not.toHaveBeenCalled()
  } finally { vi.unstubAllGlobals() }
})
test('native rolling budget is burstable, counts duplicate timestamps and survives limiter instances', async () => {
  let time = Date.now() + 3 * 86400000; const data = new Map(), storage = () => ({ getItem: k => data.get(k), setItem: (k, v) => data.set(k, v) })
  const a = createRateLimiter({ now: () => time, storage, external: true })
  for (let i = 0; i < 10; i++) await a.reserve('search')
  await expect(createRateLimiter({ now: () => time, storage, external: true }).reserve('search')).rejects.toMatchObject({ code: 'rate-limited', retryAfter: 60 })
  for (let i = 0; i < 15; i++) await a.reserve('product')
  await expect(a.reserve('product')).rejects.toMatchObject({ retryAfter: 60 }); time += 60000; await a.reserve('search'); await a.reserve('product')
})

test('relay search exhaustion does not hide server cache or the independent product budget', async () => {
  vi.stubGlobal('fetch', vi.fn(async url => {
    if (url.includes('q=exhausted')) return new Response('{}', { status: 429, headers: { 'Retry-After': '12' } })
    if (url.includes('/product?')) return new Response(JSON.stringify({ status: 'success', product: offProduct() }))
    return new Response(JSON.stringify({ count: 1, products: [offProduct()] }))
  }))
  try {
    const c = createFoodCatalog(); clients.push(c)
    await expect(c.search('exhausted')).rejects.toMatchObject({ retryAfter: 12 })
    expect((await c.product('3017620422003')).product.food).toBeTruthy()
    expect((await c.search('cached by another user')).products).toHaveLength(1)
    expect(fetch).toHaveBeenCalledTimes(3)
  } finally { vi.unstubAllGlobals() }
})

test('cancelled native reservations consume nothing before dispatch and keep real attempts counted', async () => {
  const time = Date.now() + 4 * 86400000, controller = new AbortController(), dispatch = vi.fn(() => Promise.resolve('reply'))
  controller.abort(); const a = createRateLimiter({ external: true, now: () => time, storage: () => null })
  await expect(a.reserve('search', { signal: controller.signal, dispatch })).rejects.toMatchObject({ name: 'AbortError' }); expect(dispatch).not.toHaveBeenCalled()
  const sent = await a.reserve('search', { dispatch }); expect(await sent.pending).toBe('reply')
  for (let i = 0; i < 9; i++) await a.reserve('search')
  await expect(a.reserve('search')).rejects.toMatchObject({ retryAfter: 60 }); expect(dispatch).toHaveBeenCalledTimes(1)
})

test.each([['Thu, 01 Jan 1970 00:00:01 GMT', 0], ['-1', 60]])('HTTP-date/signed backoff %s is handled without accidental fixed pacing', async (header, expected) => {
  const limits = limiter(), c = client({ transport: async () => response({}, 503, { 'retry-after': header }), limiter: limits })
  await expect(c.search('nutella')).rejects.toMatchObject({ retryAfter: expected }); expect(limits.block).toHaveBeenCalledWith(expected, 'search')
})

test('failed native quota metadata writes cannot reload a stale bucket and grant extra requests', async () => {
  const time = Date.now() + 5 * 86400000, data = new Map(); let broken = false
  const storage = () => ({ getItem: k => data.get(k), setItem: (k, v) => { if (broken) throw Error('quota full'); data.set(k, v) } })
  const a = createRateLimiter({ external: true, now: () => time, storage })
  for (let i = 0; i < 8; i++) await a.reserve('search')
  broken = true; await a.reserve('search'); await a.reserve('search')
  await expect(a.reserve('search')).rejects.toMatchObject({ retryAfter: 60 })
  await expect(createRateLimiter({ external: true, now: () => time, storage }).reserve('search')).rejects.toMatchObject({ retryAfter: 60 })
})

test('503 availability failure is not displayed as depleted quota, and a relay retry may recover', async () => {
  let failed = true
  vi.stubGlobal('fetch', vi.fn(async () => failed ? new Response(JSON.stringify({ code: 'catalog-provider-unavailable' }), { status: 503, headers: { 'Retry-After': '60' } }) : new Response(JSON.stringify({ count: 1, products: [offProduct()] }))))
  try {
    const c = createFoodCatalog(); clients.push(c)
    await expect(c.search('nutella')).rejects.toMatchObject({ code: 'provider-unavailable', retryAfter: 60 })
    failed = false; expect((await c.search('nutella')).products).toHaveLength(1); expect(fetch).toHaveBeenCalledTimes(2)
  } finally { vi.unstubAllGlobals() }
})

test('native search availability cooldown is persisted per endpoint and does not consume/block barcode allowance', async () => {
  let time = Date.now() + 6 * 86400000; const data = new Map(), storage = () => ({ getItem: k => data.get(k), setItem: (k, v) => data.set(k, v) })
  const a = createRateLimiter({ now: () => time, storage, external: true }); a.block(60, 'search')
  await expect(a.reserve('search')).rejects.toMatchObject({ code: 'provider-unavailable', retryAfter: 60 })
  await createRateLimiter({ now: () => time, storage, external: true }).reserve('product')
  time += 60000; await a.reserve('search')
})

test('capability discovery is anonymous, bounded and never queries the provider',async()=>{
  const transport=vi.fn(async()=>searchResponse()), probe=vi.fn(async()=>response({schemaVersion:1,textSearch:'local'})), c=client({transport,capabilitiesTransport:probe})
  expect(await c.capabilities()).toEqual({textSearch:'local'}); expect(transport).not.toHaveBeenCalled()
  expect(probe.mock.calls[0][0]).toBe('/api/nutrition/catalog/capabilities'); expect(probe.mock.calls[0][1].credentials).toBe('omit')
})
test.each([404,503])('old or unavailable capability endpoint %i keeps explicit remote behaviour',async status=>{
  const c=client({capabilitiesTransport:async()=>response({},status)})
  expect(await c.capabilities()).toEqual({textSearch:'explicit-remote'})
})
test('untrusted capability fields or version cannot enable autocomplete',async()=>{
  for (const body of [{schemaVersion:2,textSearch:'local'},{schemaVersion:1,textSearch:'local',secret:'bad'},{schemaVersion:1,textSearch:'other'}]) {
    const c=client({capabilitiesTransport:async()=>response(body)}); expect((await c.capabilities()).textSearch).toBe('explicit-remote')
  }
})
test('aborted old request cannot clear the replacement request concurrency guard',async()=>{
  const pending=[]; const c=client({transport:()=>new Promise(resolve=>pending.push(resolve))}), controller=new AbortController()
  const old=c.search('first',{signal:controller.signal}); const oldError=expect(old).rejects.toMatchObject({name:'AbortError'})
  await new Promise(r=>setTimeout(r,0)); controller.abort(); const replacement=c.search('second'); await new Promise(r=>setTimeout(r,0))
  pending[0](searchResponse()); await oldError
  await expect(c.search('third')).rejects.toMatchObject({code:'request-in-progress'})
  pending[1](searchResponse()); await replacement
})

test('local-only browser suggestions carry a server-enforced guard, not a provider query parameter',async()=>{
  const {directTransport}=await import('./client.js');vi.stubGlobal('fetch',vi.fn(async()=>new Response('{"count":0,"products":[]}')))
  try {await directTransport('https://world.openfoodfacts.org/cgi/search.pl?search_terms=nutela',{signal:new AbortController().signal,localOnly:true});expect(fetch.mock.calls[0][0]).toContain('local=1');expect(fetch.mock.calls[0][0]).toMatch(/^\/api\/nutrition\/catalog\/search/)}finally{vi.unstubAllGlobals()}
})

test('v3 selection without a declared reference cannot invent grams from *_100g',async()=>{
 const raw=offProduct({nutrition_data_per:null});const c=client({transport:async()=>response({status:'success',product:raw})});
 expect((await c.product(raw.code)).product.food).toBeNull();
})
test('public cache failure carries no fabricated 60-second provider wait',async()=>{
 const c=client({transport:async()=>Object.assign(response({code:'catalog-cache-unavailable'},503),{catalogRelay:true})});
 await expect(c.product('3017620422003')).rejects.toMatchObject({code:'provider-unavailable'});
 try{await c.product('3017620422003')}catch(e){expect(e.retryAfter).toBeUndefined()}
})
test('cache validation metadata cannot claim success for an unusable fiche',async()=>{
 const raw=offProduct({nutrition_data_per:null});const c=client({transport:async()=>response({status:'success',product:raw,opengym_cache:{schemaVersion:1,capturedAt:'2026-10-12T00:00:00.000Z',status:'validated',reference:{amount:100,unit:'g'},stale:false}})});
 await expect(c.product(raw.code)).rejects.toMatchObject({code:'invalid-response'});
})
