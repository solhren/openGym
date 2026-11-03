import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCatalogRelay, foodCatalogRoutes, CATALOG_IDENTITY, CATALOG_FIELDS, CATALOG_MAX_BYTES } from '../nutrition/food-catalog.js';

const product = { code: '3017620422003', product_name: 'Nutella', nutriments: { 'energy-kcal_100g': 539, proteins_100g: 6.3, carbohydrates_100g: 57.5, fat_100g: 30.9 } };
const reply = (body = { count: 1, products: [product] }, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const query = '/api/nutrition/catalog/search?q=nutella&lc=fr&page=1&staging=0';
function fixture(fetcher = async () => reply()) {
  let time = 100000, calls = [];
  const relay = createCatalogRelay({ now: () => time, fetcher: async (...args) => { calls.push(args); return fetcher(...args); } });
  return { relay, calls, advance: n => { time += n; } };
}

test('real provider query uses fixed CGI path, fields and genuine identification header; no URL User-Agent', async () => {
  const f = fixture(), result = await f.relay.read('search', query);
  assert.equal(result.body.products[0].product_name, 'Nutella');
  const [address, options] = f.calls[0], url = new URL(address);
  assert.equal(url.origin, 'https://world.openfoodfacts.org'); assert.equal(url.pathname, '/cgi/search.pl');
  assert.equal(url.searchParams.get('search_terms'), 'nutella'); assert.equal(url.searchParams.get('fields'), `${CATALOG_FIELDS},product_name_fr`);
  assert.equal(url.searchParams.get('page_size'), '20'); assert.equal(url.searchParams.has('User-Agent'), false);
  assert.deepEqual(options.headers, { Accept: 'application/json', 'User-Agent': CATALOG_IDENTITY }); assert.equal(options.redirect, 'error');
});
test('barcode zeros and v3 endpoint preserved; staging sends only public staging credential', async () => {
  const f = fixture(async () => reply({ status: 'success', product: { ...product, code: '0034000470693' } }));
  await f.relay.read('product', '/api/nutrition/catalog/product?code=0034000470693&lc=en&staging=1');
  assert.match(f.calls[0][0], /^https:\/\/world.openfoodfacts.net\/api\/v3\/product\/0034000470693\?/);
  assert.equal(f.calls[0][1].headers.Authorization, 'Basic b2ZmOm9mZg==');
});
for (const suffix of ['&url=https://evil.test', '&User-Agent=fake', '&fields=all', '&q=second', '&staging=2', '&lc=xx-YY', '&page=21', '&page=-1', '&__proto__=x']) {
  test(`strict query rejects ${suffix}`, async () => {
    const f = fixture(); await assert.rejects(f.relay.read('search', query + suffix), { status: 400 }); assert.equal(f.calls.length, 0);
  });
}
for (const input of ['?q=x', '?q=' + 'x'.repeat(121), '?q=%00test', '?q=ok&code=123', '?q=' + 'x'.repeat(2100)]) {
  test(`invalid search rejected (${input.slice(0, 32)})`, async () => { const f = fixture(); await assert.rejects(f.relay.read('search', '/api/nutrition/catalog/search' + input), { status: 400 }); assert.equal(f.calls.length, 0); });
}
for (const code of ['', '../secret', '123456789', '12345678901', '123456789012345', '1e12']) {
  test(`invalid barcode ${code} rejected`, async () => { const f = fixture(); await assert.rejects(f.relay.read('product', '/api/nutrition/catalog/product?code=' + encodeURIComponent(code)), { status: 400 }); assert.equal(f.calls.length, 0); });
}
test('immutable public cache bypasses provider quota and expires; page and language remain separate', async () => {
  const f = fixture(); const first = await f.relay.read('search', query); first.body.products[0].product_name = 'changed';
  assert.equal((await f.relay.read('search', query)).body.products[0].product_name, 'Nutella'); assert.equal(f.calls.length, 1);
  await f.relay.read('search', query.replace('page=1', 'page=2')); assert.equal(f.calls.length, 2);
  f.advance(10000); await f.relay.read('search', query.replace('lc=fr', 'lc=en')); assert.equal(f.calls.length, 3);
  f.advance(300000); await f.relay.read('search', query); assert.equal(f.calls.length, 4);
});
test('50-entry / 8MiB LRU bounded across searches; cache remains reconstructible', async () => {
  const f = fixture(); for (let i = 0; i < 55; i++) { f.advance(10000); await f.relay.read('search', query.replace('nutella', 'nutella' + i)); }
  assert.equal(f.relay.cacheInfo().entries, 50); assert.ok(f.relay.cacheInfo().bytes <= 8 * CATALOG_MAX_BYTES);
});
for (const status of [429, 503]) {
  test(`provider ${status} without CORS or JSON propagates cooldown without retry`, async () => {
    const f = fixture(async () => new Response('<html>unavailable</html>', { status, headers: { 'Retry-After': '120' } }));
    await assert.rejects(f.relay.read('search', query), { status, code: status === 503 ? 'catalog-provider-unavailable' : 'catalog-rate-limited', retryAfter: 120 });
    f.advance(11000); await assert.rejects(f.relay.read('search', query), { status, retryAfter: 109 });
    assert.equal(f.calls.length, 1); assert.equal(f.relay.cacheInfo().entries, 0);
  });
}
test('Retry-After HTTP date and missing header receive conservative bounded cooldown', async () => {
  for (const header of ['Thu, 01 Jan 1970 00:03:40 GMT', '', '9999999999999999999999', 'garbage']) {
    const f = fixture(async () => reply({}, 503, { 'Retry-After': header }));
    await assert.rejects(f.relay.read('search', query), e => e.status === 503 && e.retryAfter >= 60 && e.retryAfter <= 604800);
  }
});
test('identical pending requests share one provider call before consuming budget', async () => {
  let resolve; const f = fixture(() => new Promise(r => { resolve = r; }));
  const a = f.relay.read('search', query, { peer: 'A' }), b = f.relay.read('search', query, { peer: 'B' });
  await Promise.resolve(); assert.equal(f.calls.length, 1); assert.equal(f.relay.budgetInfo().search, 1);
  resolve(reply()); const [first, second] = await Promise.all([a, b]); first.body.products[0].product_name = 'edited'; assert.equal(second.body.products[0].product_name, 'Nutella');
});
for (const status of [404, 500, 302]) {
  test(`provider HTTP ${status} is never passed as successful JSON`, async () => { const f = fixture(async () => reply({}, status)); await assert.rejects(f.relay.read('search', query), { status: status === 404 ? 404 : 502 }); assert.equal(f.relay.cacheInfo().entries, 0); });
}
test('network errors disclose neither URL nor provider exception', async () => {
  const f = fixture(async () => { throw new TypeError('private URL/token in error'); });
  await assert.rejects(f.relay.read('search', query), { status: 502, message: 'catalog-network-error' });
});
for (const body of [{ count: -1, products: [] }, { count: '1', products: [] }, { count: 1, products: Array(21).fill(product) }, { count: 0 }, [], { count: 1, products: [{ value: 'x'.repeat(10001) }] }]) {
  test(`untrusted invalid response rejected (${JSON.stringify(body).slice(0, 50)})`, async () => { const f = fixture(async () => reply(body)); await assert.rejects(f.relay.read('search', query), { status: 502 }); assert.equal(f.relay.cacheInfo().entries, 0); });
}
test('malformed JSON, pollution keys and deep JSON never forwarded', async () => {
  for (const text of ['{broken', '{"count":0,"products":[],"__proto__":{"polluted":true}}', JSON.stringify({ count: 1, products: [Array.from({ length: 14 }).reduce(v => ({ nested: v }), {})] })]) {
    const f = fixture(async () => new Response(text)); await assert.rejects(f.relay.read('search', query), { status: 502 }); assert.equal({}.polluted, undefined);
  }
});
test('announced or streamed huge response cancelled and never cached', async () => {
  for (const headers of [{ 'Content-Length': String(CATALOG_MAX_BYTES + 1) }, {}]) {
    let cancelled = false;
    const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(CATALOG_MAX_BYTES + 1)); }, cancel() { cancelled = true; } });
    const f = fixture(async () => new Response(body, { headers })); await assert.rejects(f.relay.read('search', query), { status: 502, code: 'catalog-response-too-large' });
    assert.equal(cancelled, true); assert.equal(f.relay.cacheInfo().entries, 0);
  }
});

