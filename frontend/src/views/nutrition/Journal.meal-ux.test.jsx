// @vitest-environment happy-dom
import React, { act, useEffect, useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import Journal from './Journal.jsx'
import { backupFixture } from '../../lib/nutrition/backup.test-util.js'
import { createNutritionUISession } from '../../lib/nutrition/ui-session.js'
import { readNutritionView } from '../../lib/nutrition/ui-service.js'
import { createWaterEntry } from '../../lib/nutrition/meal-helpers.js'
import { food, entry, recipe } from '../../lib/nutrition/fixtures.test-util.js'
import { setLang } from '../../lib/i18n.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let host, root, ui, fixture

beforeEach(async () => {
  await setLang('en', false)
  host = document.createElement('div')
  host.className = 'nutrition'
  document.body.appendChild(host)
  root = createRoot(host)
  fixture = await backupFixture()
  ui = createNutritionUISession({
    store: fixture.store,
    session: fixture.session.value,
    getSession: () => fixture.session.value,
    online: () => false,
  })
})

afterEach(async () => {
  if (ui) await wait(() => !ui.getSnapshot().busy).catch(() => {})
  await act(async () => root.unmount())
  ui?.close()
  host.remove()
  vi.clearAllMocks()
})

const wait = async predicate => {
  const deadline = Date.now() + 4000
  while (!predicate()) {
    if (Date.now() > deadline) throw Error('UI did not settle: ' + host.textContent)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  }
}

const buttons = (scope = host) => [...scope.querySelectorAll('button')]
const button = (text, scope = host) => {
  const found = buttons(scope).find(b => b.textContent.trim() === text)
  expect(found, text).toBeTruthy()
  return found
}
const click = async (text, scope = host) => { await act(async () => button(text, scope).click()) }
const field = (label, scope = host) => {
  const found = [...scope.querySelectorAll('label')].find(l => l.querySelector('span')?.textContent === label)
  expect(found, label).toBeTruthy()
  return found.querySelector('input, select')
}
const type = async (label, value, scope = host) => {
  await act(async () => {
    const el = typeof label === 'string' ? field(label, scope) : label
    Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set.call(el, value)
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
  })
}

async function mountJournal({
  date = '2026-10-10',
  initialMeal = 'breakfast',
  isTrainingDay = false,
  launchAction = null,
  onClearLaunchAction = vi.fn(),
  onCreateFood = vi.fn(),
} = {}) {
  await ui.inspect()
  let setPropsExternal
  function Harness() {
    const status = useSyncExternalStore(ui.subscribe, ui.getSnapshot)
    const [props, setProps] = useState({ date, initialMeal, isTrainingDay, launchAction })
    const [data, setData] = useState(null)
    setPropsExternal = setProps
    useEffect(() => {
      let active = true
      readNutritionView(ui, { date: props.date }).then(view => {
        if (active) setData(view)
      }).catch(() => {})
      return () => { active = false }
    }, [props.date, status.revision])
    if (!data) return <p>Loading…</p>
    return (
      <Journal
        date={props.date}
        data={data}
        service={ui}
        status={status}
        initialMeal={props.initialMeal}
        isTrainingDay={props.isTrainingDay}
        launchAction={props.launchAction}
        onClearLaunchAction={() => {
          onClearLaunchAction()
          setProps(prev => ({ ...prev, launchAction: null }))
        }}
        onCreateFood={onCreateFood}
      />
    )
  }
  await act(async () => root.render(<Harness />))
  await wait(() => !host.textContent.includes('Loading…'))
  return {
    onClearLaunchAction,
    onCreateFood,
    updateProps: async patch => {
      await act(async () => setPropsExternal(prev => ({ ...prev, ...patch })))
    },
  }
}

test('rapid hydration bar logs +250 ml / +500 ml, supports undo, and keeps water out of meals', async () => {
  await mountJournal({ date: '2026-10-10' })
  const hydration = () => host.querySelector('.nutrition-hydration')
  const waterAmountText = () => hydration().querySelector('strong')?.textContent ?? ''
  expect(waterAmountText()).toContain('0 / 2,500 ml')
  expect(hydration().querySelector('[aria-label="Undo last water entry"]')).toBeNull()

  await click('+250 ml', hydration())
  await wait(() => waterAmountText().startsWith('250'))
  expect(hydration().querySelector('progress').value).toBe(250)

  await click('+500 ml', hydration())
  await wait(() => waterAmountText().startsWith('750'))
  expect(hydration().querySelector('progress').value).toBe(750)

  // Water entries never clutter the 4 meal cards
  for (const mealSection of host.querySelectorAll('.nutrition-meal')) {
    expect(mealSection.textContent).toContain('No food logged in this meal')
    expect(mealSection.querySelectorAll('.nutrition-list > li')).toHaveLength(0)
  }

  // Undo removes the last glass (500 ml -> back to 250 ml)
  await act(async () => hydration().querySelector('[aria-label="Undo last water entry"]').click())
  await wait(() => waterAmountText().startsWith('250'))
  expect((await ui.day('2026-10-10')).entries).toHaveLength(1)
})

test('copy meal from yesterday works via empty meal 1-tap CTA and header action menu, ignoring water', async () => {
  const oats = food({ id: 'oats', name: 'Rolled oats' })
  const banana = food({ id: 'banana', name: 'Banana', nutrients: { kcal: 89, protein: 1.1, carbs: 23, fat: 0.3, fiber: 2.6 } })
  await ui.batch([
    { collection: 'customFoods', id: oats.id, value: oats, base: null },
    { collection: 'customFoods', id: banana.id, value: banana, base: null },
    { collection: 'foodEntries', id: 'y1', value: entry({ id: 'y1', d: '2026-10-09', meal: 'breakfast', snapshot: oats, quantity: { amount: 60, unit: 'g' } }), base: null },
    { collection: 'foodEntries', id: 'y2', value: entry({ id: 'y2', d: '2026-10-09', meal: 'breakfast', snapshot: banana, quantity: { amount: 120, unit: 'g' } }), base: null },
    { collection: 'foodEntries', id: 'yw', value: createWaterEntry({ id: 'yw', date: '2026-10-09', ml: 500 }), base: null },
  ])

  await mountJournal({ date: '2026-10-10' })
  const breakfastCard = () => host.querySelector('section[aria-label="Breakfast"]')
  await wait(() => breakfastCard().textContent.includes('Copy from yesterday (2)'))

  // 1-tap copy on empty meal card
  await click('Copy from yesterday (2)', breakfastCard())
  await wait(() => breakfastCard().querySelectorAll('.nutrition-list > li').length === 2)
  expect(breakfastCard().textContent).toContain('Rolled oats')
  expect(breakfastCard().textContent).toContain('Banana')

  // Header menu still allows appending yesterday's meal even when non-empty
  const menu = breakfastCard().querySelector('.nutrition-meal-menu')
  await act(async () => menu.querySelector('summary').click())
  await click('Copy from yesterday', menu)
  await wait(() => breakfastCard().querySelectorAll('.nutrition-list > li').length === 4)
})

test('duplicate meal copies entries to another target date and target meal', async () => {
  const chicken = food({ id: 'chicken', name: 'Grilled chicken', nutrients: { kcal: 165, protein: 31, carbs: 0, fat: 3.6, fiber: 0 } })
  await ui.batch([
    { collection: 'customFoods', id: chicken.id, value: chicken, base: null },
    { collection: 'foodEntries', id: 'l1', value: entry({ id: 'l1', d: '2026-10-10', meal: 'lunch', snapshot: chicken, quantity: { amount: 180, unit: 'g' } }), base: null },
  ])

  await mountJournal({ date: '2026-10-10' })
  const lunchCard = () => host.querySelector('section[aria-label="Lunch"]')
  const menu = lunchCard().querySelector('.nutrition-meal-menu')
  await act(async () => menu.querySelector('summary').click())
  await click('Duplicate meal…', menu)

  const dupPanel = lunchCard().querySelector('.nutrition-meal-duplicate')
  expect(dupPanel).toBeTruthy()
  expect(field('Target date', dupPanel).value).toBe('2026-10-11')
  await type('Target date', '2026-10-12', dupPanel)
  await type('Target meal', 'dinner', dupPanel)
  await click('Copy meal', dupPanel)

  await wait(() => !lunchCard().querySelector('.nutrition-meal-duplicate'))
  const copiedDay = await ui.day('2026-10-12')
  expect(copiedDay.entries).toHaveLength(1)
  expect(copiedDay.entries[0].meal).toBe('dinner')
  expect(copiedDay.entries[0].snapshot.name).toBe('Grilled chicken')
  expect(copiedDay.entries[0].quantity.amount).toBe(180)
})

test('quick add supports Add & continue, Save, validation, and direct re-editing from meal list', async () => {
  await mountJournal({ date: '2026-10-10', initialMeal: 'lunch' })
  await click('Add food')
  await click('Quick add')

  const quickForm = () => host.querySelector('form.nutrition-quick-add')
  expect(quickForm()).toBeTruthy()

  // Invalid negative calories rejected
  await type('Calories', '-50', quickForm())
  await click('Save', quickForm())
  expect(quickForm().querySelector('[role="alert"]')).toBeTruthy()
  expect((await ui.day('2026-10-10')).entries).toHaveLength(0)

  // Add & continue stays in picker, increments session counter, resets fields
  await type('Name', 'Espressocookie', quickForm())
  await type('Calories', '140', quickForm())
  await type('Carbohydrates', '18,5', quickForm())
  await click('Add & continue', quickForm())
  await wait(() => host.querySelector('.nutrition-picker-session-bar')?.textContent.includes('1 added'))
  expect(field('Calories', quickForm()).value).toBe('')
  expect(host.querySelector('.nutrition-picker')).toBeTruthy()

  // Second item via Save closes picker and returns to Journal
  await type('Name', 'Restaurant steak', quickForm())
  await type('Calories', '450', quickForm())
  await type('Protein', '42', quickForm())
  await type('Fiber', '3', quickForm())
  await click('Save', quickForm())

  await wait(() => !host.querySelector('.nutrition-picker') && host.textContent.includes('Restaurant steak'))
  expect(host.textContent).toContain('Espressocookie')

  // Clicking Edit on a Quick Add entry opens QuickAddEditor pre-filled instead of EntryEditor
  await act(async () => host.querySelector('[aria-label="Edit Restaurant steak"]').click())
  const editForm = host.querySelector('form.nutrition-quick-add')
  expect(editForm).toBeTruthy()
  expect(field('Name', editForm).value).toBe('Restaurant steak')
  expect(field('Calories', editForm).value).toBe('450')
  expect(field('Protein', editForm).value).toBe('42')
  expect(field('Fiber', editForm).value).toBe('3')

  await type('Calories', '520', editForm)
  await click('Save', editForm)
  await wait(() => !host.querySelector('form.nutrition-quick-add') && host.textContent.includes('520'))
  const updated = (await ui.day('2026-10-10')).entries.find(e => e.snapshot.name === 'Restaurant steak')
  expect(updated.snapshot.nutrients.kcal).toBe(520)
})

test('habit ranking, last-used portion pre-fill, 1-tap + multi-select, and Save & add another work seamlessly', async () => {
  const oats = food({ id: 'oats', name: 'Oats' }) // 380 kcal / 100g
  const salmon = food({ id: 'salmon', name: 'Salmon', nutrients: { kcal: 208, protein: 20, carbs: 0, fat: 13, fiber: 0 } })
  const bowl = recipe({ id: 'bowl', name: 'Berry bowl' })

  await ui.batch([
    { collection: 'customFoods', id: oats.id, value: oats, base: null },
    { collection: 'customFoods', id: salmon.id, value: salmon, base: null },
    { collection: 'recipes', id: bowl.id, value: bowl, base: null },
    // Habit history: Oats logged twice for breakfast at 40 g; Salmon logged twice for dinner at 150 g
    { collection: 'foodEntries', id: 'h1', value: entry({ id: 'h1', d: '2026-10-08', meal: 'breakfast', snapshot: oats, quantity: { amount: 40, unit: 'g' } }), base: null },
    { collection: 'foodEntries', id: 'h2', value: entry({ id: 'h2', d: '2026-10-09', meal: 'breakfast', snapshot: oats, quantity: { amount: 40, unit: 'g' } }), base: null },
    { collection: 'foodEntries', id: 'h3', value: entry({ id: 'h3', d: '2026-10-08', meal: 'dinner', snapshot: salmon, quantity: { amount: 150, unit: 'g' } }), base: null },
    { collection: 'foodEntries', id: 'h4', value: entry({ id: 'h4', d: '2026-10-09', meal: 'dinner', snapshot: salmon, quantity: { amount: 150, unit: 'g' } }), base: null },
  ])

  await mountJournal({ date: '2026-10-10', initialMeal: 'breakfast' })
  await click('Add food')
  await wait(() => host.querySelectorAll('.nutrition-result').length === 3)

  const candidateNames = () => [...host.querySelectorAll('.nutrition-result strong')].map(el => el.textContent)
  // Breakfast ranks Oats first and displays pre-filled 40 g · 152 kcal
  await wait(() => candidateNames()[0] === 'Oats')
  expect(host.querySelector('.nutrition-result').textContent).toContain('40 g')
  expect(host.querySelector('.nutrition-result').textContent).toContain('152 kcal')

  // Switching meal pill to Dinner re-ranks Salmon first with 150 g
  const dinnerPill = host.querySelector('.nutrition-meal-pills button:nth-child(3)')
  await act(async () => dinnerPill.click())
  expect(field('Meal').value).toBe('dinner')
  expect(candidateNames()[0]).toBe('Salmon')
  expect(host.querySelector('.nutrition-result').textContent).toContain('150 g')

  // Switch back to Breakfast and 1-tap + quick log Oats + Berry bowl without closing picker
  const breakfastPill = host.querySelector('.nutrition-meal-pills button:nth-child(1)')
  await act(async () => breakfastPill.click())
  await act(async () => host.querySelector('[aria-label="Quick log Oats"]').click())
  await wait(() => host.querySelector('.nutrition-picker-session-bar')?.textContent.includes('1 added'))
  expect(host.querySelector('.nutrition-picker-session-bar').textContent).toContain('+152 kcal')
  expect(host.querySelector('.nutrition-picker-heading').textContent).toContain('Done (1)')

  // Clicking Oats main row opens EntryEditor pre-populated with 40 g, and Save & add another returns to picker
  await act(async () => host.querySelector('.nutrition-result').click())
  expect(field('Quantity').value).toBe('40')
  await type('Quantity', '50')
  await click('Save & add another')
  await wait(() => host.querySelector('.nutrition-picker'))
  expect(host.querySelector('.nutrition-picker-session-bar').textContent).toContain('2 added')
  expect(host.querySelector('.nutrition-picker-session-bar').textContent).toContain('+342 kcal')

  await click('Done', host.querySelector('.nutrition-picker-session-bar'))
  await wait(() => !host.querySelector('.nutrition-picker'))
  const logged = (await ui.day('2026-10-10')).entries
  expect(logged).toHaveLength(2)
  expect(logged.map(e => e.quantity.amount).sort((a, b) => a - b)).toEqual([40, 50])
})

test('isTrainingDay and launchAction ("add" and "scan") integrate cleanly with Journal', async () => {
  await ui.save('nutritionGoals', {
    schemaVersion: 1,
    id: 'g1',
    start: '2026-10-01',
    end: null,
    mode: 'custom',
    targets: { kcal: 2000, protein: 150, carbs: 200, fat: 65, fiber: 30 },
    trainingTargets: { kcal: 2500, carbs: 325 },
  })

  const { onClearLaunchAction, updateProps } = await mountJournal({
    date: '2026-10-10',
    initialMeal: 'dinner',
    isTrainingDay: true,
    launchAction: null,
  })
  expect(host.querySelector('.nutrition-day-badge').textContent).toBe('Training day')
  expect(host.querySelector('.nutrition-indicator-kcal').textContent).toContain('2,500 remaining')
  expect(host.querySelector('.nutrition-indicator-fiber').textContent).toContain('30 remaining')

  // Trigger launchAction = 'add'
  await updateProps({ launchAction: 'add' })
  await wait(() => host.querySelector('.nutrition-picker'))
  expect(onClearLaunchAction).toHaveBeenCalledTimes(1)
  expect(field('Meal').value).toBe('dinner')

  await click('Cancel')
  await wait(() => !host.querySelector('.nutrition-picker'))

  // Trigger launchAction = 'scan' (in happy-dom without camera API, opens picker and shows camera-unavailable alert)
  await updateProps({ launchAction: 'scan' })
  await wait(() => host.querySelector('.nutrition-picker') && host.querySelector('[role="alert"]'))
  expect(onClearLaunchAction).toHaveBeenCalledTimes(2)
  expect(host.textContent).toContain('Type the code instead')
})
