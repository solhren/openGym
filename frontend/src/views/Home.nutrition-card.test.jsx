// @vitest-environment happy-dom
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { DEF, useStore } from '../store/useStore.js'
import { todayISO } from '../lib/format.js'
import { setLang } from '../lib/i18n.js'
import Home from './Home.jsx'

const nav = vi.fn()
const readHomeNutritionSummary = vi.fn()

vi.mock('react-router-dom', () => ({ useNavigate: () => nav }))
vi.mock('../sheets.jsx', () => ({
  starterPlanSheet: vi.fn(), bwSheet: vi.fn(), goalSheet: vi.fn(), dayOverrideSheet: vi.fn(),
  calendarSheet: vi.fn(), startFlow: vi.fn(), bwDeltaColor: () => '', weighInsSheet: vi.fn(),
}))
vi.mock('../lib/nutrition/home-summary.js', () => ({
  readHomeNutritionSummary: (...args) => readHomeNutritionSummary(...args),
}))

let host, root, previous, errors

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  previous = useStore.getState()
  localStorage.clear()
  nav.mockClear()
  readHomeNutritionSummary.mockReset()
  vi.stubGlobal('indexedDB', {})
  errors = vi.spyOn(console, 'error')
  await setLang('en')
  useStore.setState({
    S: structuredClone(DEF),
    user: null,
    sync: { ...previous.sync, server: 'https://gym.example.com' },
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
    useStore.setState(previous, true)
  })
  host.remove()
  localStorage.clear()
  await setLang('en')
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const flush = async () => {
  for (let i = 0; i < 6; i++) {
    await act(async () => { await Promise.resolve() })
  }
}

const mountHome = async ({ user = null, guest = false, S = {} } = {}) => {
  if (guest) localStorage.setItem('gym_guest', '1')
  else localStorage.removeItem('gym_guest')
  useStore.setState(s => ({
    S: { ...structuredClone(DEF), ...S },
    user,
    sync: { ...s.sync, server: 'https://gym.example.com' },
  }))
  await act(async () => root.render(<Home />))
  await flush()
}

