// @vitest-environment happy-dom
import React, { act, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import Bilan from './Bilan.jsx'
import { shiftDay } from './History.jsx'
import { backupFixture } from '../../lib/nutrition/backup.test-util.js'
import { createNutritionUISession } from '../../lib/nutrition/ui-session.js'
import { createQuickAddEntry, createWaterEntry } from '../../lib/nutrition/meal-helpers.js'
import { food } from '../../lib/nutrition/fixtures.test-util.js'
import { setLang } from '../../lib/i18n.js'
import { DEF, useStore } from '../../store/useStore.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let host, root, ui, initialS

beforeEach(async () => {
  await setLang('en', false)
  initialS = useStore.getState().S
  useStore.setState({
    S: {
      ...structuredClone(DEF),
      unit: 'kg',
      workouts: [],
      bodyweight: [],
      routines: [],
      week: {},
      dayPlan: {},
      active: null,
    },
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  ui?.close()
  host.remove()
  useStore.setState({ S: initialS })
})

const wait = async predicate => {
  const deadline = Date.now() + 4000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('UI did not settle: ' + host.textContent)
    await act(async () => { await new Promise(r => setTimeout(r, 10)) })
  }
}

const buttons = () => [...host.querySelectorAll('button')]
const button = text => {
  const b = buttons().find(n => n.textContent.trim() === text)
  expect(b, `button "${text}"`).toBeTruthy()
  return b
}
const click = async text => { await act(async () => button(text).click()) }

async function mountBilan({
  date = '2026-10-28',
  isTrainingDay,
  openDay = vi.fn(),
  openGoals = vi.fn(),
  setupStore,
  setupNutrition,
} = {}) {
  if (setupStore) {
    useStore.setState(prev => ({ S: setupStore(structuredClone(prev.S)) }))
  }
  const f = await backupFixture()
  ui = createNutritionUISession({ store: f.store, session: f.session.value, getSession: () => f.session.value })
  if (setupNutrition) await setupNutrition(ui)
  await ui.inspect()

  function Harness() {
    const status = useSyncExternalStore(ui.subscribe, ui.getSnapshot)
    return (
      <div className="nutrition">
        <Bilan
          service={ui}
          status={status}
          date={date}
          isTrainingDay={isTrainingDay}
          openDay={openDay}
          openGoals={openGoals}
        />
      </div>
    )
  }

  await act(async () => root.render(<Harness />))
  await wait(() => host.querySelector('.bilan-stack') && !host.textContent.includes('Loading…'))
  return { openDay, openGoals }
}

describe('Bilan visual analytics dashboard', () => {
  test('renders Today snapshot, training badge & active overrides, hydration, plate/meal breakdown, quality gauges, and daily log jump', async () => {
    const richFood = food({
      id: 'bowl-food',
      name: 'Power Bowl',
      reference: { amount: 100, unit: 'g' },
      nutrients: {
        kcal: 500,
        protein: 40,
        carbs: 55,
        fat: 12,
        fiber: 10,
        sugar: 18,
        saturatedFat: 4,
        sodium: 0.9,
      },
    })

    const { openDay, openGoals } = await mountBilan({
      date: '2026-10-28',
      setupStore: S => ({
        ...S,
        workouts: [
          { id: 'w1', d: '2026-10-28', date: '2026-10-28', ts: new Date('2026-10-28T09:00:00').getTime(), ex: [] },
        ],
        bodyweight: [
          { d: '2026-10-24', w: 81.2 },
          { d: '2026-10-28', w: 80.8 },
        ],
      }),
      setupNutrition: async session => {
        await session.batch([
          {
            collection: 'nutritionGoals',
            id: 'g1',
            base: null,
            value: {
              schemaVersion: 1,
              id: 'g1',
              start: '2026-10-01',
              end: null,
              mode: 'cut',
              targets: {
                kcal: 2000,
                protein: 160,
                carbs: 180,
                fat: 65,
                fiber: 30,
                sugar: 40,
                saturatedFat: 20,
                sodium: 2.3,
              },
              waterTargetMl: 3000,
              trainingTargets: {
                kcal: 2400,
                protein: 170,
                carbs: 260,
                fat: null,
                fiber: 35,
                sugar: null,
                saturatedFat: null,
                sodium: null,
              },
            },
          },
          {
            collection: 'foodEntries',
            id: 'e-lunch',
            base: null,
            value: {
              schemaVersion: 1,
              id: 'e-lunch',
              d: '2026-10-28',
              meal: 'lunch',
              snapshot: richFood,
              quantity: { amount: 200, unit: 'g' },
              note: '',
            },
          },
          {
            collection: 'foodEntries',
            id: 'e-dinner',
            base: null,
            value: createQuickAddEntry({
              id: 'e-dinner',
              date: '2026-10-28',
              meal: 'dinner',
              name: 'Salmon & rice',
              kcal: 800,
              protein: 55,
              carbs: 80,
              fat: 26,
              fiber: 6,
            }),
          },
          {
            collection: 'foodEntries',
            id: 'e-water',
            base: null,
            value: createWaterEntry({ id: 'e-water', date: '2026-10-28', ml: 1750 }),
          },
        ])
      },
    })

    // Section 1: Training day badge + active training targets (2400 kcal, 170g P, 260g C, 35g Fiber)
    expect(host.querySelector('[data-day-badge="training"]').textContent).toContain('Training day')
    expect(host.textContent).toContain('Training targets active')
    expect(host.textContent).toContain('1800 / 2400 kcal')
    expect(host.querySelector('[data-macro-row="protein"]').textContent).toContain('135 / 170 g')
    expect(host.querySelector('[data-macro-row="carbs"]').textContent).toContain('190 / 260 g')
    expect(host.querySelector('[data-hydration-gauge="true"]').textContent).toContain('1,750 / 3,000 ml')

    await click('Goals')
    expect(openGoals).toHaveBeenCalledTimes(1)

    // Section 2: MacroDonut + MealStackedBar
    const dist = host.querySelector('[data-bilan-section="distribution"]')
    expect(dist.querySelectorAll('[data-slice]').length).toBe(3)
    expect(dist.querySelector('[data-meal-legend="lunch"]').textContent).toContain('1000 kcal')
    expect(dist.querySelector('[data-meal-legend="dinner"]').textContent).toContain('800 kcal')

    // Section 3: Insufficient data unlock card + still renders weight LineChart because 2 weigh-ins exist
    const tdeeSec = host.querySelector('[data-bilan-section="tdee"]')
    expect(tdeeSec.getAttribute('data-tdee-status')).toBe('insufficient-data')
    expect(tdeeSec.querySelector('[data-unlock-req="food"]').textContent).toContain('1 / 10 days')
    expect(tdeeSec.querySelector('[data-unlock-req="weight"]').textContent).toContain('2 / 4 weigh-ins')
    expect(tdeeSec.querySelector('[data-weight-trend-chart="true"] svg')).toBeTruthy()

    // Section 4: Stepped target line because 2026-10-28 is training (2400) while earlier days are rest (2000)
    const trendsSec = host.querySelector('[data-bilan-section="trends"]')
    expect(trendsSec.querySelector('[data-target-line="stepped"]')).toBeTruthy()

    // Section 5: Quality gauges for Fiber, Sugar, Saturated fat, Sodium
    const qualitySec = host.querySelector('[data-bilan-section="quality"]')
    expect(qualitySec.querySelector('[data-quality-key="fiber"]')).toBeTruthy()
    expect(qualitySec.querySelector('[data-quality-key="sugar"]')).toBeTruthy()
    expect(qualitySec.querySelector('[data-quality-key="saturatedFat"]')).toBeTruthy()
    expect(qualitySec.querySelector('[data-quality-key="sodium"]')).toBeTruthy()

    // Daily log jump
    const logDetails = host.querySelector('[data-bilan-section="daily-log"]')
    await act(async () => logDetails.querySelector('button').click())
    expect(openDay).toHaveBeenCalledWith('2026-10-28')
  })

  test('computes Dynamic TDEE over 28-day window even when 7d pill is active, shows calibration verdict, and 1-tap updates active goal', async () => {
    const endDate = '2026-10-28'
    // 16 logged days of 2500 kcal across the 21-day window + stable weight ~80 kg => TDEE ~2500 kcal
    const commands = [
      {
        collection: 'nutritionGoals',
        id: 'goal-cut-slow',
        base: null,
        value: {
          schemaVersion: 1,
          id: 'goal-cut-slow',
          start: '2026-10-01',
          end: null,
          mode: 'cut',
          targets: {
            kcal: 2500, // 0 deficit -> 'too-slow' for a cut!
            protein: 170,
            carbs: 260,
            fat: 80,
            fiber: 30,
            sugar: null,
            saturatedFat: null,
            sodium: null,
          },
          waterTargetMl: 2500,
          trainingTargets: null,
        },
      },
    ]

    for (let offset = -18; offset <= -1; offset++) {
      const d = shiftDay(endDate, offset)
      commands.push({
        collection: 'foodEntries',
        id: `day-${d}`,
        base: null,
        value: createQuickAddEntry({
          id: `day-${d}`,
          date: d,
          meal: 'dinner',
          name: 'Daily intake',
          kcal: 2500,
          protein: 175,
          carbs: 260,
          fat: 80,
          fiber: 32,
        }),
      })
    }

    const weighIns = [
      { d: shiftDay(endDate, -19), w: 80.0 },
      { d: shiftDay(endDate, -14), w: 80.0 },
      { d: shiftDay(endDate, -9), w: 80.0 },
      { d: shiftDay(endDate, -4), w: 80.0 },
      { d: endDate, w: 80.0 },
    ]

    await mountBilan({
      date: endDate,
      setupStore: S => ({ ...S, bodyweight: weighIns }),
      setupNutrition: async session => {
        await session.batch(commands)
      },
    })

    // Today (endDate) has 0 food logged -> Rest day badge + distribution toggle to Period average
    expect(host.querySelector('[data-day-badge="rest"]').textContent).toContain('Rest day')
    await click('Period average')
    expect(host.querySelector('[data-bilan-section="distribution"]').textContent).toContain('2500 kcal')

    // Trend pill is on 7d by default, yet TDEE is 'ready' thanks to 28-day background read
    const tdeeSec = host.querySelector('[data-bilan-section="tdee"]')
    expect(tdeeSec.getAttribute('data-tdee-status')).toBe('ready')
    expect(tdeeSec.querySelector('[data-tdee-tile="estimated"]').textContent).toContain('2,500')
    expect(tdeeSec.querySelector('[data-tdee-tile="intake"]').textContent).toContain('2,500')
    expect(tdeeSec.querySelector('[data-calibration-status="too-slow"]')).toBeTruthy()

    // 1-tap Adjust goal button updates active goal in storage
    const adjustBtn = [...tdeeSec.querySelectorAll('button')].find(b => b.textContent.includes('Adjust goal to'))
    expect(adjustBtn).toBeTruthy()
    await act(async () => adjustBtn.click())

    await wait(() => tdeeSec.querySelector('[data-calibration-status="well-calibrated"]'))
    const updatedGoal = (await ui.library()).domains.flatMap(p => p.records.nutritionGoals ?? [])[0]
    expect(updatedGoal.targets.kcal).toBeLessThan(2500)

    // Period & metric pills switch cleanly (including 90d async expansion without unmounting)
    await click('30d')
    await wait(() => host.querySelector('[data-bilan-section="daily-log"] summary')?.textContent.includes('30 days'))
    await click('90d')
    await wait(() => host.querySelector('[data-bilan-section="daily-log"] summary')?.textContent.includes('90 days'))
    await click('Protein')
    expect(host.querySelector('[data-consistency-strip="true"]').textContent).toContain('175')
  })

  test('supports lb weight unit, Water trend metric, and bar day click navigation', async () => {
    const { openDay } = await mountBilan({
      date: '2026-10-28',
      setupStore: S => ({
        ...S,
        unit: 'lb',
        bodyweight: [
          { d: '2026-10-10', w: 180 },
          { d: '2026-10-15', w: 179.4 },
          { d: '2026-10-21', w: 178.8 },
          { d: '2026-10-28', w: 178.0 },
        ],
      }),
      setupNutrition: async session => {
        const cmds = []
        for (let offset = -14; offset <= -1; offset++) {
          const d = shiftDay('2026-10-28', offset)
          cmds.push({
            collection: 'foodEntries',
            id: `f-${d}`,
            base: null,
            value: createQuickAddEntry({ id: `f-${d}`, date: d, meal: 'lunch', name: 'Meal', kcal: 2200, protein: 160 }),
          })
        }
        cmds.push({
          collection: 'foodEntries',
          id: 'w-today',
          base: null,
          value: createWaterEntry({ id: 'w-today', date: '2026-10-28', ml: 2400 }),
        })
        await session.batch(cmds)
      },
    })

    const tdeeSec = host.querySelector('[data-bilan-section="tdee"]')
    expect(tdeeSec.getAttribute('data-tdee-status')).toBe('ready')
    expect(tdeeSec.querySelector('[data-tdee-tile="trend"]').textContent).toContain('lb/wk')

    const trendsSec = host.querySelector('[data-bilan-section="trends"]')
    const waterPill = [...trendsSec.querySelectorAll('button.bilan-pill')].find(b => b.textContent.trim() === 'Water')
    await act(async () => waterPill.click())
    expect(trendsSec.querySelector('[data-bar="2026-10-28"]')).toBeTruthy()

    await act(async () => trendsSec.querySelector('[data-day-hit="2026-10-27"]').dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(openDay).toHaveBeenCalledWith('2026-10-27')
  })
})