function routeFixture(relay = createCatalogRelay({ fetcher: async () => reply() })) {
  const results = [], routes = foodCatalogRoutes({ origin: 'http://localhost:8080', limitAddress: req => req.socket.remoteAddress,
    relay, json: (_, status, body, headers) => results.push({ status, body, headers }) });
  return { results, routes, request: overrides => ({ headers: {}, socket: { remoteAddress: '127.0.0.1' }, resume() {}, url: query, ...overrides }) };
}
test('anonymous route accepts guest without session and exposes only public product result', async () => {
  const f = routeFixture(); await f.routes['GET /api/nutrition/catalog/search'](f.request({ headers: { cookie: 'private', authorization: 'Bearer secret' } }), {});
  assert.equal(f.results[0].status, 200); assert.equal(f.results[0].body.products[0].product_name, 'Nutella');
});
test('route does not forward openGym credentials and foreign browsers spend no provider quota', async () => {
  const f = fixture(), r = routeFixture(f.relay);
  for (const headers of [{ origin: 'https://evil.test' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }]) await r.routes['GET /api/nutrition/catalog/search'](r.request({ headers }), {});
  assert.deepEqual(r.results.map(r => r.status), [403, 403, 403]); assert.equal(f.calls.length, 0);
  await r.routes['GET /api/nutrition/catalog/search'](r.request({ headers: { origin: 'http://localhost:8080', 'sec-fetch-site': 'same-origin', cookie: 'secret', authorization: 'Bearer secret' } }), {});
  assert.equal(r.results.at(-1).status, 200); assert.equal(f.calls[0][1].headers.Cookie, undefined); assert.equal(f.calls[0][1].headers.Authorization, undefined);
});
test('public cache abuse receives bounded per-address throttle with Retry-After', async () => {
  const f = routeFixture(); for (let i = 0; i < 61; i++) await f.routes['GET /api/nutrition/catalog/search'](f.request(), {});
  assert.equal(f.results.at(-1).status, 429); assert.equal(f.results.at(-1).body.code, 'catalog-client-rate-limited'); assert.equal(f.results.at(-1).headers?.['Retry-After'], undefined);
});
test('route preserves upstream 503 and cooldown header, not upstream HTML', async () => {
  const f = routeFixture(createCatalogRelay({ fetcher: async () => new Response('upstream HTML', { status: 503 }) }));
  await f.routes['GET /api/nutrition/catalog/search'](f.request(), {});
  assert.equal(f.results[0].status, 503); assert.equal(f.results[0].headers['Retry-After'], '60'); assert.deepEqual(f.results[0].body, { code: 'catalog-provider-unavailable' });
});

