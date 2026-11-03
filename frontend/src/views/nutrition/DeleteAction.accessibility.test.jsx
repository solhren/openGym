// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { DeleteAction } from './common.jsx'
import { setLang } from '../../lib/i18n.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let host, root
beforeEach(async () => {
  await setLang('en', false)
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })
const buttons = () => [...host.querySelectorAll('button')]
const render = (props = {}) => act(() => root.render(<DeleteAction name="Oats" remove={vi.fn()} {...props} />))
const open = () => act(() => { buttons()[0].focus(); buttons()[0].click() })
const escape = () => act(() => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))

test.each([false, true])('focuses the safe confirmation action, labels the prompt and restores focus on Cancel (compact=%s)', compact => {
  render({ compact }); expect(document.activeElement).not.toBe(buttons()[0])
  open()
  const group = host.querySelector('[role="group"]')
  expect(group.getAttribute('aria-label')).toBe('Delete Oats')
  expect(document.getElementById(group.getAttribute('aria-describedby')).textContent).toBe('Delete Oats? Historical food snapshots are preserved.')
  expect(document.activeElement).toBe(buttons()[1])
  expect(document.activeElement.textContent).toBe('Cancel')
  act(() => buttons()[1].click())
  expect(host.querySelector('.nutrition-confirm')).toBeNull()
  expect(document.activeElement).toBe(buttons()[0])
  expect(document.activeElement.getAttribute('aria-label')).toBe('Delete Oats')
})

test('Escape dismisses only its confirmation and never deletes', () => {
  const remove = vi.fn(), parentKey = vi.fn()
  act(() => root.render(<div onKeyDown={parentKey}><DeleteAction name="Oats" remove={remove} /></div>))
  open(); escape()
  expect(host.querySelector('.nutrition-confirm')).toBeNull()
  expect(document.activeElement).toBe(buttons()[0])
  expect(remove).not.toHaveBeenCalled(); expect(parentKey).not.toHaveBeenCalled()
})

test('an active deletion cannot be dismissed with Escape and failures keep the confirmation available', async () => {
  let reject
  const remove = vi.fn(() => new Promise((_, fail) => { reject = fail }))
  render({ remove }); open()
  await act(async () => { buttons()[0].focus(); buttons()[0].click() })
  escape()
  expect(host.querySelector('.nutrition-confirm')).not.toBeNull()
  expect(remove).toHaveBeenCalledTimes(1)
  await act(async () => reject(new Error('synthetic failure')))
  expect(host.querySelector('[role="alert"]').textContent).toContain('Unable to complete this action')
  escape()
  expect(document.activeElement).toBe(buttons()[0])
})

test('busy state prevents deletion and Escape dismissal until saving finishes', () => {
  const remove = vi.fn()
  render({ remove }); open(); render({ remove, busy: true })
  expect(buttons().every(button => button.disabled)).toBe(true)
  act(() => host.querySelector('.nutrition-confirm').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(host.querySelector('.nutrition-confirm')).not.toBeNull()
  expect(remove).not.toHaveBeenCalled()
  render({ remove, busy: false }); escape()
  expect(host.querySelector('.nutrition-confirm')).toBeNull()
})

test.each(['resolve', 'reject'])('finishing a deletion after leaving the screen does not move focus (%s)', async outcome => {
  let resolve, reject
  const remove = vi.fn(() => new Promise((done, fail) => { resolve = done; reject = fail }))
  render({ remove }); open()
  await act(async () => { buttons()[0].focus(); buttons()[0].click() })
  act(() => root.render(<button>New screen</button>))
  buttons()[0].focus(); const destination = document.activeElement
  await act(async () => { if (outcome === 'resolve') resolve(); else reject(new Error('synthetic failure')) })
  expect(document.activeElement).toBe(destination)
  expect(host.textContent).toBe('New screen')
})
