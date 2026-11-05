// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, afterEach, test, expect, vi } from 'vitest'
import { useStore } from '../store/useStore.js'
import { _setLangState } from '../lib/i18n-core.js'
import { ConnectSheet } from './MobileOnboarding.jsx'

vi.mock('../lib/public-android.js', async original => ({ ...await original(), PUBLIC_ANDROID: true }))
let root, host, connect, close
const type = (el, value) => act(() => {
  Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
})
const submit = () => host.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  _setLangState('en', null, null, null)
  connect = vi.fn().mockResolvedValue(undefined); close = vi.fn()
  useStore.setState({ connectToServer: connect })
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  act(() => root.render(<ConnectSheet close={close} />))
})
afterEach(() => { act(() => root.unmount()); host.remove() })

test('generic pairing explains HTTPS and refuses unsafe addresses before sending a code', async () => {
  const [url, code] = host.querySelectorAll('input')
  expect(host.textContent).toContain('trusted HTTPS')
  expect(host.textContent).not.toContain('gym.solhren.fr')
  expect(document.getElementById(url.getAttribute('aria-describedby')).textContent).toContain('HTTPS')
  for (const address of ['http://gym.example.com', 'https://gym.example.com/api', 'https://user:password@gym.example.com']) {
    type(url, address); type(code, 'abcd2345')
    await act(async () => submit())
    expect(host.querySelector('[role="alert"]').textContent).toContain('trusted HTTPS')
    expect(connect).not.toHaveBeenCalled()
    expect(code.value).toBe('ABCD2345')
  }
  expect(host.textContent).not.toContain('Fine on your home network')
})

test('keyboard submission pairs once and locks the fields until completion', async () => {
  let finish
  connect.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const [url, code] = host.querySelectorAll('input')
  type(url, 'my-gym.example.com'); type(code, 'abcd2345')
  await act(async () => { submit(); submit() })
  expect(connect).toHaveBeenCalledTimes(1)
  expect(url.disabled).toBe(true); expect(code.disabled).toBe(true)
  expect(close).not.toHaveBeenCalled()
  await act(async () => finish())
  expect(close).toHaveBeenCalledTimes(1)
  expect(connect).toHaveBeenCalledWith('my-gym.example.com', 'ABCD2345', expect.any(Function))
})

test('network errors stay visible and allow retry without losing the entered server or code', async () => {
  connect.mockRejectedValueOnce(new Error('The server did not answer in time.'))
  const [url, code] = host.querySelectorAll('input')
  type(url, 'https://my-gym.example.com'); type(code, 'abcd2345')
  await act(async () => submit())
  expect(host.querySelector('[role="alert"]').textContent).toContain('did not answer')
  expect(url.disabled).toBe(false); expect(code.value).toBe('ABCD2345')
  await act(async () => submit())
  expect(close).toHaveBeenCalledTimes(1)
})
