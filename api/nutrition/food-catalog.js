// Public read-only OFF relay. No session, user document, client URL or forwarded
// credential ever enters a provider request. Quotas/cache are shared by this process.
import fs from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { createWindow } from '../rate-limit.js';

const VERSION = JSON.parse(fs.readFileSync(new NodeURL('../package.json', import.meta.url), 'utf8')).version;
export const CATALOG_IDENTITY = `openGym/${VERSION} (https://github.com/solhren/openGym)`;
export const CATALOG_FIELDS = 'code,product_name,product_name_fr,product_name_en,generic_name,brands,nutriments,nutrition,nutrition_data_per,serving_size,serving_quantity,serving_quantity_unit,product_quantity_unit,image_front_small_url,data_quality_errors_tags,no_nutrition_data';
export const CATALOG_MAX_BYTES = 1024 * 1024;
const CACHE_BYTES = 8 * CATALOG_MAX_BYTES;
class CatalogHttpError extends Error {
  constructor(status, code, retryAfter, source) { super(code); Object.assign(this, { status, code, retryAfter, source }); }
}
export { CatalogHttpError };
const reject = (valid, status = 400, code = 'catalog-invalid-query') => { if (!valid) throw new CatalogHttpError(status, code); };

/** Production logs only actual provider/network failures by default. Opt-in trace
 * logs scheduling/cooldown decisions; never include queries, barcodes, IDs of users,
 * peer tags, URLs, headers, provider bodies or raw exception messages. */
export function createCatalogLogger({ trace = process.env.OFF_CATALOG_TRACE === '1', sink = line => console.warn(line) } = {}) {
  return event => {
    if (trace || event.event === 'provider-error' || (event.event === 'transport-error' && event.source !== 'request-cancelled')) {
      try { sink(JSON.stringify({ component: 'nutrition-catalog', ...event })); } catch { /* diagnostics must not affect service */ }
    }
  };
}
const transportCategory = error => {
  const code = error?.cause?.code || error?.code;
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) return 'dns';
  if (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(code)) return 'connection';
  if (['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(code)) return 'tls';
  return 'other';
};

function providerQuery(kind, input, productApiVersion = '3') {
  reject(['3','3.5'].includes(productApiVersion));
  reject(input.length <= 2048);
  const params = new NodeURL(input, 'http://x').searchParams;
  const allowed = kind === 'search' ? ['q', 'page', 'lc', 'staging'] : ['code', 'lc', 'staging'];
  reject([...params.keys()].every(key => allowed.includes(key) && params.getAll(key).length === 1));
  const language = params.get('lc') ?? 'fr', staging = params.get('staging') ?? '0';
  reject(/^[a-z]{2}$/.test(language) && ['0', '1'].includes(staging));
  const origin = staging === '1' ? 'https://world.openfoodfacts.net' : 'https://world.openfoodfacts.org';
  let url;
  if (kind === 'search') {
    const query = (params.get('q') || '').normalize('NFC').trim().replace(/\s+/g, ' '), page = params.get('page') ?? '1';
    reject(query.length >= 2 && query.length <= 120 && !/[\u0000-\u001f\u007f]/.test(query));
    reject(/^[1-9]\d?$/.test(page) && Number(page) <= 20);
    url = new NodeURL('/cgi/search.pl', origin);
    for (const [key, value] of Object.entries({ search_terms: query, action: 'process', json: '1', page_size: '20', page })) url.searchParams.set(key, value);
  } else {
    const code = params.get('code') || '';
    reject(/^(?:\d{8}|\d{12,14})$/.test(code));
    url = new NodeURL(`/api/v${productApiVersion}/product/${code}`, origin);
  }
  url.searchParams.set('fields', `${CATALOG_FIELDS},product_name_${language}`);
  url.searchParams.set('lc', language);
  return url;
}
export { providerQuery as catalogProviderQuery };

// Bound untrusted JSON before forwarding it. Nutrition normalization remains the
// frontend's responsibility; this relay cannot bypass the existing food validator.
function inspect(value) {
  const pending = [[value, 0]]; let nodes = 0;
  while (pending.length) {
    const [item, depth] = pending.pop();
    reject(++nodes <= 20000 && depth <= 12, 502, 'catalog-invalid-response');
    reject(item === null || ['object','string','number','boolean'].includes(typeof item), 502, 'catalog-invalid-response');
    if (typeof item === 'string') reject(item.length <= 10000, 502, 'catalog-invalid-response');
    if (typeof item === 'number') reject(Number.isFinite(item), 502, 'catalog-invalid-response');
    if (item && typeof item === 'object') {
      reject(Object.getPrototypeOf(item) === (Array.isArray(item) ? Array.prototype : Object.prototype) || Object.getPrototypeOf(item) === null, 502, 'catalog-invalid-response');
      reject(!Array.isArray(item) || item.length <= 1000, 502, 'catalog-invalid-response');
      const descriptors = Object.getOwnPropertyDescriptors(item);
      reject(!Object.getOwnPropertySymbols(item).length, 502, 'catalog-invalid-response');
      for (const key of Object.keys(descriptors)) {
        if (Array.isArray(item) && key === 'length') continue;
        const descriptor = descriptors[key];
        reject(Object.hasOwn(descriptor, 'value') && descriptor.enumerable, 502, 'catalog-invalid-response');
        reject(key.length <= 10000 && !['__proto__', 'constructor', 'prototype'].includes(key), 502, 'catalog-invalid-response');
        pending.push([descriptor.value, depth + 1]);
        reject(pending.length <= 20000, 502, 'catalog-invalid-response');
      }
    }
  }
}
export { inspect as inspectCatalogValue };
async function boundedJson(response, kind) {
  const announced = response.headers.get('content-length');
  reject(!announced || (Number.isFinite(Number(announced)) && Number(announced) >= 0 && Number(announced) <= CATALOG_MAX_BYTES), 502, 'catalog-response-too-large');
  const chunks = []; let size = 0;
  reject(response.body?.getReader, 502, 'catalog-invalid-response');
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      reject(size <= CATALOG_MAX_BYTES && chunks.length < 4096, 502, 'catalog-response-too-large'); chunks.push(value);
    }
  } finally { try { await reader.cancel(); } catch { /* stream ended or disconnected */ } reader.releaseLock(); }
  let body;
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))); }
  catch { throw new CatalogHttpError(502, 'catalog-invalid-response'); }
  inspect(body);
  reject(body && typeof body === 'object' && !Array.isArray(body), 502, 'catalog-invalid-response');
  if (kind === 'search') reject(Number.isSafeInteger(body.count) && body.count >= 0 && body.count <= 10000000 && Array.isArray(body.products) && body.products.length <= 20, 502, 'catalog-invalid-response');
  else reject(['success', 'success_with_warnings', 'failure'].includes(body.status) && (body.status === 'failure' || (body.product && typeof body.product === 'object' && !Array.isArray(body.product))), 502, 'catalog-invalid-response');
  return body;
}

