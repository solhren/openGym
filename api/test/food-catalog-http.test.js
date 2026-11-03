// Real sockets; no Internet calls. Run over SSH if sandbox listen() is denied.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { foodCatalogRoutes, createCatalogRelay } from '../nutrition/food-catalog.js';
let server, address, calls = [], providerStatus = 200, time = 100000, searchUnavailable = false;
before(async () => {
  const routes = foodCatalogRoutes({ origin: 'http://localhost:8080', limitAddress: req => req.socket.remoteAddress,
    json: (res, status, body, headers) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)); },
    relay: createCatalogRelay({ now: () => time, fetcher: async (url, options) => {
      calls.push({ url, options });
      const status = searchUnavailable && url.includes('/cgi/') ? 503 : providerStatus;
      const product = { code: '3017620422003', product_name: 'Nutella' };
      return status === 200 ? new Response(JSON.stringify(url.includes('/product/') ? { status: 'success', product } : { count: 1, products: [product] })) : new Response('HTML without CORS', { status, headers: { 'Retry-After': '90' } });
    } }) });
  server = http.createServer((req, res) => {
    const route = routes[req.method + ' ' + new URL(req.url, 'http://x').pathname];
    if (!route) { res.writeHead(404); res.end(); } else route(req, res);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  address = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { if (server?.listening) await new Promise(resolve => server.close(resolve)); });
test('guest nutella lookup works over real HTTP and repeats hit public cache', async () => {
  const result = await fetch(address + '/api/nutrition/catalog/search?q=nutella&lc=fr'); assert.equal(result.status, 200); assert.equal((await result.json()).products[0].product_name, 'Nutella');
  assert.equal(calls[0].options.headers['User-Agent'].startsWith('openGym/'), true); assert.equal(new URL(calls[0].url).searchParams.has('User-Agent'), false);
  const again = await fetch(address + '/api/nutrition/catalog/search?q=nutella&lc=fr'); assert.equal(again.status, 200); await again.json(); assert.equal(calls.length, 1);
});
test('bad query and foreign Origin refused without provider calls', async () => {
  assert.equal((await fetch(address + '/api/nutrition/catalog/search?q=ok&url=https://evil.test')).status, 400);
  assert.equal((await fetch(address + '/api/nutrition/catalog/search?q=nutella&lc=fr', { headers: { Origin: 'https://evil.test' } })).status, 403); assert.equal(calls.length, 1);
});
test('provider 503 without CORS becomes readable JSON plus Retry-After, no HTML or retry', async () => {
  providerStatus = 503;
  const result = await fetch(address + '/api/nutrition/catalog/product?code=3017620422003'); assert.equal(result.status, 503); assert.equal(result.headers.get('retry-after'), '90'); assert.deepEqual(await result.json(), { code: 'catalog-provider-unavailable' });
  const repeat = await fetch(address + '/api/nutrition/catalog/product?code=3017620422003'); assert.equal(repeat.status, 503); assert.equal(calls.length, 2);
});
test('cached public data remain readable during shared provider cooldown', async () => { const r = await fetch(address + '/api/nutrition/catalog/search?q=nutella&lc=fr'); assert.equal(r.status, 200); assert.equal(calls.length, 2); });

test('real HTTP search unavailability leaves the working v3 barcode endpoint accessible', async () => {
  time += 90000; providerStatus = 200; searchUnavailable = true;
  const search = await fetch(address + '/api/nutrition/catalog/search?q=uncached'); assert.equal(search.status, 503); assert.equal((await search.json()).code, 'catalog-provider-unavailable');
  const lookup = await fetch(address + '/api/nutrition/catalog/product?code=3017620422003'); assert.equal(lookup.status, 200); assert.equal((await lookup.json()).product.code, '3017620422003');
});
