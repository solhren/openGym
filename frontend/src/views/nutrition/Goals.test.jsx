// @vitest-environment happy-dom
import React, { act, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import Goals from './Goals.jsx'
import { readNutritionView } from '../../lib/nutrition/ui-service.js'
import { backupFixture } from '../../lib/nutrition/backup.test-util.js'
import { createNutritionUISession } from '../../lib/nutrition/ui-session.js'
import { setLang } from '../../lib/i18n.js'
import { useRead } from './common.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let host, root, ui

beforeEach(async () => {
  await setLang('en', false)
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  ui?.close()
  host.remove()
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

function inputIn(container, label) {
  const found = [...container.querySelectorAll('label')].find(l => l.querySelector('span')?.textContent === label)
  expect(found, `field "${label}"`).toBeTruthy()
  return found.querySelector('input, select')
}

async function setInputValue(el, value) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set.call(el, value)
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
  })
}

async function submitForm() {
  await act(async () => {
    host.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  await wait(() => !host.querySelector('form') || !!host.querySelector('[role="alert"]'))
}

async function mountGoals({ date = '2026-10-10', suggestedKcal = null, openBilan = null, setup } = {}) {
  const f = await backupFixture()
  ui = createNutritionUISession({ store: f.store, session: f.session.value, getSession: () => f.session.value })
  if (setup) await setup(ui)
  await ui.inspect()

  function Harness() {
    const status = useSyncExternalStore(ui.subscribe, ui.getSnapshot)
    const content = useRead(ui, status.revision, { date }, () => readNutritionView(ui, { date, includeEntries: false }))
    if (!content.data) return <p>Loading…</p>
    return (
      <div className="nutrition">
        <Goals
          data={content.data}
          date={date}
          service={ui}
          status={status}
          suggestedKcal={suggestedKcal}
          openBilan={openBilan}
        />
      </div>
    )
  }

  await act(async () => root.render(<Harness />))
  await wait(() => !host.textContent.includes('Loading…'))
}

describe('Goals & GoalEditor (Training/Rest overrides, Water & Quality targets)', () => {
  test('creates a goal with default 2500 ml water target, quality ceilings, and training overrides without any toggle switch', async () => {
    await mountGoals()
    await click('Create nutrition goal')

    // Both sections are directly visible with no checkbox/toggle switch
    expect(host.querySelector('input[type="checkbox"]')).toBeNull()
    const restSection = host.querySelector('[data-goal-section="rest"]')
    const trainingSection = host.querySelector('[data-goal-section="training"]')
    expect(restSection).toBeTruthy()
    expect(trainingSection).toBeTruthy()
    expect(restSection.textContent).toContain('Daily / Rest day targets')
    expect(trainingSection.textContent).toContain('Training day overrides (optional)')
    expect(trainingSection.textContent).toContain('Leave blank to keep the rest-day target for that nutrient.')

    // Default water target is 2500 ml on creation
    expect(inputIn(restSection, 'Water target (ml)').value).toBe('2500')

    await setInputValue(inputIn(host, 'Goal mode'), 'cut')
    await setInputValue(inputIn(restSection, 'Calories'), '2100')
    await setInputValue(inputIn(restSection, 'Protein'), '170')
    await setInputValue(inputIn(restSection, 'Carbohydrates'), '190')
    await setInputValue(inputIn(restSection, 'Fat'), '70')
    await setInputValue(inputIn(restSection, 'Fiber'), '32')
    await setInputValue(inputIn(restSection, 'Sugar'), '45')
    await setInputValue(inputIn(restSection, 'Water target (ml)'), '3000')

    // Override only Calories and Carbohydrates on training days; leave Protein/Fat/Fiber blank
    await setInputValue(inputIn(trainingSection, 'Calories'), '2450')
    await setInputValue(inputIn(trainingSection, 'Carbohydrates'), '275')

    await submitForm()
    expect(host.querySelector('form')).toBeNull()

    const savedGoals = (await ui.library()).domains.flatMap(p => p.records.nutritionGoals ?? [])
    expect(savedGoals).toHaveLength(1)
    expect(savedGoals[0].waterTargetMl).toBe(3000)
    expect(savedGoals[0].targets.fiber).toBe(32)
    expect(savedGoals[0].targets.sugar).toBe(45)
    expect(savedGoals[0].trainingTargets.kcal).toBe(2450)
    expect(savedGoals[0].trainingTargets.carbs).toBe(275)
    expect(savedGoals[0].trainingTargets.protein).toBeNull()

    // Goal card renders Rest vs Training comparison, water target, and quality chips
    const comp = host.querySelector('[data-goal-comparison="true"]')
    expect(comp).toBeTruthy()
    expect(comp.querySelector('[data-goal-day="rest"]').textContent).toContain('2,100')
    expect(comp.querySelector('[data-goal-day="training"]').textContent).toContain('2,450')
    // Inherited protein (170 g) appears on training day row too
    expect(comp.querySelector('[data-goal-day="training"]').textContent).toContain('170')
    expect(host.querySelector('[data-water-target="true"]').textContent).toContain('3,000 ml')
    expect(host.querySelector('[data-quality-chip="fiber"]').textContent).toContain('32 g')
    expect(host.querySelector('[data-quality-chip="sugar"]').textContent).toContain('45 g')
  })

  test('clearing waterTargetMl and all training overrides saves explicit nulls and never deletes keys', async () => {
    await mountGoals({
      setup: async session => {
        await session.save('nutritionGoals', {
          schemaVersion: 1,
          id: 'goal-1',
          start: '2026-10-01',
          end: null,
          mode: 'bulk',
          targets: {
            kcal: 2800,
            protein: 180,
            carbs: 340,
            fat: 80,
            fiber: 35,
            sugar: null,
            saturatedFat: null,
            sodium: null,
          },
          waterTargetMl: 3200,
          trainingTargets: {
            kcal: 3100,
            protein: null,
            carbs: 415,
            fat: null,
            fiber: 40,
            sugar: null,
            saturatedFat: null,
            sodium: null,
          },
        })
      },
    })

    await click('Edit')
    const restSection = host.querySelector('[data-goal-section="rest"]')
    const trainingSection = host.querySelector('[data-goal-section="training"]')

    expect(inputIn(restSection, 'Water target (ml)').value).toBe('3200')
    expect(inputIn(trainingSection, 'Calories').value).toBe('3100')
    expect(inputIn(trainingSection, 'Carbohydrates').value).toBe('415')
    expect(inputIn(trainingSection, 'Fiber').value).toBe('40')

    await setInputValue(inputIn(restSection, 'Water target (ml)'), '')
    await setInputValue(inputIn(trainingSection, 'Calories'), '')
    await setInputValue(inputIn(trainingSection, 'Carbohydrates'), '')
    await setInputValue(inputIn(trainingSection, 'Fiber'), '')

    await submitForm()
    expect(host.querySelector('[role="alert"]')).toBeNull()
    expect(host.querySelector('form')).toBeNull()

    const updated = (await ui.library()).domains.flatMap(p => p.records.nutritionGoals ?? [])[0]
    expect(Object.hasOwn(updated, 'waterTargetMl')).toBe(true)
    expect(updated.waterTargetMl).toBeNull()
    expect(Object.hasOwn(updated, 'trainingTargets')).toBe(true)
    expect(updated.trainingTargets).toBeNull()

    // Card falls back to 2,500 ml display and standard NutrientValues (no comparison block)
    expect(host.querySelector('[data-goal-comparison="true"]')).toBeNull()
    expect(host.querySelector('[data-water-target="true"]').textContent).toContain('2,500 ml')
  })

  test('suggestedKcal updates active goal in 1 tap and openBilan navigates to Overview', async () => {
    const openBilan = vi.fn()
    await mountGoals({
      suggestedKcal: 2350,
      openBilan,
      setup: async session => {
        await session.save('nutritionGoals', {
          schemaVersion: 1,
          id: 'goal-cut',
          start: '2026-10-01',
          end: null,
          mode: 'cut',
          targets: {
            kcal: 2600,
            protein: 170,
            carbs: 250,
            fat: 80,
            fiber: null,
            sugar: null,
            saturatedFat: null,
            sodium: null,
          },
          waterTargetMl: 2800,
          trainingTargets: null,
        })
      },
    })

    await click('Overview')
    expect(openBilan).toHaveBeenCalledTimes(1)

    expect(host.querySelector('[data-suggested-kcal="2350"]')).toBeTruthy()
    await click('Adjust goal to 2350 kcal')
    await wait(() => !host.querySelector('[data-suggested-kcal="2350"]'))

    const updated = (await ui.library()).domains.flatMap(p => p.records.nutritionGoals ?? [])[0]
    expect(updated.targets.kcal).toBe(2350)
    expect(updated.waterTargetMl).toBe(2800)
  })
})