test('provider timeout aborts and cannot produce successful result', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture((_, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })));
  const rejected = assert.rejects(f.relay.read('search', query), { status: 504, code: 'catalog-network-error' });
  await Promise.resolve(); t.mock.timers.tick(15000); await rejected;
});
test('cache remains available during provider cooldown, but never grows above its byte ceiling', async () => {
  const f = fixture(async () => reply({ count: 1, products: [{ ...product, auxiliary: Array(90).fill('x'.repeat(9000)) }] }));
  for (let i = 0; i < 15; i++) { f.advance(10000); await f.relay.read('search', query.replace('nutella', 'query' + i)); }
  assert.ok(f.relay.cacheInfo().bytes <= 8 * CATALOG_MAX_BYTES); assert.ok(f.relay.cacheInfo().entries < 15);
});

test('explicit empty language, page or environment is invalid rather than silently defaulted', async () => {
  for (const field of ['lc', 'page', 'staging']) { const f = fixture(); const url = new URL(query, 'http://x'); url.searchParams.set(field, ''); await assert.rejects(f.relay.read('search', url.pathname + url.search), { status: 400 }); assert.equal(f.calls.length, 0); }
});

test('global route budget applies across different addresses even for cached products', async () => {
  const f = routeFixture();
  for (let i = 0; i < 301; i++) await f.routes['GET /api/nutrition/catalog/search'](f.request({ socket: { remoteAddress: 'address-' + Math.floor(i / 50) } }), {});
  assert.equal(f.results.at(-1).status, 429); assert.equal(f.results.at(-1).body.code, 'catalog-client-rate-limited'); assert.equal(f.results.at(-1).headers?.['Retry-After'], undefined);
});
test('v3 missing and incompatible product envelopes fail before frontend ingestion', async () => {
  for (const body of [{ status: 'success' }, { status: 'success', product: [] }, { status: 'future', product }]) {
    const f = fixture(async () => reply(body)); await assert.rejects(f.relay.read('product', '/api/nutrition/catalog/product?code=3017620422003'), { status: 502, code: 'catalog-invalid-response' });
  }
});

