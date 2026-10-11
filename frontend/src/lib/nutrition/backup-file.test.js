import assert from 'node:assert/strict'
import { test, vi } from 'vitest'
import { saveNutritionBackup } from './backup-file.js'
import { hasCode } from './persistence.test-util.js'
const result = { blob: new Blob(['data']), digest: 'a'.repeat(64) }
test('native share uses generated path-safe filename and keeps Blob on rejection', async () => {
  const calls = [], shared = await saveNutritionBackup(result, { native: true, share: async (...args) => calls.push(args) })
  assert.equal(shared.filename, 'opengym-backup-aaaaaaaaaaaaaaaa.zip'); assert.equal(calls[0][0], result.blob)
  await assert.rejects(saveNutritionBackup(result, { native: true, share: async () => { throw Error('cancelled') } }), /cancelled/)
  assert.equal(result.blob.size, 4)
})
test('browser download revokes its URL; unavailable browser APIs are refused', async () => {
  vi.useFakeTimers()
  try {
    let clicked = 0, revoked = 0; const link = { click() { clicked++ } }
    const output = await saveNutritionBackup(result, { native: false, document: { createElement: () => link }, url: { createObjectURL: () => 'blob:fixed', revokeObjectURL() { revoked++ } } })
    assert.equal(output.status, 'download-requested'); assert.equal(clicked, 1); vi.runAllTimers(); assert.equal(revoked, 1)
    await assert.rejects(saveNutritionBackup(result, { native: false, document: null }), hasCode('backup_download_unavailable'))
  } finally { vi.useRealTimers() }
})