describe('Home live Nutrition card', () => {
  it('renders cold/empty state and wires header + quick-action navigation', async () => {
    readHomeNutritionSummary.mockResolvedValue({
      hasData: false,
      hasGoal: false,
      consumedKcal: 0,
      targetKcal: null,
      remainingKcal: null,
      consumedProtein: 0,
      targetProtein: null,
      remainingProtein: null,
      isTrainingDay: false,
    })

    await mountHome({ guest: true })

    expect(host.textContent).toContain('Food journal, recipes and nutrition goals')
    const openBtn = [...host.querySelectorAll('button')].find(b => b.textContent.trim() === 'Nutrition')
    const addBtn = host.querySelector('button[aria-label="Add food"]')
    const scanBtn = host.querySelector('button[aria-label="Scan product barcode"]')
    expect(openBtn).toBeTruthy()
    expect(addBtn).toBeTruthy()
    expect(scanBtn).toBeTruthy()

    await act(async () => { openBtn.click() })
    expect(nav).toHaveBeenLastCalledWith('/nutrition')

    await act(async () => { addBtn.click() })
    expect(nav).toHaveBeenLastCalledWith('/nutrition?view=journal&add=1')

    await act(async () => { scanBtn.click() })
    expect(nav).toHaveBeenLastCalledWith('/nutrition?view=journal&scan=1')
    expect(errors).not.toHaveBeenCalled()
  })

  it('shows remaining kcal and protein for an active goal on a rest day', async () => {
    readHomeNutritionSummary.mockResolvedValue({
      hasData: true,
      hasGoal: true,
      consumedKcal: 950,
      targetKcal: 2200,
      remainingKcal: 1250,
      consumedProtein: 72,
      targetProtein: 160,
      remainingProtein: 88,
      entryCount: 2,
      isTrainingDay: false,
    })

    await mountHome({ user: { id: 'u1', name: 'Alex' } })

    expect(readHomeNutritionSummary).toHaveBeenCalledWith({
      date: todayISO(),
      user: { id: 'u1', name: 'Alex' },
      isGuestMode: false,
      serverUrl: 'https://gym.example.com',
      isTrainingDay: false,
    })
    expect(host.textContent).toContain('Rest day')
    expect(host.textContent).toContain('1250 kcal remaining')
    expect(host.textContent).toContain('950 / 2200 kcal')
    expect(host.textContent).toContain('72 / 160 g protein')
    const bar = host.querySelector('[role="progressbar"]')
    expect(bar).toBeTruthy()
    expect(bar.getAttribute('aria-valuenow')).toBe('950')
    expect(bar.getAttribute('aria-valuemax')).toBe('2200')
    expect(errors).not.toHaveBeenCalled()
  })

  it('applies training-day target override when today has a planned workout', async () => {
    const weekday = new Date().getDay()
    readHomeNutritionSummary.mockImplementation(async ({ isTrainingDay }) => ({
      hasData: true,
      hasGoal: true,
      consumedKcal: 1500,
      targetKcal: isTrainingDay ? 2700 : 2200,
      remainingKcal: isTrainingDay ? 1200 : 700,
      consumedProtein: 110,
      targetProtein: isTrainingDay ? 190 : 160,
      remainingProtein: isTrainingDay ? 80 : 50,
      entryCount: 3,
      isTrainingDay,
    }))

    await mountHome({
      guest: true,
      S: {
        routines: [{ id: 'r1', name: 'Upper', emoji: null, ex: [{ id: '0025' }] }],
        week: { [weekday]: ['r1'] },
      },
    })

    expect(readHomeNutritionSummary).toHaveBeenCalledWith({
      date: todayISO(),
      user: null,
      isGuestMode: true,
      serverUrl: 'https://gym.example.com',
      isTrainingDay: true,
    })
    expect(host.textContent).toContain('Training day')
    expect(host.textContent).toContain('1200 kcal remaining')
    expect(host.textContent).toContain('1500 / 2700 kcal')
    expect(host.textContent).toContain('110 / 190 g protein')
    expect(errors).not.toHaveBeenCalled()
  })

  it('renders over-goal kcal cleanly and caps progress bar at 100%', async () => {
    readHomeNutritionSummary.mockResolvedValue({
      hasData: true,
      hasGoal: true,
      consumedKcal: 2480,
      targetKcal: 2200,
      remainingKcal: -280,
      consumedProtein: 175,
      targetProtein: 160,
      remainingProtein: -15,
      entryCount: 4,
      isTrainingDay: false,
    })

    await mountHome({ guest: true })

    expect(host.textContent).toContain('280 kcal over goal')
    expect(host.textContent).toContain('2480 / 2200 kcal')
    expect(host.textContent).toContain('175 / 160 g protein')
    const fill = host.querySelector('[role="progressbar"] > div')
    expect(fill.style.width).toBe('100%')
    expect(errors).not.toHaveBeenCalled()
  })

  it('shows consumed kcal and protein when entries exist without an active goal', async () => {
    readHomeNutritionSummary.mockResolvedValue({
      hasData: true,
      hasGoal: false,
      consumedKcal: 640.4,
      targetKcal: null,
      remainingKcal: null,
      consumedProtein: 42.6,
      targetProtein: null,
      remainingProtein: null,
      entryCount: 2,
      isTrainingDay: false,
    })

    await mountHome({ guest: true })

    expect(host.textContent).toContain('640 kcal · 43 g protein')
    expect(host.querySelector('[role="progressbar"]')).toBeNull()
    expect(errors).not.toHaveBeenCalled()
  })

  it('does not update state or warn when unmounted before async summary resolves', async () => {
    let resolveSummary
    readHomeNutritionSummary.mockImplementation(() => new Promise(resolve => { resolveSummary = resolve }))

    await mountHome({ guest: true })
    expect(readHomeNutritionSummary).toHaveBeenCalledTimes(1)

    await act(async () => { root.unmount() })
    await act(async () => {
      resolveSummary({
        hasData: true,
        hasGoal: true,
        consumedKcal: 500,
        targetKcal: 2000,
        remainingKcal: 1500,
        consumedProtein: 40,
        targetProtein: 150,
        remainingProtein: 110,
        entryCount: 1,
        isTrainingDay: false,
      })
      await Promise.resolve()
    })

    expect(errors).not.toHaveBeenCalled()
  })
})