test('one requester immediately uses all ten searches, then receives exact exhaustion wait', async () => {
  const f = fixture();
  for (let i = 0; i < 10; i++) await f.relay.read('search', query.replace('nutella', 'solo' + i));
  assert.equal(f.calls.length, 10); assert.equal(f.relay.budgetInfo().search, 10);
  await assert.rejects(f.relay.read('search', query.replace('nutella', 'eleventh')), { status: 429, retryAfter: 60 });
  await f.relay.read('search', query.replace('nutella', 'solo0')); assert.equal(f.calls.length, 10);
  f.advance(60000); await f.relay.read('search', query.replace('nutella', 'eleventh')); assert.equal(f.calls.length, 11);
});
test('all fifteen product reads can burst independently of search quota', async () => {
  const f = fixture(async url => url.includes('/product/') ? reply({ status: 'success', product }) : reply());
  for (let i = 0; i < 10; i++) await f.relay.read('search', query.replace('nutella', 'search' + i));
  for (let i = 0; i < 15; i++) await f.relay.read('product', '/api/nutrition/catalog/product?code=' + (3017620422000 + i));
  assert.equal(f.calls.length, 25); await assert.rejects(f.relay.read('product', '/api/nutrition/catalog/product?code=3017620422015'), { status: 429, retryAfter: 60 });
});
test('rolling window releases only expired requests, not the full bucket on a minute boundary', async () => {
  const f = fixture(); await f.relay.read('search', query.replace('nutella', 'first')); f.advance(5000);
  for (let i = 0; i < 9; i++) await f.relay.read('search', query.replace('nutella', 'next' + i));
  await assert.rejects(f.relay.read('search', query.replace('nutella', 'extra')), { retryAfter: 55 });
  f.advance(55000); await f.relay.read('search', query.replace('nutella', 'extra'));
  await assert.rejects(f.relay.read('search', query.replace('nutella', 'extra2')), { retryAfter: 5 });
});
test('simultaneous peers share pending budget round-robin, independent of account counts', async () => {
  const f = fixture(), requests = [];
  for (const peer of ['A', 'B']) for (let i = 0; i < 10; i++) requests.push(f.relay.read('search', query.replace('nutella', peer + i), { peer }));
  const results = await Promise.allSettled(requests);
  assert.equal(f.calls.length, 10); assert.equal(results.filter(r => r.status === 'fulfilled').length, 10);
  const terms = f.calls.map(([url]) => new URL(url).searchParams.get('search_terms'));
  assert.equal(terms.filter(q => q.startsWith('A')).length, 5); assert.equal(terms.filter(q => q.startsWith('B')).length, 5);
  assert.deepEqual(terms.slice(0, 4), ['A0', 'B0', 'A1', 'B1']);
});
test('dedup at exhausted budget joins the tenth pending call without consuming an eleventh slot', async () => {
  let resolve, block = false; const f = fixture(() => block ? new Promise(r => { resolve = r; }) : reply());
  for (let i = 0; i < 9; i++) await f.relay.read('search', query.replace('nutella', 'before' + i));
  block = true; const a = f.relay.read('search', query), b = f.relay.read('search', query, { peer: 'second' });
  await Promise.resolve(); await assert.rejects(f.relay.read('search', query.replace('nutella', 'extra')), { retryAfter: 60 });
  resolve(reply()); await Promise.all([a, b]); assert.equal(f.calls.length, 10);
});
test('cancelling one duplicate never cancels another subscriber or stores an error', async () => {
  let resolve; const f = fixture(() => new Promise(r => { resolve = r; })), controller = new AbortController();
  const a = f.relay.read('search', query, { signal: controller.signal }), b = f.relay.read('search', query);
  const cancelled = assert.rejects(a, { code: 'catalog-request-cancelled' });
  await Promise.resolve(); controller.abort(); await cancelled; assert.equal(f.calls[0][1].signal.aborted, false);
  resolve(reply()); await b; assert.equal(f.calls.length, 1); assert.equal(f.relay.cacheInfo().entries, 1);
});
test('abandoned queued jobs consume no provider budget; active cancellation is not refunded', async () => {
  const f = fixture((_, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })));
  const controllers = Array.from({ length: 5 }, () => new AbortController());
  const requests = controllers.map((c, i) => f.relay.read('search', query.replace('nutella', 'pending' + i), { signal: c.signal }));
  const settled = Promise.allSettled(requests); await Promise.resolve(); assert.equal(f.calls.length, 4);
  controllers.forEach(c => c.abort()); await settled; await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, 4); assert.deepEqual(f.relay.budgetInfo(), { search: 4, product: 0, running: 0, queued: 0, flights: 0 });
});
test('bounded queue and dedup subscribers reject local overload with no countdown', async () => {
  for (const repeated of [true, false]) {
    const f = fixture(), controllers = Array.from({ length: repeated ? 32 : 64 }, () => new AbortController());
    const tasks = controllers.map((c, i) => f.relay.read('search', repeated ? query : query.replace('nutella', 'job' + i), { peer: 'peer' + i, signal: c.signal }));
    const settled = Promise.allSettled(tasks);
    const refused = f.relay.read('search', repeated ? query : query.replace('nutella', 'overflow'));
    // Cancel before the dispatcher microtask: no provider reservation was made.
    controllers.forEach(c => c.abort());
    await assert.rejects(refused, e => e.code === 'catalog-client-rate-limited' && e.retryAfter === undefined);
    await settled; assert.equal(f.calls.length, 0); assert.equal(f.relay.budgetInfo().queued, 0);
  }
});
test('explicit provider short backoff is honored without a fixed sixty-second floor', async () => {
  let unavailable = true; const f = fixture(async () => unavailable ? reply({}, 503, { 'Retry-After': '2' }) : reply());
  await assert.rejects(f.relay.read('search', query), { status: 503, retryAfter: 2 });
  f.advance(1999); await assert.rejects(f.relay.read('search', query), { status: 503, retryAfter: 1 });
  f.advance(1); unavailable = false; await f.relay.read('search', query); assert.equal(f.calls.length, 2);
});
test('anonymous fair-client tag is bounded and never forwarded upstream', async () => {
  const f = fixture(), r = routeFixture(f.relay);
  await r.routes['GET /api/nutrition/catalog/search'](r.request({ headers: { 'x-opengym-catalog-client': 'not-valid' } }), {});
  assert.equal(r.results[0].status, 400); assert.equal(f.calls.length, 0);
  await r.routes['GET /api/nutrition/catalog/search'](r.request({ headers: { 'x-opengym-catalog-client': 'a'.repeat(32) } }), {});
  assert.equal(r.results[1].status, 200); assert.equal(f.calls[0][1].headers['X-openGym-Catalog-Client'], undefined);
});

