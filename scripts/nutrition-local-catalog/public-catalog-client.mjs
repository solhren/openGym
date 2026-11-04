// One pinned, read-only catalogue process. No user credentials or provider transport.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspectCatalogValue } from '../../api/nutrition/food-catalog.js';

const failure = code => Object.assign(new Error('Public catalogue unavailable'), { code });
const reader = fileURLToPath(new URL('./public-catalog-reader.py', import.meta.url));

export async function createPublicCatalog({ directory, spawnProcess = spawn, timeoutMs = 10000 } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || path.resolve(directory) !== directory || directory === '/' ||
      !Number.isInteger(timeoutMs) || timeoutMs < 20 || timeoutMs > 30000) throw failure('invalid-catalogue-options');
  let child, active = null, closed = false, exited = false, failed = false, sequence = 0, buffer = Buffer.alloc(0);
  const queue = [];
  const rejectAll = code => {
    failed = true;
    if (active) { clearTimeout(active.timer); active.reject(failure(code)); active = null; }
    for (const task of queue.splice(0)) { clearTimeout(task.timer); task.reject(failure(code)); }
  };
  const stop = code => { rejectAll(code); child?.kill('SIGKILL'); };
  const pump = () => {
    if (closed || failed || active || !queue.length) return;
    active = queue.shift();
    child.stdin.write(active.wire);
  };
  const request = (op, args = {}, { signal } = {}) => {
    if (closed || failed) return Promise.reject(failure(closed ? 'worker-closed' : 'worker-unavailable'));
    if (signal?.aborted) return Promise.reject(failure('worker-cancelled'));
    if (!['inspect', 'search', 'product', 'barcode'].includes(op) || !args || Object.getPrototypeOf(args) !== Object.prototype) return Promise.reject(failure('invalid-worker-request'));
    if (queue.length >= 16) return Promise.reject(failure('worker-busy'));
    let wire;
    const id = ++sequence;
    try { inspectCatalogValue(args); wire = JSON.stringify({ v: 1, id, op, args }) + '\n'; }
    catch { return Promise.reject(failure('invalid-worker-request')); }
    if (Buffer.byteLength(wire) > 4096) return Promise.reject(failure('invalid-worker-request'));
    return new Promise((resolve, reject) => {
      const task = { id, wire,
        resolve(value) { signal?.removeEventListener('abort', task.abort); resolve(value); },
        reject(error) { signal?.removeEventListener('abort', task.abort); reject(error); } };
      task.abort = () => {
        const index = queue.indexOf(task);
        if (index >= 0) { queue.splice(index, 1); clearTimeout(task.timer); }
        // An active response is drained with its original deadline, never published to its
        // cancelled caller. This preserves framing for the next request.
        task.reject(failure('worker-cancelled'));
        pump();
      };
      task.timer = setTimeout(() => {
        const index = queue.indexOf(task);
        if (index >= 0) { queue.splice(index, 1); task.reject(failure('worker-timeout')); }
        else if (active === task) stop('worker-timeout');
      }, timeoutMs);
      queue.push(task);
      signal?.addEventListener('abort', task.abort, { once: true });
      if (signal?.aborted) task.abort();
      pump();
    });
  };
  try {
    child = spawnProcess('python3', ['-u', reader, directory], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' }
    });
  } catch { throw failure('worker-unavailable'); }
  child.stdout.on('data', chunk => {
    if (closed || failed) return;
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > 256 * 1024) return stop('worker-invalid-response');
    let newline;
    while ((newline = buffer.indexOf(10)) !== -1) {
      const line = buffer.subarray(0, newline); buffer = buffer.subarray(newline + 1);
      let response;
      try { response = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)); inspectCatalogValue(response); }
      catch { return stop('worker-invalid-response'); }
      if (!active || !response || typeof response !== 'object' || Array.isArray(response) || Object.keys(response).length !== 4 ||
          response.v !== 1 || response.id !== active.id || typeof response.ok !== 'boolean' ||
          (response.ok ? !Object.hasOwn(response, 'result') : typeof response.error !== 'string' || !/^[a-z0-9-]{1,80}$/.test(response.error))) return stop('worker-invalid-response');
      const task = active; active = null; clearTimeout(task.timer);
      if (response.ok) task.resolve(response.result); else task.reject(failure(response.error));
    }
    if (buffer.length && !active) return stop('worker-invalid-response');
    if (!buffer.length) pump();
  });
  child.stderr.on('data', () => {}); // Bound memory and avoid exposing raw paths/data.
  child.stdin.on('error', () => stop('worker-unavailable'));
  child.on('error', () => stop('worker-unavailable'));
  child.on('close', () => { exited = true; rejectAll('worker-interrupted'); });
  const close = async () => {
    if (closed) return;
    closed = true;
    rejectAll('worker-closed');
    if (exited || child.exitCode !== null || child.signalCode !== null) return;
    const ended = new Promise(resolve => child.once('close', resolve));
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), 500);
    await ended;
    clearTimeout(timer);
  };
  try { await request('inspect'); }
  catch (error) { await close(); throw error; }
  return { inspect: () => request('inspect'), search: (args, options) => request('search', args, options),
    product: (id, { lc = 'fr', ...options } = {}) => request('product', { id, lc }, options),
    barcode: (code, { lc = 'fr', ...options } = {}) => request('barcode', { code, lc }, options), close };
}