/** One relay per API egress: rolling budgets count actual network attempts, never
 * accounts, cache hits or duplicate subscribers. Round-robin is work-conserving:
 * a lone client may use the full allowance; fairness applies to pending work. */
export function createCatalogRelay({ fetcher = globalThis.fetch, now = Date.now, onEvent = () => {}, productApiVersion = '3' } = {}) {
  reject(['3','3.5'].includes(productApiVersion));
  const cache = new Map(), flights = new Map(), queues = new Map();
  const used = { search: [], product: [] }, limits = { search: 10, product: 15 };
  let bytes = 0, running = 0, queued = 0, cooldowns = { global: null, search: null, product: null }, scheduled = false, attempts = 0, responses = 0;
  const emit = (event, fields = {}) => { try { onEvent({ event, ...fields }); } catch { /* observer cannot affect quota */ } };
  const remove = key => { const old = cache.get(key); if (old) bytes -= old.bytes; cache.delete(key); };
  const budgetWait = kind => {
    const time = now(); used[kind] = used[kind].filter(t => t > time - 60000);
    for (const scope of ['global', kind]) if (cooldowns[scope] && cooldowns[scope].until <= time) {
      emit('cooldown-expired', { scope, upstreamStatus: cooldowns[scope].status }); cooldowns[scope] = null;
    }
    const relevant = [cooldowns.global, cooldowns[kind]].filter(Boolean).sort((a, b) => b.until - a.until)[0];
    return { cooldown: relevant, local: used[kind].length >= limits[kind] ? Math.max(0, used[kind][0] + 60000 - time) : 0,
      provider: Math.max(0, (relevant?.until || 0) - time) };
  };
  const blockingError = kind => {
    const wait = budgetWait(kind), remaining = Math.max(wait.local, wait.provider);
    if (!remaining) return null;
    const provider = wait.provider >= wait.local, source = provider ? 'provider-cooldown' : 'local-budget';
    const status = provider ? wait.cooldown.status : 429, code = provider ? wait.cooldown.code : 'catalog-rate-limited';
    const retryAfter = Math.max(1, Math.ceil(remaining / 1000));
    emit('blocked', { source, kind, status, retryAfter, used: used[kind].length });
    return new CatalogHttpError(status, code, retryAfter, source);
  };
  const finishWaiter = (task, waiter, error, result) => {
    if (!task.waiters.delete(waiter)) return;
    clearTimeout(waiter.timer); waiter.signal?.removeEventListener('abort', waiter.abort);
    if (error) waiter.reject(error); else waiter.resolve({ status: 200, body: structuredClone(result) });
  };
  const finish = (task, error, result) => {
    if (flights.get(task.key) === task) flights.delete(task.key);
    for (const waiter of [...task.waiters]) finishWaiter(task, waiter, error, result);
  };
  const dequeue = task => {
    const queue = queues.get(task.peer);
    if (!queue) return;
    const index = queue.indexOf(task);
    if (index >= 0) { queue.splice(index, 1); queued--; }
    if (!queue.length) queues.delete(task.peer);
  };
  const wake = () => { if (!scheduled) { scheduled = true; queueMicrotask(() => { scheduled = false; pump(); }); } };
  async function execute(task) {
    // No await between budget reservation and starting the provider request.
    task.started = true; running++; used[task.kind].push(now());
    task.attempt = ++attempts; task.start = now();
    emit('dispatch', { kind: task.kind, environment: task.url.origin.endsWith('.net') ? 'staging' : 'production', attempt: task.attempt, used: used[task.kind].length, running });
    const controller = new AbortController(); task.controller = controller;
    const timer = setTimeout(() => controller.abort('timeout'), 15000);
    let response;
    try {
      response = await fetcher(task.url.href, { method: 'GET', redirect: 'error', signal: controller.signal,
        headers: { Accept: 'application/json', 'User-Agent': CATALOG_IDENTITY,
          ...(task.url.origin.endsWith('.net') ? { Authorization: 'Basic b2ZmOm9mZg==' } : {}) } });
      emit('upstream-response', { attempt: task.attempt, kind: task.kind, status: response.status, responses: ++responses });
      if (response.status !== 200) {
        try { await response.body?.cancel(); } catch { /* unused error body */ }
        if ([429, 503].includes(response.status)) {
          const header = response.headers.get('retry-after');
          const seconds = /^\d+$/.test(header ?? '') ? Number(header) : /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(header ?? '') ? (Date.parse(header) - now()) / 1000 : NaN;
          const explicit = Number.isFinite(seconds), delay = Math.min(604800, explicit ? Math.max(0, Math.ceil(seconds)) : 60);
          // 503 is endpoint unavailability, not proof that all OFF APIs are blocked.
          // Preserve a broader protective scope for explicit provider 429 throttles.
          const scope = response.status === 503 ? task.kind : 'global', cooldown = cooldowns[scope];
          const live = cooldown && cooldown.until > now();
          // Missing hints on already-in-flight failures belong to one incident.
          // They must not restart its fallback clock. An explicit provider hint
          // can extend it; a real new failure after expiry starts a new incident.
          const until = live ? (explicit ? Math.max(cooldown.until, now() + delay * 1000) : cooldown.until) : now() + delay * 1000;
          const code = response.status === 503 ? 'catalog-provider-unavailable' : 'catalog-rate-limited';
          const extended = !live || until > cooldown.until;
          if (extended) cooldowns[scope] = { until, status: response.status, code };
          const retryAfter = Math.max(0, Math.ceil((until - now()) / 1000));
          emit('provider-error', { source: 'provider-http', attempt: task.attempt, kind: task.kind, status: response.status,
            retryAfter, scope, retryPolicy: explicit ? 'provider-header' : 'fallback', cooldownExtended: extended,
            contentType: /json/i.test(response.headers.get('content-type') || '') ? 'json' : /html/i.test(response.headers.get('content-type') || '') ? 'html' : 'other' });
          throw new CatalogHttpError(response.status, code, retryAfter, 'provider-http');
        }
        emit('provider-error', { source: 'provider-http', attempt: task.attempt, kind: task.kind, status: response.status });
        throw new CatalogHttpError(response.status === 404 ? 404 : 502, response.status === 404 ? 'catalog-not-found' : 'catalog-upstream-error', undefined, 'provider-http');
      }
      const body = await boundedJson(response, task.kind), size = Buffer.byteLength(JSON.stringify(body));
      reject(size <= CATALOG_MAX_BYTES, 502, 'catalog-response-too-large');
      if (controller.signal.aborted) throw new CatalogHttpError(504, 'catalog-network-error', undefined, controller.signal.reason === 'timeout' ? 'timeout' : 'request-cancelled');
      while (cache.size && (cache.size >= 50 || bytes + size > CACHE_BYTES)) remove(cache.keys().next().value);
      cache.set(task.key, { body, bytes: size, until: now() + (task.kind === 'search' ? 300000 : 86400000) }); bytes += size;
      emit('success', { attempt: task.attempt, kind: task.kind, elapsedMs: Math.max(0, now() - task.start) });
      finish(task, null, body);
    } catch (error) {
      const source = controller.signal.aborted ? (controller.signal.reason === 'timeout' ? 'timeout' : 'request-cancelled') : 'network';
      if (!(error instanceof CatalogHttpError)) emit('transport-error', { source, attempt: task.attempt, kind: task.kind, category: transportCategory(error) });
      else if (error.source === 'timeout') emit('transport-error', { source: 'timeout', attempt: task.attempt, kind: task.kind, category: 'timeout' });
      else if (!error.source) { error.source = 'validation'; emit('validation-error', { attempt: task.attempt, kind: task.kind, code: error.code }); }
      finish(task, error instanceof CatalogHttpError ? error : new CatalogHttpError(controller.signal.aborted ? 504 : 502, 'catalog-network-error', undefined, source));
    } finally {
      try { await response?.body?.cancel(); } catch { /* consumed or aborted */ }
      clearTimeout(timer); running--; wake();
    }
  }
  function pump() {
    // Rotate peer queues after each job, before scheduling another. There is no
    // reserved share, per-client pacing or quota-refill timer/automatic retry.
    while (queues.size && running < 4) {
      const [peer, queue] = queues.entries().next().value;
      const task = queue.shift(); queued--; queues.delete(peer);
      if (queue.length) queues.set(peer, queue);
      const error = blockingError(task.kind);
      if (error) finish(task, error);
      else execute(task);
    }
    // Exhausted tasks must not wait behind slow unrelated reads. Dedup subscribers
    // have already joined their in-flight job and consume no additional budget.
    for (const queue of [...queues.values()]) for (const task of [...queue]) {
      const error = blockingError(task.kind);
      if (error) { dequeue(task); finish(task, error); }
    }
  }
  return {
    async read(kind, input, { peer = 'local', signal } = {}) {
      reject(['search', 'product'].includes(kind));
      reject(typeof peer === 'string' && peer.length <= 200);
      if (signal?.aborted) throw new CatalogHttpError(409, 'catalog-request-cancelled');
      const url = providerQuery(kind, input, productApiVersion), key = url.href;
      const cached = cache.get(key);
      if (cached && cached.until > now()) { emit('cache-hit', { kind }); cache.delete(key); cache.set(key, cached); return { status: 200, body: structuredClone(cached.body) }; }
      if (cached) remove(key);
      let task = flights.get(key);
      if (task) emit('dedup-hit', { kind, attempt: task.attempt || null });
      if (!task) {
        const error = blockingError(kind);
        if (error) throw error;
        if (queued >= 64 || (queues.get(peer)?.length || 0) >= 16) { emit('blocked', { source: 'local-overload', kind, status: 429 }); throw new CatalogHttpError(429, 'catalog-client-rate-limited', undefined, 'local-overload'); }
        task = { key, url, kind, peer, waiters: new Set(), started: false };
        flights.set(key, task);
        if (!queues.has(peer)) queues.set(peer, []);
        queues.get(peer).push(task); queued++;
      }
      if (task.controller?.signal.aborted || task.waiters.size >= 32) { emit('blocked', { source: 'local-overload', kind, status: 429 }); throw new CatalogHttpError(429, 'catalog-client-rate-limited', undefined, 'local-overload'); }
      return new Promise((resolve, reject) => {
        const waiter = { resolve, reject, signal };
        const cancel = error => {
          emit('subscriber-ended', { kind, source: error.code === 'catalog-request-cancelled' ? 'request-cancelled' : 'timeout', attempt: task.attempt || null });
          finishWaiter(task, waiter, error);
          if (!task.waiters.size) {
            if (task.started) task.controller.abort(error.code === 'catalog-request-cancelled' ? 'request-cancelled' : 'timeout');
            else { dequeue(task); flights.delete(key); }
          }
        };
        waiter.abort = () => cancel(new CatalogHttpError(409, 'catalog-request-cancelled'));
        waiter.timer = setTimeout(() => cancel(new CatalogHttpError(504, 'catalog-network-error')), 18000);
        task.waiters.add(waiter); signal?.addEventListener('abort', waiter.abort, { once: true });
        if (signal?.aborted) waiter.abort();
        wake();
      });
    },
    cacheInfo: () => ({ entries: cache.size, bytes }),
    budgetInfo: () => { budgetWait('search'); budgetWait('product'); return { search: used.search.length, product: used.product.length, running, queued, flights: flights.size }; },
  };
}