test('provider Retry-After zero is preserved rather than converted to a fixed wait', async () => {
  const f = routeFixture(createCatalogRelay({ fetcher: async () => reply({}, 503, { 'Retry-After': '0' }) }));
  await f.routes['GET /api/nutrition/catalog/search'](f.request(), {});
  assert.equal(f.results[0].status, 503); assert.equal(f.results[0].headers['Retry-After'], '0');
});

test('expired HTTP-date backoff is immediate; invalid signed seconds receive fallback', async () => {
  for (const [header, expected] of [['Thu, 01 Jan 1970 00:00:01 GMT', 0], ['-1', 60]]) {
    const f = fixture(async () => reply({}, 503, { 'Retry-After': header }));
    await assert.rejects(f.relay.read('search', query), { status: 503, retryAfter: expected });
  }
});

test('ordinary simultaneous anonymous tabs behind one address share work through fair tags', async () => {
  const f = fixture(), routes = routeFixture(f.relay), requests = [];
  for (const [name, tag] of [['A', 'a'.repeat(32)], ['B', 'b'.repeat(32)]]) for (let i = 0; i < 10; i++) requests.push(routes.routes['GET /api/nutrition/catalog/search'](routes.request({ url: query.replace('nutella', name + i), headers: { 'x-opengym-catalog-client': tag } }), {}));
  await Promise.all(requests);
  const terms = f.calls.map(([url]) => new URL(url).searchParams.get('search_terms'));
  assert.equal(terms.filter(q => q.startsWith('A')).length, 5); assert.equal(terms.filter(q => q.startsWith('B')).length, 5);
  assert.equal(routes.results.filter(r => r.status === 200).length, 10); assert.equal(routes.results.filter(r => r.status === 429).length, 10);
});

