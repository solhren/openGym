// Optional Vite environment preserves plain Node benchmark/service imports.
const MOBILE = import.meta.env?.VITE_MOBILE === '1'
import { createPublicCatalogRelay } from './public-relay.js'
import { CatalogError, fail, inspectExternal, normalizeProduct, barcode } from './normalize.js'
import { normalizeLocalProduct, localEnvelope } from './local-product.js'
import {isLocalCatalogId,sameCatalogBarcode} from './identity.js'
import {PERSONAL_BETA} from '../../personal-beta.js'

export const OFF_IDENTITY = `openGym/${typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '1.4.1'} (https://github.com/solhren/openGym)`
export const OFF_ORIGIN = import.meta.env?.VITE_OFF_STAGING === '1' ? 'https://world.openfoodfacts.net' : 'https://world.openfoodfacts.org'
export const OFF_FIELDS = 'code,product_name,product_name_fr,product_name_en,generic_name,brands,nutriments,nutrition,nutrition_data_per,serving_size,serving_quantity,serving_quantity_unit,product_quantity_unit,image_front_small_url,data_quality_errors_tags,no_nutrition_data'
export const MAX_RESPONSE_BYTES = 1024 * 1024
const encoder = new TextEncoder(), rateKey = 'opengym-off-rate-v2'
let nativeActive = null
let active = null, rate = { search: [], product: [], blocked: 0, unavailable: { search: 0, product: 0 } }
let relayClient = null
const nativeBudget = createRateLimiter({ external: true })
const aborted = () => new DOMException('Aborted', 'AbortError')
function bridgeBody(data) {
  if (typeof data === 'string') { fail(encoder.encode(data).length <= MAX_RESPONSE_BYTES, 'response-too-large'); return data }
  // Capacitor 7 parses application/json regardless of responseType:'text' on both
  // native platforms. Inspect before serialization and bound accumulation while
  // encoding, rather than allocating an unbounded second copy of bridge data.
  inspectExternal(data)
  let bytes = 0
  const text = JSON.stringify(data, (key, value) => {
    fail(key.length <= 10000, 'invalid-response')
    bytes += encoder.encode(JSON.stringify(key)).length + (typeof value === 'string' ? encoder.encode(JSON.stringify(value)).length : 24) + 2
    fail(bytes <= MAX_RESPONSE_BYTES, 'response-too-large')
    return value
  })
  fail(typeof text === 'string' && encoder.encode(text).length <= MAX_RESPONSE_BYTES, 'response-too-large')
  return text
}
export async function directTransport(url, { signal, localOnly = false }) {
  const target = new URL(url)
  fail(['https://world.openfoodfacts.org', 'https://world.openfoodfacts.net'].includes(target.origin) && !target.username && !target.password && (/^\/api\/v3\/product\/\d{8,14}$/.test(target.pathname) || target.pathname === '/cgi/search.pl'), 'invalid-query')
  const headers = { Accept: 'application/json', ...(target.origin === 'https://world.openfoodfacts.net' ? { Authorization: 'Basic b2ZmOm9mZg==' } : {}) }
  // Browsers cannot reliably set User-Agent or read provider error pages without
  // CORS. Only native HTTP goes directly to OFF; web uses the bounded public relay.
  const browser = () => {
    if (!relayClient && globalThis.crypto?.getRandomValues) relayClient = [...crypto.getRandomValues(new Uint8Array(16))].map(n => n.toString(16).padStart(2, '0')).join('')
    const product = target.pathname.startsWith('/api/v3/product/')
    const params = new URLSearchParams({ lc: target.searchParams.get('lc') || 'fr', staging: target.origin.endsWith('.net') ? '1' : '0' })
    if (localOnly && !product) params.set('local', '1')
    if (product) params.set('code', target.pathname.split('/').at(-1))
    else { params.set('q', target.searchParams.get('search_terms') || ''); params.set('page', target.searchParams.get('page') || '1') }
    return fetch(`/api/nutrition/catalog/${product ? 'product' : 'search'}?${params}`, { signal, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', headers: { Accept: 'application/json', ...(relayClient ? { 'X-openGym-Catalog-Client': relayClient } : {}) } }).then(response => ({ status: response.status, headers: response.headers, body: response.body, text: () => response.text(), catalogRelay: true }))
  }
  if (!MOBILE) return browser()
  fail(!localOnly, 'provider-unavailable')
  const { Capacitor, CapacitorHttp } = await import('@capacitor/core')
  if (!Capacitor.isNativePlatform()) return browser()
  // The bridge cannot abort its socket. Consumers reject immediately and ignore late data;
  // read/connect timeouts bound the native request. It receives no openGym credentials.
  if (signal.aborted) throw aborted()
  fail(!nativeActive, 'request-in-progress')
  const reservation = {}; nativeActive = reservation
  let pending
  try {
    const dispatched = await nativeBudget.reserve(target.pathname === '/cgi/search.pl' ? 'search' : 'product', { signal,
      dispatch: () => CapacitorHttp.get({ url, headers: { ...headers, 'User-Agent': OFF_IDENTITY }, responseType: 'text', readTimeout: 20000, connectTimeout: 15000, disableRedirects: true }) })
    pending = dispatched.pending
  } catch (error) { if (nativeActive === reservation) nativeActive = null; throw error }
  nativeActive = pending
  const release = () => { if (nativeActive === pending) nativeActive = null }
  pending.then(release, release)
  let listener
  const cancellation = new Promise((_, reject) => { listener = () => reject(aborted()); signal.addEventListener('abort', listener, { once: true }); if (signal.aborted) listener() })
  try {
    const result = await Promise.race([pending, cancellation])
    if (signal.aborted) throw aborted()
    // Error bodies are unnecessary: preserve status/Retry-After even if a 429/503
    // page is malformed or large. The coordinator must apply its cooldown first.
    const text = result.status === 200 ? bridgeBody(result.data) : ''
    return { status: result.status, headers: { get: key => Object.entries(result.headers ?? {}).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1] }, text: async () => text }
  } finally { signal.removeEventListener('abort', listener) }
}
/** Provider cooldown state and optional direct-HTTP installation budget. Web relay
 * quota decisions stay on the server. Native reservations use Web Locks when
 * available. Cache hits never call reserve; state contains no account identity. */
export function createRateLimiter({ now = Date.now, storage = () => globalThis.localStorage, external = false } = {}) {
  const merge = (memory, stored, limit) => {
    const counts = values => { const m = new Map(); for (const t of values) if (t > now() - 60000) m.set(t, (m.get(t) || 0) + 1); return m }
    const combined = counts(memory)
    for (const [time, count] of counts(stored)) combined.set(time, Math.max(count, combined.get(time) || 0))
    // Preserve observed attempts when a write failed and storage still has an old
    // bucket. Multiplicity matters: a burst can have identical millisecond stamps.
    return [...combined].flatMap(([t, n]) => Array(n).fill(t)).sort((a, b) => a - b).slice(-limit)
  }
  const load = () => {
    try {
      const text = storage()?.getItem(rateKey), saved = text?.length <= 4096 ? JSON.parse(text) : null
      if (saved && Number.isFinite(saved.blocked) && saved.blocked >= 0 && ['search', 'product'].every(k => Array.isArray(saved[k]) && saved[k].length <= (k === 'search' ? 10 : 15) && saved[k].every(t => Number.isFinite(t) && t >= 0))) {
        rate = { search: merge(rate.search, saved.search, 10), product: merge(rate.product, saved.product, 15), blocked: Math.max(rate.blocked, saved.blocked), unavailable: Object.fromEntries(['search', 'product'].map(k => [k, Math.max(rate.unavailable[k], Number.isFinite(saved.unavailable?.[k]) && saved.unavailable[k] >= 0 ? saved.unavailable[k] : 0)])) }
      }
      // v1 stored artificial per-request due times. Ignore those, but preserve its
      // genuine provider cooldown when upgrading an existing installation.
      const old = storage()?.getItem('opengym-off-rate-v1')
      const legacy = old?.length <= 4096 ? JSON.parse(old) : null
      if (Number.isFinite(legacy?.blocked)) rate.blocked = Math.max(rate.blocked, legacy.blocked)
    } catch { /* bounded memory fallback */ }
  }
  const save = () => { try { storage()?.setItem(rateKey, JSON.stringify(rate)) } catch { /* memory fallback */ } }
  const reserve = (kind, { signal, dispatch } = {}) => {
    if (signal?.aborted) throw aborted()
    load(); const time = now()
    let due = rate.blocked
    if (external) {
      fail(['search', 'product'].includes(kind), 'invalid-query')
      rate[kind] = rate[kind].filter(t => t > time - 60000)
      if (rate[kind].length >= (kind === 'search' ? 10 : 15)) due = Math.max(due, rate[kind][0] + 60000)
    }
    const unavailable = rate.unavailable[kind] || 0, deadline = Math.max(due, unavailable)
    if (time < deadline) throw new CatalogError(unavailable >= due ? 'provider-unavailable' : 'rate-limited', { retryAfter: Math.ceil((deadline - time) / 1000) })
    if (external) { rate[kind].push(time); save() }
    // Reserve and dispatch inside the same lock callback, without awaiting HTTP.
    // Aborts before this callback spend nothing; post-dispatch aborts keep the slot.
    if (dispatch) return { pending: dispatch() }
  }
  return {
    async reserve(kind, options) { if (globalThis.navigator?.locks) return navigator.locks.request(rateKey, () => reserve(kind, options)); return reserve(kind, options) },
    block(seconds, kind) { load(); if (kind === 'search' || kind === 'product') rate.unavailable[kind] = Math.max(rate.unavailable[kind], now() + seconds * 1000); else rate.blocked = Math.max(rate.blocked, now() + seconds * 1000); save() },
  }
}
async function readJson(response) {
  const announced = response.headers?.get('content-length')
  if (announced) fail(Number.isFinite(Number(announced)) && Number(announced) <= MAX_RESPONSE_BYTES, 'response-too-large')
  let text
  if (response.body?.getReader) {
    const reader = response.body.getReader(), chunks = []; let size = 0
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; fail(chunks.length < 4096 && size <= MAX_RESPONSE_BYTES, 'response-too-large'); chunks.push(value) }
      const bytes = new Uint8Array(size); let at = 0
      for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length }
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } finally { try { await reader.cancel() } catch { /* already closed */ } reader.releaseLock() }
  } else { text = await response.text(); fail(encoder.encode(text).length <= MAX_RESPONSE_BYTES, 'response-too-large') }
  let result; try { result = JSON.parse(text) } catch { throw new CatalogError('invalid-response') }
  inspectExternal(result); return result
}
/** Account-owned, reconstructible memory cache. Used products are persisted separately
 * in savedFoods, not here. A close aborts requests and discards all search data. */
