import { describe, it, vi } from 'vitest'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  canonicalJson, jsonClone, contentHash, sealDocument, verifiedDocument, readDocument,
  byteLength, MAX_DOCUMENT_BYTES, journalPartitionId, libraryPartitionId, partitionKind,
} from './persistence-contract.js'
import { hasCode } from './persistence.test-util.js'

describe('nutrition persistence primitives', () => {
  it('canonicalizes key order without changing arrays, Unicode or number precision', async () => {
    const a = { z: [1 / 3, null, 'é🍽️'], a: { b: 2, a: 0 } }
    const b = { a: { a: 0, b: 2 }, z: a.z }
    assert.equal(canonicalJson(a), canonicalJson(b))
    assert.deepEqual(jsonClone(a), a)
    assert.equal(await contentHash(a), createHash('sha256').update(canonicalJson(b)).digest('hex'))
    assert.notEqual(await contentHash(a), await contentHash({ ...a, z: [...a.z].reverse() }))
  })
  it('supports JSON keys named __proto__ and constructor without prototype pollution', () => {
    const value = JSON.parse('{"__proto__":{"polluted":true},"constructor":"metadata"}')
    const copied = jsonClone(value)
    assert.deepEqual(copied, value)
    assert.equal({}.polluted, undefined)
    assert.ok(Object.hasOwn(copied, '__proto__'))
  })
  it('retains shared acyclic metadata as independent JSON values', () => {
    const shared = { nullable: null }
    const copied = jsonClone({ a: shared, b: shared })
    assert.deepEqual(copied.a, shared)
    assert.notEqual(copied.a, copied.b)
  })
  for (const [name, value, code] of [
    ['undefined', { a: undefined }, 'json_unsupported_value'],
    ['bigint', { a: 1n }, 'json_unsupported_value'],
    ['function', { a: () => 1 }, 'json_unsupported_value'],
    ['NaN', { a: NaN }, 'json_nonfinite_number'],
    ['infinity', { a: Infinity }, 'json_nonfinite_number'],
    ['signed zero', { a: -0 }, 'json_negative_zero'],
    ['date', { a: new Date() }, 'json_plain_object_required'],
    ['inherited properties', Object.create({ a: 1 }), 'json_plain_object_required'],
    ['sparse array', new Array(1), 'json_sparse_array'],
    ['symbol key', { [Symbol('a')]: 1 }, 'json_symbol_key'],
    ['hidden field', Object.defineProperty({}, 'a', { value: 1 }), 'json_enumerable_property_required'],
  ]) it(`rejects ${name} with structured errors`, () => assert.throws(() => jsonClone(value), hasCode(code)))
  it('rejects cycles and getters without executing accessors', () => {
    const cycle = {}; cycle.self = cycle
    assert.throws(() => jsonClone(cycle), hasCode('json_circular_reference'))
    let calls = 0
    const getter = { get a() { calls++; return 1 } }
    assert.throws(() => jsonClone(getter), hasCode('json_data_property_required'))
    assert.equal(calls, 0)
  })
  it('never invokes a toJSON hook and reads data descriptors without get traps', () => {
    let calls = 0
    const hook = { toJSON() { calls++; return { a: 1 } } }
    assert.throws(() => jsonClone(hook), hasCode('json_unsupported_value'))
    const proxy = new Proxy({ a: 1 }, { get() { calls++; throw new Error('Unexpected property read') } })
    assert.deepEqual(jsonClone(proxy), { a: 1 })
    assert.equal(calls, 0)
  })
  it('reports uninspectable data as a structured validation error', () => {
    const proxy = new Proxy({}, { ownKeys() { throw new Error('Cannot inspect') } })
    assert.throws(() => jsonClone(proxy), hasCode('json_inspection_failed'))
  })
  it('captures values before asynchronous SHA-256', async () => {
    const value = { a: 1 }, expected = createHash('sha256').update('{"a":1}').digest('hex')
    const result = contentHash(value); value.a = 2
    assert.equal(await result, expected)
  })
  it('preserves SHA-256 when Web Crypto is unavailable on an HTTP LAN instance', async () => {
    const expected = createHash('sha256').update(canonicalJson({ a: 'é🍽️' })).digest('hex')
    vi.stubGlobal('crypto', undefined)
    try { assert.equal(await contentHash({ a: 'é🍽️' }), expected) } finally { vi.unstubAllGlobals() }
  })
  it('preserves SHA-256 when an exposed Web Crypto implementation refuses digest', async () => {
    const expected = createHash('sha256').update(canonicalJson({ a: 1 })).digest('hex')
    vi.stubGlobal('crypto', { subtle: { digest: () => Promise.reject(new Error('Unavailable in this context')) } })
    try { assert.equal(await contentHash({ a: 1 }), expected) } finally { vi.unstubAllGlobals() }
  })
  it('checks document integrity and rejects unsupported algorithms', async () => {
    const doc = await sealDocument({ format: 'test', storageVersion: 1, value: 4 })
    assert.deepEqual(await verifiedDocument(doc, 'test'), doc)
    await assert.rejects(verifiedDocument({ ...doc, value: 5 }, 'test'), hasCode('checksum_mismatch'))
    await assert.rejects(verifiedDocument({ ...doc, integrity: { algorithm: 'md5', digest: 'a'.repeat(64) } }, 'test'), hasCode('invalid_integrity'))
  })
  it('rejects malformed or over-budget JSON before parsing', () => {
    assert.throws(() => readDocument('{'), hasCode('invalid_json'))
    assert.throws(() => readDocument(' '.repeat(MAX_DOCUMENT_BYTES + 1)), hasCode('document_too_large'))
    assert.equal(byteLength('é'), 2)
    assert.throws(() => readDocument({ a: 'é'.repeat(MAX_DOCUMENT_BYTES / 2) }), hasCode('document_too_large'))
  })
  it('accepts exactly 512 KiB including integrity and rejects one extra stored byte', async () => {
    const empty = await sealDocument({ format: 'boundary', storageVersion: 1, payload: '' })
    const overhead = byteLength(canonicalJson(empty))
    const payload = 'x'.repeat(MAX_DOCUMENT_BYTES - overhead)
    const sealed = await sealDocument({ format: 'boundary', storageVersion: 1, payload })
    const text = canonicalJson(sealed)
    assert.equal(byteLength(text), 512 * 1024)
    assert.deepEqual(readDocument(text), sealed)
    assert.deepEqual(await verifiedDocument(text, 'boundary'), sealed)
    assert.throws(() => readDocument(`${text}\n`), hasCode('document_too_large'))
    await assert.rejects(sealDocument({ format: 'boundary', storageVersion: 1, payload: `${payload}x` }), hasCode('document_too_large'))
  })
  it('generates stable creation-month and explicit-shard partition ids', () => {
    assert.equal(journalPartitionId('2026-10', 'device-a-0'), 'journal-2026-10-device-a-0')
    assert.equal(libraryPartitionId('device-a-0'), 'library-device-a-0')
    assert.equal(partitionKind('journal-2026-10-device-a-0'), 'journal')
    assert.equal(partitionKind('library-device-a-0'), 'library')
  })
  for (const id of ['../profile', 'journal-2026-13-a', 'journal-2026-02-../a', 'library-', 'library-/a', 'unknown-a']) {
    it(`refuses unsafe partition id ${id}`, () => assert.throws(() => partitionKind(id), hasCode('invalid_partition_id')))
  }
  it('validates month and shard rather than deriving identifiers from local time', () => {
    assert.throws(() => journalPartitionId('2026-13', 'a'), hasCode('invalid_month'))
    assert.throws(() => libraryPartitionId('../a'), hasCode('invalid_shard'))
  })
})