/** Public product data only; the personal profile additionally requires its
 * existing account session. Reject foreign browser origins before consuming
 * quota. Address handling reuses the server's trusted-proxy/IPv6 rules. */
export function foodCatalogRoutes({ json, origin, limitAddress, requireUser, onEvent = createCatalogLogger(), relay = createCatalogRelay({ onEvent }) }) {
  try { onEvent({ event: 'ready', version: VERSION, diagnosticVersion: 1 }); } catch { /* diagnostics only */ }
  const clients = createWindow({ max: 60, maxKeys: 10000 }), all = createWindow({ max: 300, maxKeys: 1 });
  const handle = kind => async (req, res) => {
    req.resume();
    try {
      const site = req.headers['sec-fetch-site'], requestOrigin = req.headers.origin;
      const user=requireUser?.(req);reject(!requireUser||!!user,401,'catalog-auth-required');
      const nativeBearer=!!user&&typeof req.headers.authorization==='string'&&req.headers.authorization.startsWith('Bearer ');
      reject(!site || ['same-origin', 'none'].includes(site)||nativeBearer&&site==='cross-site', 403, 'catalog-origin-refused');
      reject(!requestOrigin || requestOrigin.replace(/\/+$/, '') === origin.replace(/\/+$/, '') || nativeBearer&&['https://localhost','http://localhost','capacitor://localhost'].includes(requestOrigin), 403, 'catalog-origin-refused');
      const wait = all.take('all') || clients.take(limitAddress(req));
      if (wait) { try { onEvent({ event: 'blocked', source: 'local-overload', kind, status: 429 }); } catch { /* diagnostics only */ } throw new CatalogHttpError(429, 'catalog-client-rate-limited', undefined, 'local-overload'); }
      if (kind === 'capabilities') {
        reject(new URL(req.url, 'http://localhost').search === '');
        reject(relay.available !== false, 503, 'catalog-local-unavailable');
        json(res, 200, relay.capabilities ?? { schemaVersion:1, textSearch:relay.localSearch === true ? 'local' : 'explicit-remote' }, { 'Cache-Control':'no-store' });
        return;
      }
      let catalogueURL = req.url;
      const requested = new URL(req.url, 'http://localhost');
      if (requested.searchParams.has('local')) {
        reject(kind === 'search' && requested.searchParams.getAll('local').length === 1 && requested.searchParams.get('local') === '1' && requested.searchParams.get('staging') !== '1');
        reject(relay.localSearch === true, 503, 'catalog-local-unavailable');
        requested.searchParams.delete('local'); catalogueURL = requested.pathname + requested.search;
      }
      const tag = req.headers['x-opengym-catalog-client'];
      reject(tag === undefined || (typeof tag === 'string' && /^[a-zA-Z0-9_-]{16,64}$/.test(tag)));
      const controller = new AbortController(), cancel = () => controller.abort();
      res.once?.('close', cancel);
      let result;
      try { result = await relay.read(kind, catalogueURL, { peer: limitAddress(req) + '|' + (tag || ''), signal: controller.signal }); }
      finally { res.off?.('close', cancel); }
      if (!res.destroyed) json(res, result.status, result.body, result.headers);
    } catch (error) {
      const known = error instanceof CatalogHttpError;
      try { onEvent({ event: 'request-failed', kind, source: known ? error.source || 'validation' : 'network', status: known ? error.status : 502, code: known ? error.code : 'catalog-network-error' }); } catch { /* diagnostics only */ }
      if (!res.destroyed) json(res, known ? error.status : 502, { code: known ? error.code : 'catalog-network-error' },
        { ...(Number.isFinite(error.retryAfter) ? { 'Retry-After': String(error.retryAfter) } : {}), ...(error.source ? { 'X-openGym-Catalog-Source': error.source } : {}) });
    }
  };
  return {
    'GET /api/nutrition/catalog/capabilities': handle('capabilities'),
    'GET /api/nutrition/catalog/search': handle('search'),
    'GET /api/nutrition/catalog/product': handle('product'),
  };
}
