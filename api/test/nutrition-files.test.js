import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, part, status } from './nutrition-fixtures.mjs';
import { privateFiles } from '../nutrition/files.js';
import { httpError } from '../nutrition/protocol.js';

for (const action of ['write', 'sync', 'close']) {
  test(`Nutrition atomic files preserve the prior value when ${action} fails`, async t => {
    const f = await fixture(t), target = path.join(f.owner, 'test.json'), io = privateFiles();
    io.write(target, '{"value":1}', 'test');
    const fail = Object.assign(new Error('disk failure'), { code: action === 'write' ? 'ENOSPC' : 'EIO' });
    const method = { write: 'writeFileSync', sync: 'fsyncSync', close: 'closeSync' }[action], original = fs[method];
    t.mock.method(fs, method, (...args) => {
      if (action === 'close') original(...args); // Simulate a close reporting an error after releasing its descriptor.
      throw fail;
    });
    assert.throws(() => io.write(target, '{"value":2}', 'test'), error => error === fail);
    t.mock.restoreAll();
    assert.equal(io.read(target), '{"value":1}');
    assert.equal(httpError(fail).status, action === 'write' ? 507 : 503);
  });
}
test('Nutrition preserves the primary disk error when closing also reports an error', async t => {
  const f = await fixture(t), io = privateFiles(), close = fs.closeSync;
  const full = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  t.mock.method(fs, 'writeFileSync', () => { throw full; });
  t.mock.method(fs, 'closeSync', fd => { close(fd); throw new Error('close error'); });
  assert.throws(() => io.write(path.join(f.owner, 'test.json'), '{}', 'test'), error => error === full);
});
test('Nutrition refuses success on a failed directory flush and repeats the durability barrier on retry', async t => {
  const f = await fixture(t), a = await part(), sync = fs.fsyncSync;
  let fileFlushes = 0, directoryFlushes = 0;
  t.mock.method(fs, 'fsyncSync', fd => {
    if (fs.fstatSync(fd).isDirectory()) { directoryFlushes++; throw Object.assign(new Error('flush failure'), { code: 'EIO' }); }
    fileFlushes++; sync(fd);
  });
  // The first failure can occur while creating the generation directory; it must not publish.
  await assert.rejects(f.store.upload(a.integrity.digest, a));
  t.mock.restoreAll();
  // Stage the immutable object, then verify that an existing file is NOT an automatic success.
  await f.store.upload(a.integrity.digest, a);
  t.mock.method(fs, 'fsyncSync', fd => {
    if (fs.fstatSync(fd).isDirectory()) { directoryFlushes++; throw Object.assign(new Error('flush failure'), { code: 'EIO' }); }
    fileFlushes++; sync(fd);
  });
  await assert.rejects(f.store.upload(a.integrity.digest, a));
  assert.ok(fileFlushes >= 1 && directoryFlushes >= 2);
  t.mock.restoreAll();
  assert.equal((await f.store.upload(a.integrity.digest, a)).repeated, true);
  assert.equal((await f.store.head()).head, null);
});
test('Nutrition refuses malformed UTF-8 and oversized private files on read', async t => {
  const f = await fixture(t), io = privateFiles(), target = path.join(f.owner, 'test.json');
  fs.writeFileSync(target, Buffer.from([0xff])); assert.throws(() => io.read(target), status(503));
  fs.writeFileSync(target, Buffer.alloc(524289)); assert.throws(() => io.read(target), status(503));
});