export function createFoodCatalog({ transport = directTransport, guard = () => {}, limiter = null, now = Date.now, capabilitiesTransport, serverOrigin = null,
  localOnlyV1 = import.meta.env?.VITE_NUTRITION_LOCAL_V1 === '1', localTransport } = {}) {
  const originalDefault = transport === directTransport
  // Guest Android can use the same public catalogue without pairing an account.
  // Explicit build-time endpoint is public configuration, never a credential.
  const publicOrigin = serverOrigin || import.meta.env?.VITE_NUTRITION_CATALOG_ORIGIN || null
  // An explicit account server uses the existing app session. The build-time
  // public endpoint remains an anonymous guest relay, independent of pairing.
  const pairedMobile = MOBILE && !PERSONAL_BETA && !!serverOrigin && originalDefault
  if (pairedMobile) {
    const base = new URL(serverOrigin)
    fail(['https:', 'http:'].includes(base.protocol) && !base.username && !base.password && !base.search && !base.hash && serverOrigin === base.origin + base.pathname.replace(/\/$/, ''), 'invalid-query')
  }
  const personalRead=async(path,options)=>{const {authenticatedCatalogFetch}=await import('../../api.js');const r=await authenticatedCatalogFetch(path,options);return {status:r.status,headers:r.headers,body:r.body,text:()=>r.text(),catalogRelay:true}}
  const pairedRead=async(path,options)=>{const {authenticatedCatalogFetch}=await import('../../api.js');current();const r=await authenticatedCatalogFetch(path,{...options,expectedBase:serverOrigin});return {status:r.status,headers:r.headers,body:r.body,text:()=>r.text(),catalogRelay:true}}
  const accountRead = PERSONAL_BETA ? personalRead : pairedMobile ? pairedRead : null
  const mobileRelay = MOBILE && !PERSONAL_BETA && !pairedMobile && publicOrigin && originalDefault ? createPublicCatalogRelay(publicOrigin) : null
  let localRelay = false
  let localV1 = localOnlyV1||PERSONAL_BETA, localReady = false
  const localRead = localTransport ?? accountRead ?? mobileRelay?.localRequest ?? ((path, options) => fetch(path, { signal:options.signal,credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',headers:{Accept:'application/json'} }).then(r=>({status:r.status,headers:r.headers,body:r.body,text:()=>r.text(),catalogRelay:true})))
  if (mobileRelay) transport = (url, options) => localRelay || options.localOnly ? mobileRelay.transport(url, options) : directTransport(url, options)
  if (pairedMobile) transport = (url, options) => {
    if (!localRelay && !options.localOnly) return directTransport(url, options)
    const target = new URL(url), product = /^\/api\/v3\/product\/\d{8,14}$/.test(target.pathname)
    fail(target.origin === OFF_ORIGIN && !target.username && !target.password && (product || target.pathname === '/cgi/search.pl'), 'invalid-query')
    const params = new URLSearchParams({ lc: target.searchParams.get('lc') || 'fr', staging: '0' })
    if (product) params.set('code', target.pathname.split('/').at(-1))
    else { params.set('q', target.searchParams.get('search_terms') || ''); params.set('page', target.searchParams.get('page') || '1'); if (options.localOnly) params.set('local', '1') }
    return pairedRead(`/api/nutrition/catalog/${product ? 'product' : 'search'}?${params}`, options)
  }
  const cache = new Map(), controllers = new Set(), throttle = limiter ?? createRateLimiter(); let closed = false, bytes = 0
  const current = () => { fail(!closed, 'session-changed'); guard() }
  const remember = (key, value, ttl) => {
    const size = encoder.encode(JSON.stringify(value)).length
    if (size > MAX_RESPONSE_BYTES) return
    if (cache.has(key)) bytes -= cache.get(key).size
    cache.delete(key); cache.set(key, { value, size, expires: now() + ttl }); bytes += size
    while (cache.size > 50 || bytes > MAX_RESPONSE_BYTES) { const first = cache.keys().next().value; bytes -= cache.get(first).size; cache.delete(first) }
  }
  const request = async (kind, key, makeUrl, options, normalize) => {
    current(); if (options.signal?.aborted) throw aborted()
    const hit = options.fresh ? null : cache.get(key)
    if (hit && now() < hit.expires) { cache.delete(key); cache.set(key, hit); return structuredClone({ ...hit.value, cached: true }) }
    fail(!active || active.signal.aborted, 'request-in-progress')
    const controller = new AbortController(), abort = () => controller.abort(); active = controller; controllers.add(controller)
    options.signal?.addEventListener('abort', abort, { once: true })
    let timedOut = false
    const timeout = setTimeout(() => { timedOut = true; abort() }, 20000)
    try {
      if (!options.localRequest) await limiter?.reserve(kind, { signal: controller.signal }); current(); if (controller.signal.aborted) throw aborted()
      const response = await (options.localRequest ? localRead : transport)(makeUrl(), { signal: controller.signal, localOnly:options.localOnly === true }); current()
      if ([429, 503].includes(response.status)) {
        if (response.catalogRelay && !response.headers?.get('retry-after')) {
          const body = await readJson(response); current(); if (controller.signal.aborted) throw aborted()
          if (body.code === 'catalog-client-rate-limited') throw new CatalogError('request-in-progress')
          if (['catalog-local-unavailable','catalog-local-invalid-response','catalog-cache-unavailable'].includes(body.code)) throw new CatalogError('provider-unavailable')
        }
        const retry = response.headers?.get('retry-after'), parsed = /^\d+$/.test(retry ?? '') ? Number(retry) : /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(retry ?? '') ? (Date.parse(retry) - now()) / 1000 : NaN
        const seconds = Number.isFinite(parsed) ? Math.min(604800, Math.max(0, Math.ceil(parsed))) : 60
        // The relay checks cache/dedup before quota. Locally blocking a web request
        // would hide its public cache and incorrectly block the other budget kind.
        if (!response.catalogRelay) { if (response.status === 503) throttle.block(seconds, kind); else throttle.block(seconds) }
        throw new CatalogError(response.status === 503 ? 'provider-unavailable' : 'rate-limited', { retryAfter: Math.ceil(seconds) })
      }
      if (response.status === 404) throw new CatalogError('not-found')
      if (options.localRequest && response.status === 409) {
        const body = await readJson(response)
        throw new CatalogError(body.code === 'catalog-ambiguous-barcode' ? 'ambiguous-barcode' : 'network-error')
      }
      fail(response.status === 200, 'network-error')
      const json = await readJson(response); current(); if (controller.signal.aborted) throw aborted()
      const value = await normalize(json); current(); if (controller.signal.aborted) throw aborted()
      if (!options.fresh) remember(key, value, kind === 'search' ? 300000 : 86400000)
      return structuredClone({ ...value, cached: false })
    } catch (error) { if (timedOut && !closed && !options.signal?.aborted) throw new CatalogError('network-error'); if (controller.signal.aborted) throw aborted(); if (error instanceof CatalogError || error?.issues) throw error; throw new CatalogError('network-error') }
    finally { if (active === controller) active = null; clearTimeout(timeout); options.signal?.removeEventListener('abort', abort); controllers.delete(controller) }
  }
  const url = (path, language) => {
    const u = new URL(path, OFF_ORIGIN)
    u.searchParams.set('fields', `${OFF_FIELDS},product_name_${language}`); u.searchParams.set('lc', language); return u
  }
  const lang = value => /^[a-z]{2}$/.test(value ?? '') ? value : 'fr'
  const localProduct = (id, language, options, byCode = false) => {
    fail(localReady, 'provider-unavailable')
    if (byCode) barcode(id)
    else fail(isLocalCatalogId(id),'invalid-query')
    // Local UUIDs survive catalogue revisions. A selection must not reuse a
    // 24-hour descriptor after a reader restart/quality publication. Previously
    // consumed Foods remain offline in durable savedFoods, independently.
    return request('product', `local-product:${language}:${id}`, () => `/api/nutrition/catalog/product?${new URLSearchParams({[byCode?'code':'id']:id,lc:language,staging:'0'})}`, {...options,localRequest:true,fresh:true}, json => {
      const value = localEnvelope(json), product = normalizeLocalProduct(value.product)
      fail(byCode ? sameCatalogBarcode(product.code,id) : product.id === id||product.lookupId===id,'barcode-mismatch')
      return {product}
    })
  }
  return {
    get localOnly() { return localV1 },
    get localReady() { return localReady },
    /** Fail closed on old/offline servers. This probe never consumes OFF quota;
     * the personal profile authenticates it with the existing account session. */
    async capabilities({ signal } = {}) {
      current(); if (signal?.aborted) throw aborted()
      const unavailable = () => { localReady=false; return localV1 ? {textSearch:'local',selection:'local-only',available:false} : {textSearch:'explicit-remote'} }
      if (OFF_ORIGIN.endsWith('.net') || (MOBILE && !mobileRelay && !accountRead && !capabilitiesTransport) || (!capabilitiesTransport && !originalDefault)) return unavailable()
      const controller = new AbortController(), abort = () => controller.abort(); controllers.add(controller)
      signal?.addEventListener('abort', abort, { once:true }); if (signal?.aborted) abort()
      const timeout = setTimeout(abort, 3000)
      try {
        const response = await (capabilitiesTransport ?? accountRead ?? mobileRelay?.capabilities ?? fetch)('/api/nutrition/catalog/capabilities', { signal:controller.signal, credentials:'omit', redirect:'error', referrerPolicy:'no-referrer', headers:{Accept:'application/json'} })
        current(); if (controller.signal.aborted) throw aborted()
        if (response.status !== 200) return unavailable()
        const body = await readJson(response); current(); if (controller.signal.aborted) throw aborted()
        if (body.schemaVersion === 2) {
          fail(Object.keys(body).sort().join(',') === 'productIds,provider,schemaVersion,selection,textSearch' && body.textSearch === 'local' && body.provider === 'wger' && body.selection === 'local-only' && body.productIds === true,'invalid-response')
          if (!localV1) { cache.clear(); bytes = 0 }
          localRelay = true; localV1 = true; localReady = true
          return {...body,available:true}
        }
        if (localV1) return unavailable()
        fail(body.schemaVersion === 1 && Object.keys(body).sort().join(',') === 'schemaVersion,textSearch' && ['local','explicit-remote'].includes(body.textSearch), 'invalid-response')
        localRelay = body.textSearch === 'local'
        return { textSearch:body.textSearch }
      } catch (error) { current(); if (signal?.aborted) throw aborted(); return unavailable() }
      finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); controllers.delete(controller) }
    },
    search(query, { page = 1, language = 'fr', ...options } = {}) {
      fail(typeof query === 'string', 'invalid-query'); query = query.normalize('NFC').trim().replace(/\s+/g, ' ')
      fail(query.length >= 2 && query.length <= 120 && Number.isInteger(page) && page > 0 && page <= 20, 'invalid-query'); language = lang(language)
      if (localV1) {
        fail(localReady,'provider-unavailable')
        return request('search', `local-search:${language}:${query.toLocaleLowerCase()}:${page}`, () => `/api/nutrition/catalog/search?${new URLSearchParams({q:query,page:String(page),lc:language,staging:'0',local:'1'})}`, {...options,localRequest:true}, json => {
          const value = localEnvelope(json)
          fail(Array.isArray(value.products) && value.products.length <= 20 && Number.isSafeInteger(value.count) && value.count >= value.products.length && value.count <= 5000000 && value.page === page && value.pageSize === 20 && value.literalOnly === true && value.registryVerified === true && /^[a-f0-9]{64}$/.test(value.catalogueVersion),'invalid-response')
          const products = value.products.map(normalizeLocalProduct)
          fail(new Set(products.map(p=>p.id)).size === products.length,'invalid-response')
          return {products,rejected:0,page,hasMore:page<20 && page*20<value.count}
        })
      }
      return request('search', `search:${options.localOnly === true ? 'local:' : ''}${language}:${query.toLocaleLowerCase()}:${page}`, () => {
        const u = url('/cgi/search.pl', language); Object.entries({ search_terms: query, action: 'process', json: '1', page_size: '20', page: String(page) }).forEach(([k, v]) => u.searchParams.set(k, v)); return u.href
      }, options, async json => {
        fail(Array.isArray(json.products) && json.products.length <= 20 && Number.isSafeInteger(json.count) && json.count >= 0 && json.count <= 10000000, 'invalid-response')
        const products = []; let rejected = 0; const codes = new Set()
        for (const raw of json.products) {
          try { const product = await normalizeProduct(raw, { language, origin: OFF_ORIGIN }); if (!codes.has(product.code)) { products.push(product); codes.add(product.code) } }
          catch (error) { if (!(error instanceof CatalogError)) throw error; rejected++ }
        }
        return { products, rejected, page, hasMore: page < 20 && page * 20 < json.count }
      })
    },
    product(code, { language = 'fr', ...options } = {}) {
      barcode(code); language = lang(language)
      if(localV1)return localProduct(code,language,options,true)
      return request('product', `product:${language}:${code}`, () => url(`/api/v3/product/${code}`, language).href, options, async json => {
        fail(['success', 'success_with_warnings'].includes(json.status), json.status === 'failure' ? 'not-found' : 'invalid-response')
        fail(json.product && !Array.isArray(json.product), 'invalid-response')
        const meta = json.opengym_cache
        if (meta != null) fail(meta.schemaVersion === 1 && Object.keys(meta).sort().join(',') === 'capturedAt,reference,schemaVersion,stale,status' && ['validated','unusable'].includes(meta.status) && typeof meta.stale === 'boolean' && typeof meta.capturedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(meta.capturedAt) && Number.isFinite(Date.parse(meta.capturedAt)), 'invalid-response')
        const product = await normalizeProduct(json.product, { language, expectedCode: code, origin: OFF_ORIGIN, requireExplicitReference: true })
        if (meta) fail((!!product.food === (meta.status === 'validated')) && JSON.stringify(product.food?.reference ?? null) === JSON.stringify(meta.reference), 'invalid-response')
        return { product, ...(meta ? { validation:meta } : {}) }
      })
    },
    localProduct(id, {language='fr',...options} = {}) { fail(localV1,'provider-unavailable'); return localProduct(id,lang(language),options) },
    clear() { cache.clear(); bytes = 0 },
    close() { closed = true; controllers.forEach(c => c.abort()); cache.clear(); bytes = 0 },
    cacheInfo: () => ({ entries: cache.size, bytes }),
  }
}