test('fallback 503 cooldown counts down, expires once and permits a successful real retry', async () => {
  let unavailable = true, time = 100000, calls = 0; const events = [];
  const relay = createCatalogRelay({ now: () => time, onEvent: e => events.push(e), fetcher: async () => { calls++; return unavailable ? reply({}, 503) : reply(); } });
  await assert.rejects(relay.read('search', query), { status: 503, code: 'catalog-provider-unavailable', retryAfter: 60, source: 'provider-http' });
  time += 1000; await assert.rejects(relay.read('search', query), { status: 503, retryAfter: 59, source: 'provider-cooldown' });
  time += 58000; await assert.rejects(relay.read('search', query), { status: 503, retryAfter: 1 }); assert.equal(calls, 1);
  time += 1000; unavailable = false; assert.equal((await relay.read('search', query)).status, 200);
  assert.equal(calls, 2); assert.equal(events.filter(e => e.event === 'cooldown-expired').length, 1);
  assert.equal(relay.budgetInfo().search, 1); await relay.read('search', query); assert.equal(calls, 2);
});
test('persistent provider 503 renews only after an actually dispatched failing retry', async () => {
  let time = 100000, calls = 0; const events = [];
  const relay = createCatalogRelay({ now: () => time, onEvent: e => events.push(e), fetcher: async () => { calls++; return reply({}, 503); } });
  await assert.rejects(relay.read('search', query), { retryAfter: 60 });
  for (let i = 1; i <= 20; i++) { time += 1000; await assert.rejects(relay.read('search', query), { retryAfter: 60 - i }); }
  assert.equal(calls, 1); time += 40000; await assert.rejects(relay.read('search', query), { retryAfter: 60, source: 'provider-http' });
  assert.equal(calls, 2); assert.equal(events.filter(e => e.event === 'provider-error').length, 2);
});
test('concurrent fallback 503 responses cannot restart the same incident clock', async () => {
  let time = 100000; const resolve = [], events = [];
  const relay = createCatalogRelay({ now: () => time, onEvent: e => events.push(e), fetcher: () => new Promise(r => resolve.push(r)) });
  const first = assert.rejects(relay.read('search', query), { retryAfter: 60 });
  const second = assert.rejects(relay.read('search', query.replace('nutella', 'other')), { retryAfter: 51 });
  await Promise.resolve(); assert.equal(resolve.length, 2); resolve[0](reply({}, 503)); await first;
  time += 9000; resolve[1](reply({}, 503)); await second;
  assert.deepEqual(events.filter(e => e.event === 'provider-error').map(e => e.cooldownExtended), [true, false]);
  time += 51000; const retried = relay.read('search', query); await Promise.resolve(); resolve[2](reply()); await retried;
});
test('a concurrent explicit provider Retry-After may extend the incident, without local renewal', async () => {
  let time = 100000; const resolve = [];
  const relay = createCatalogRelay({ now: () => time, fetcher: () => new Promise(r => resolve.push(r)) });
  const first = assert.rejects(relay.read('search', query), { retryAfter: 60 });
  const second = assert.rejects(relay.read('search', query.replace('nutella', 'other')), { retryAfter: 120 });
  await Promise.resolve(); resolve[0](reply({}, 503)); await first; time += 9000;
  resolve[1](reply({}, 503, { 'Retry-After': '120' })); await second;
  time += 1000; await assert.rejects(relay.read('search', query), { status: 503, retryAfter: 119, source: 'provider-cooldown' });
});
test('DNS, other HTTP failures and invalid JSON are never rate-limits and do not create cooldowns', async () => {
  for (const failure of [() => { throw Object.assign(new TypeError('PRIVATE_URL TOKEN'), { cause: { code: 'ENOTFOUND' } }); }, () => reply({}, 500), () => new Response('{invalid')]) {
    let bad = true; const events = [], relay = createCatalogRelay({ fetcher: async () => bad ? failure() : reply(), onEvent: e => events.push(e) });
    await assert.rejects(relay.read('search', query), e => e.status === 502 && e.retryAfter === undefined && e.code !== 'catalog-rate-limited');
    bad = false; assert.equal((await relay.read('search', query)).status, 200);
    assert.equal(events.filter(e => e.event === 'dispatch').length, 2); assert.equal(JSON.stringify(events).includes('PRIVATE_URL'), false);
  }
});
test('in-flight network failures cannot extend an existing provider cooldown', async () => {
  let time = 100000; const pending = [];
  const relay = createCatalogRelay({ now: () => time, fetcher: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) });
  const provider = assert.rejects(relay.read('search', query), { status: 503, retryAfter: 60 });
  const network = assert.rejects(relay.read('search', query.replace('nutella', 'other')), { status: 502, code: 'catalog-network-error' });
  await Promise.resolve(); pending[0].resolve(reply({}, 503)); await provider;
  time += 10000; pending[1].reject(new Error('network')); await network;
  await assert.rejects(relay.read('search', query), { status: 503, retryAfter: 50 }); assert.equal(pending.length, 2);
});
test('route diagnostics identify upstream and cached cooldown; local quota stays separately sourced', async () => {
  const r = routeFixture(createCatalogRelay({ fetcher: async () => reply({}, 503) }));
  await r.routes['GET /api/nutrition/catalog/search'](r.request(), {});
  await r.routes['GET /api/nutrition/catalog/search'](r.request(), {});
  assert.equal(r.results[0].headers['X-openGym-Catalog-Source'], 'provider-http');
  assert.equal(r.results[1].headers['X-openGym-Catalog-Source'], 'provider-cooldown');
  const f = fixture(); for (let i = 0; i < 10; i++) await f.relay.read('search', query.replace('nutella', 'item' + i));
  await assert.rejects(f.relay.read('search', query), { status: 429, source: 'local-budget' });
});
test('diagnostics never expose request/private fields, response body or untrusted exception/header text', async () => {
  const { createCatalogLogger } = await import('../nutrition/food-catalog.js'), lines = [];
  const relay = createCatalogRelay({ onEvent: createCatalogLogger({ trace: true, sink: line => lines.push(line) }), fetcher: async () => new Response('BODY_SECRET', { status: 503, headers: { 'Content-Type': 'HEADER_SECRET', 'Retry-After': 'invalid SECRET' } }) });
  await assert.rejects(relay.read('search', query.replace('nutella', 'QUERY_SECRET'), { peer: 'ACCOUNT_SECRET' }), { status: 503 });
  const text = lines.join('\n'); for (const forbidden of ['SECRET', 'search_terms', 'https://', 'cookie', 'Authorization']) assert.equal(text.includes(forbidden), false);
  assert.ok(lines.map(JSON.parse).some(e => e.event === 'provider-error' && e.retryPolicy === 'fallback'));
  const throwing = createCatalogRelay({ onEvent: () => { throw Error('logger broke'); }, fetcher: async () => reply() });
  assert.equal((await throwing.read('search', query)).status, 200);
});

