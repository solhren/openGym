// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, test, expect, vi } from 'vitest'
import CameraScan from './CameraScan.jsx'
globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root, host, getUserMedia, stop
beforeEach(() => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); stop = vi.fn(); getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop }] }))
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } }); vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(); vi.spyOn(HTMLMediaElement.prototype, 'srcObject', 'set').mockImplementation(() => {})
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.useRealTimers() })
test('late camera permission after unmount immediately releases tracks', async () => {
  let resolve; getUserMedia.mockImplementation(() => new Promise(r => { resolve = r }))
  await act(async () => root.render(<CameraScan onFound={vi.fn()} onCancel={vi.fn()} />)); await act(async () => root.unmount())
  await act(async () => resolve({ getTracks: () => [{ stop }] })); expect(stop).toHaveBeenCalledTimes(1)
  root = createRoot(host)
})
test('decoder waiting at unmount cannot reschedule a timer or deliver a code', async () => {
  vi.useFakeTimers(); let resolve; const decode = vi.fn(() => new Promise(r => { resolve = r })), onFound = vi.fn()
  vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(2)
  await act(async () => root.render(<CameraScan decode={decode} hint="Point the camera at the product barcode" onFound={onFound} onCancel={vi.fn()} />)); expect(decode).toHaveBeenCalledTimes(1)
  await act(async () => root.unmount()); await act(async () => resolve({ value: '3017620422003', fmt: 'ean_13' }))
  expect(onFound).not.toHaveBeenCalled(); expect(stop).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0); root = createRoot(host)
})
test('detected code stops capture before handing it to the caller', async () => {
  vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(2)
  const onFound = vi.fn(() => expect(stop).toHaveBeenCalled())
  await act(async () => root.render(<CameraScan decode={async () => ({ value: '3017620422003', fmt: 'ean_13' })} onFound={onFound} onCancel={vi.fn()} />)); expect(onFound).toHaveBeenCalledTimes(1)
})
