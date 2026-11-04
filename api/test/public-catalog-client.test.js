import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createPublicCatalog } from '../../scripts/nutrition-local-catalog/public-catalog-client.mjs';

function fakeProcess(handler) {
  const calls = [], child = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null });
  const exit = signal => { if (child.exitCode !== null || child.signalCode !== null) return; child.signalCode = signal; child.exitCode = signal ? null : 0; queueMicrotask(() => child.emit('close')); };
  child.kill = () => exit('SIGKILL');
  child.stdin.on('finish', () => exit(null));
  child.stdin.on('data', bytes => {
    const request = JSON.parse(bytes);
    Promise.resolve().then(() => handler(request, child)).then(result => {
      if (result !== undefined) child.stdout.write(JSON.stringify({ v: 1, id: request.id, ok: true, result }) + '\n');
    });
  });
  return { child, calls, spawn: (...args) => { calls.push(args); return child; } };
}

test('the isolated catalogue process receives only public paths and a minimal environment', async () => {
  const fixture = fakeProcess(({ op }) => op === 'inspect' ? { provider: 'ciqual' } : []);
  const catalog = await createPublicCatalog({ directory: '/catalogues/ciqual-2025', spawnProcess: fixture.spawn });
  const [command, args, options] = fixture.calls[0];
  assert.equal(command, 'python3'); assert.equal(args.at(-1), '/catalogues/ciqual-2025');
  assert.deepEqual(Object.keys(options.env).sort(), ['PATH', 'PYTHONDONTWRITEBYTECODE', 'PYTHONNOUSERSITE']);
  assert.deepEqual(await catalog.barcode('3017620422003'), []);
  await catalog.close(); await assert.rejects(catalog.inspect(), { code: 'worker-closed' });
});

test('cancelled active reads drain without publishing and preserve the next request framing', async () => {
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const fixture = fakeProcess(({ op }) => {
    if (op === 'search') { entered(); return new Promise(resolve => { release = resolve; }); }
    return { provider: 'ciqual' };
  });
  const catalog = await createPublicCatalog({ directory: '/catalogues/ciqual-2025', spawnProcess: fixture.spawn });
  const controller = new AbortController();
  const pending = catalog.search({ q: 'rice', page: 1, lc: 'en' }, { signal: controller.signal });
  const refused = assert.rejects(pending, { code: 'worker-cancelled' });
  await ready; controller.abort(); await refused;
  const next = catalog.inspect(); release([]);
  assert.deepEqual(await next, { provider: 'ciqual' });
  await catalog.close();
});

test('invalid response framing fails closed and does not restart into another generation', async () => {
  const fixture = fakeProcess(({ op }, child) => {
    if (op === 'search') { child.stdout.write('x'.repeat(256 * 1024 + 1)); return undefined; }
    return {};
  });
  const catalog = await createPublicCatalog({ directory: '/catalogues/ciqual-2025', spawnProcess: fixture.spawn });
  await assert.rejects(catalog.search({ q: 'rice' }), { code: 'worker-invalid-response' });
  await assert.rejects(catalog.inspect(), { code: 'worker-unavailable' });
  assert.equal(fixture.calls.length, 1);
  await catalog.close();
});

test('a stalled reader has a bounded deadline and releases every queued waiter', async () => {
  const fixture = fakeProcess(({ op }) => op === 'inspect' ? {} : new Promise(() => {}));
  const catalog = await createPublicCatalog({ directory: '/catalogues/ciqual-2025', spawnProcess: fixture.spawn, timeoutMs: 30 });
  const pending = [catalog.search({ q: 'rice' }), catalog.product('ciqual:123')];
  const settled = await Promise.allSettled(pending);
  assert.ok(settled.every(result => result.status === 'rejected' && result.reason.code === 'worker-timeout'));
  await catalog.close();
});

test('one blocked read cannot grow the worker queue beyond sixteen pending requests', async () => {
  const fixture = fakeProcess(({ op }) => op === 'search' ? new Promise(() => {}) : {});
  const catalog = await createPublicCatalog({ directory: '/catalogues/ciqual-2025', spawnProcess: fixture.spawn });
  const pending = [catalog.search({ q: 'rice' }), ...Array.from({ length: 16 }, () => catalog.inspect())];
  const outcomes = Promise.allSettled(pending);
  await assert.rejects(catalog.inspect(), { code: 'worker-busy' });
  await catalog.close();
  assert.ok((await outcomes).every(result => result.status === 'rejected' && result.reason.code === 'worker-closed'));
});