test('internal diagnostics separate dispatch attempts from actual HTTP responses and DNS failure', async () => {
  const events = [], relay = createCatalogRelay({ onEvent: e => events.push(e), fetcher: async () => { throw Object.assign(new Error('SECRET'), { cause: { code: 'EAI_AGAIN' } }); } });
  await assert.rejects(relay.read('search', query), { status: 502, code: 'catalog-network-error', source: 'network' });
  assert.equal(events.filter(e => e.event === 'dispatch').length, 1); assert.equal(events.filter(e => e.event === 'upstream-response').length, 0);
  assert.equal(events.find(e => e.event === 'transport-error').category, 'dns'); assert.equal(JSON.stringify(events).includes('SECRET'), false);
});

test('search 503 preserves the independent working v3 barcode endpoint', async () => {
  const calls = [], relay = createCatalogRelay({ fetcher: async url => { calls.push(url); return url.includes('/cgi/') ? reply({}, 503) : reply({ status: 'success', product }); } });
  await assert.rejects(relay.read('search', query), { status: 503, code: 'catalog-provider-unavailable' });
  assert.equal((await relay.read('product', '/api/nutrition/catalog/product?code=3017620422003')).body.product.product_name, 'Nutella');
  await assert.rejects(relay.read('search', query), { source: 'provider-cooldown' }); assert.equal(calls.length, 2);
});
test('product 503 likewise preserves search, while explicit provider 429 remains broadly protective', async () => {
  const relay = createCatalogRelay({ fetcher: async url => url.includes('/product/') ? reply({}, 503) : reply() });
  await assert.rejects(relay.read('product', '/api/nutrition/catalog/product?code=3017620422003'), { status: 503 });
  assert.equal((await relay.read('search', query)).status, 200);
  const throttled = createCatalogRelay({ fetcher: async () => reply({}, 429) });
  await assert.rejects(throttled.read('search', query), { status: 429 });
  await assert.rejects(throttled.read('product', '/api/nutrition/catalog/product?code=3017620422003'), { status: 429, source: 'provider-cooldown' });
});

