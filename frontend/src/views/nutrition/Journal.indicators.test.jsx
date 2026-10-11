// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { beforeEach, afterEach, test, expect } from 'vitest'
import { IntakeIndicators } from './Journal.jsx'
import { daySummary } from '../../lib/nutrition/ui-service.js'
import { entry, food } from '../../lib/nutrition/fixtures.test-util.js'
import { setLang, t } from '../../lib/i18n.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const day = '2026-10-10', nutrients = ['kcal', 'protein', 'carbs', 'fat']
const consumed = { kcal: 190, protein: 6.5, carbs: 30, fat: 3.5 }
const goal = targets => ({ schemaVersion: 1, id: 'goal', start: day, end: null, mode: 'custom', targets })
let host, root, style, viewport, theme
beforeEach(async () => {
  await setLang('en', false)
  viewport = { width: window.innerWidth, height: window.innerHeight }; theme = document.documentElement.dataset.theme
  style = document.createElement('style')
  // Read project styles directly: Vitest's default CSS stub is not a stylesheet,
  // and Vite rewrites new URL(...css, import.meta.url) to an asset URL.
  style.textContent = readFileSync('src/index.css', 'utf8') + '\n' + readFileSync('src/nutrition.css', 'utf8')
  document.head.append(style)
  host = document.createElement('div'); host.className = 'nutrition'; document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); style.remove(); window.happyDOM.setWindowSize(viewport)
  if (theme === undefined) delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = theme
  await setLang('en', false)
})
async function show(goals = [], rows = [entry()]) {
  const summary = daySummary(rows, goals, day)
  await act(async () => root.render(<IntakeIndicators summary={summary} />))
  return summary
}
const cards = () => [...host.querySelector('.nutrition-indicators').children]

test('absent goals show one discreet message per nutrient without unknown targets or remaining values', async () => {
  await show()
  expect(cards()).toHaveLength(4)
  for (const card of cards()) {
    expect([...card.querySelectorAll('p')].map(p => p.textContent)).toEqual(['No goal defined'])
    expect(card.querySelector('p').classList.contains('muted')).toBe(true)
  }
  expect(host.querySelector('progress')).toBeNull(); expect(host.querySelector('.nutrition-goal-over')).toBeNull()
})
test('partial targets distinguish explicit null and omitted targets from a defined calorie target', async () => {
  await show([goal({ kcal: 200, protein: null })])
  expect(cards()[0].textContent).toContain('10 remaining')
  for (const card of cards().slice(1)) expect([...card.querySelectorAll('p')].map(p => p.textContent)).toEqual(['No goal defined'])
  expect(host.querySelectorAll('progress')).toHaveLength(1)
})
test.each([['below', 1], ['equal', 0], ['above', -1]])('all four nutrients %s their goals use explicit text and warn only for exceedance', async (state, offset) => {
  const summary = await show([goal(Object.fromEntries(nutrients.map(k => [k, consumed[k] + offset])))])
  for (const [i, key] of nutrients.entries()) {
    expect(summary.remaining[key]).toBe(offset)
    const message = cards()[i].querySelector('p:last-of-type')
    expect(message.textContent).toBe(state === 'above' ? '1 over goal' : `${offset} remaining`)
    expect(message.classList.contains('nutrition-goal-over')).toBe(state === 'above')
    expect(cards()[i].querySelector('progress').value).toBe(Math.min(consumed[key], summary.goal.targets[key]))
  }
})
test.each([['positive', [entry()]], ['empty', []]])('zero targets remain defined with %s intake, without zero-max progress bars', async (state, rows) => {
  const summary = await show([goal(Object.fromEntries(nutrients.map(k => [k, 0])))], rows)
  for (const [i, key] of nutrients.entries()) {
    expect(cards()[i].textContent).toContain('Goal: 0')
    expect(cards()[i].textContent).not.toContain('No goal defined')
    expect(cards()[i].querySelector('.nutrition-goal-over') !== null).toBe(state === 'positive')
    expect(summary.remaining[key]).toBe(state === 'positive' ? -consumed[key] : 0)
  }
  expect(host.querySelector('progress')).toBeNull()
})
test('unknown consumption with defined targets stays unavailable rather than becoming a false exceedance', async () => {
  await show([goal(consumed)], [entry({ snapshot: food({ nutrients: Object.fromEntries(nutrients.map(k => [k, null])) }) })])
  for (const card of cards()) {
    expect(card.textContent).toContain('Remaining value unavailable')
    expect(card.textContent).not.toContain('No goal defined')
  }
  expect(host.querySelector('.nutrition-goal-over')).toBeNull(); expect(host.querySelector('progress')).toBeNull()
})
test('overlapping goals preserve the explicit conflict and are not presented as absent', async () => {
  await show([goal(consumed), { ...goal(consumed), id: 'other' }])
  expect(host.querySelector('[role="alert"]').textContent).toContain('Several goals cover this day')
  expect(host.textContent).not.toContain('No goal defined'); expect(host.querySelector('.nutrition-goal-over')).toBeNull()
})
test('French absence text matches the requested wording for all four indicators', async () => {
  await setLang('fr', false); await show()
  for (const card of cards()) expect(card.querySelector('p').textContent).toBe('Pas d’objectif défini')
  expect(host.textContent).not.toContain(t('Remaining value unavailable'))
})
// happy-dom verifies media-query/style application, but has no layout engine. These assertions
// do not prove pixel fit, absence of horizontal overflow, or physical mobile rendering.
test.each([320, 390, 768, 1280])('indicator grid applies responsive rules at %i px', async width => {
  window.happyDOM.setWindowSize({ width, height: 800 }); await show([goal({ kcal: 0 })])
  const style = window.getComputedStyle(host.querySelector('.nutrition-indicators'))
  expect(style.gridTemplateColumns.replace(/\s/g, '')).toBe(`repeat(${width <= 600 ? 2 : 4},minmax(0,1fr))`)
  expect(window.getComputedStyle(cards()[0]).minWidth).toBe('0')
  expect(cards()).toHaveLength(4)
})
