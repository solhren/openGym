// @vitest-environment happy-dom
import { afterEach, test, expect, vi } from 'vitest'
vi.mock('./demo.js', () => ({ DEMO: true }))
import { api, authenticatedCatalogFetch, apiBlob, apiUpload, pairRedeem, beacon } from './api.js'

afterEach(() => vi.unstubAllGlobals())
test('static demo rejects backend, pairing, catalogue and media calls before any network dispatch', async () => {
  const fetch = vi.fn(() => { throw Error('Unexpected fetch') })
  vi.stubGlobal('fetch', fetch)
  const xhr = vi.fn()
  for (const call of [() => api('/api/me'), () => api('/api/data', { method: 'PUT', body: '{}' }),
    () => apiBlob('/api/media/example'), () => apiUpload('/api/media/example', new Blob(), 'image/png', { XHR: xhr }),
    () => pairRedeem('https://example.invalid', 'not-a-real-code')]) {
    await expect(call()).rejects.toMatchObject({ code: 'demo-offline' })
  }
  expect(() => authenticatedCatalogFetch('/api/nutrition/catalog/capabilities')).toThrow()
  expect(beacon('/api/data', {})).toBe(false)
  expect(fetch).not.toHaveBeenCalled(); expect(xhr).not.toHaveBeenCalled()
})