test('public capability discovery reports only local/remote mode, guards origin and never dispatches OFF',async()=>{
  for(const localSearch of [false,true]){
    let invoked=0; const routes=foodCatalogRoutes({origin:'http://localhost:5174',limitAddress:()=> '127.0.0.1',onEvent:()=>{},relay:{localSearch,read(){invoked++;throw Error('provider forbidden')}},json:(res,status,body,headers)=>Object.assign(res,{status,body,headers})})
    const handle=routes['GET /api/nutrition/catalog/capabilities'],res={}
    await handle({url:'/api/nutrition/catalog/capabilities',headers:{origin:'http://localhost:5174'},resume(){}},res)
    assert.equal(res.status,200);assert.deepEqual(res.body,{schemaVersion:1,textSearch:localSearch?'local':'explicit-remote'});assert.equal(res.headers['Cache-Control'],'no-store');assert.equal(invoked,0)
    const refused={};await handle({url:'/api/nutrition/catalog/capabilities',headers:{origin:'https://evil.test'},resume(){}},refused);assert.equal(refused.status,403)
    const extra={};await handle({url:'/api/nutrition/catalog/capabilities?url=bad',headers:{},resume(){}},extra);assert.equal(extra.status,400)
  }
})

test('local-only suggestions fail closed after rollback and never enter OFF relay',async()=>{
  let called=0; const create=localSearch=>foodCatalogRoutes({origin:'http://localhost',limitAddress:()=> '127.0.0.1',onEvent:()=>{},relay:{localSearch,async read(kind,url){called++;assert.equal(new URL(url,'http://localhost').searchParams.has('local'),false);return {status:200,body:{count:0,products:[]}}}},json:(res,status,body)=>Object.assign(res,{status,body})})
  const req={url:query+'&local=1',headers:{},resume(){}};const refused={}
  await create(false)['GET /api/nutrition/catalog/search'](req,refused);assert.equal(refused.status,503);assert.equal(called,0)
  const res={};await create(true)['GET /api/nutrition/catalog/search'](req,res);assert.equal(res.status,200);assert.equal(called,1)
})

test('staging cannot delegate a local-only text suggestion to the provider',async()=>{
  let called=0;const routes=foodCatalogRoutes({origin:'http://localhost',limitAddress:()=> '127.0.0.1',relay:{localSearch:true,read(){called++}},onEvent:()=>{},json:(res,status)=>{res.status=status}}),res={}
  await routes['GET /api/nutrition/catalog/search']({url:query.replace('staging=0','staging=1')+'&local=1',headers:{},resume(){}},res)
  assert.equal(res.status,400);assert.equal(called,0)
})

test('trusted local hydration v3.5 endpoint cannot be selected by public query parameters',async()=>{
 const requested=[];const relay=createCatalogRelay({productApiVersion:'3.5',fetcher:async(url)=>{requested.push(url);return reply({status:'success',product:{code:'3017620422003'}})}});
 await relay.read('product','/api/nutrition/catalog/product?code=3017620422003');assert.ok(requested[0].includes('/api/v3.5/product/'));
 await assert.rejects(relay.read('product','/api/nutrition/catalog/product?code=3017620422003&version=3.6'));
 assert.throws(()=>createCatalogRelay({productApiVersion:'http://evil'}));
});
