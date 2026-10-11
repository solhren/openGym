// @vitest-environment happy-dom
import React, { act, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { Blob as NodeBlob } from 'node:buffer'
import { afterEach, beforeEach, test, expect, vi } from 'vitest'
import { NutritionScreen, loadNutritionView } from './Nutrition.jsx'
import { backupFixture } from '../lib/nutrition/backup.test-util.js'
import { createNutritionUISession } from '../lib/nutrition/ui-session.js'
import { food, entry, recipe } from '../lib/nutrition/fixtures.test-util.js'
import { setLang } from '../lib/i18n.js'
import { saveNutritionBackup } from '../lib/nutrition/backup-file.js'
vi.mock('../lib/nutrition/backup-file.js', () => ({ saveNutritionBackup: vi.fn(async () => ({ status: 'download-requested' })) }))
globalThis.IS_REACT_ACT_ENVIRONMENT = true
let host, root, ui, originalBlob
beforeEach(async () => {
  originalBlob = globalThis.Blob; globalThis.Blob = NodeBlob
  await setLang('en', false); host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); vi.clearAllMocks()
})
afterEach(async () => { await act(async () => root.unmount()); ui?.close(); host.remove(); globalThis.Blob = originalBlob })
const buttons = () => [...host.querySelectorAll('button')]
const button = text => { const b = buttons().find(b => b.textContent.trim() === text); expect(b, text).toBeTruthy(); return b }
const click = async text => { await act(async () => button(text).click()) }
const field = label => { const found = [...host.querySelectorAll('label')].find(l => l.querySelector('span')?.textContent === label); expect(found, label).toBeTruthy(); return found.querySelector('input, select') }
const type = async (label, value) => {
  await act(async () => { const el = field(label); Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set.call(el, value); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })) })
}
const wait = async predicate => {
  const deadline = Date.now() + 4000
  while (!predicate()) { if (Date.now() > deadline) throw Error('UI did not settle: '+host.textContent); await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) }) }
}
async function mount(path = '/nutrition?date=2026-10-10', configure) {
  const f = await backupFixture(), session = f.session.value
  ui = createNutritionUISession({ store: f.store, session, getSession: () => f.session.value })
  if (configure) await configure(ui, f)
  await ui.inspect()
  function Harness() { const status = useSyncExternalStore(ui.subscribe, ui.getSnapshot); return <NutritionScreen service={ui} status={status} /> }
  await act(async () => root.render(<MemoryRouter initialEntries={[path]}><Harness /></MemoryRouter>))
  await wait(() => host.querySelector('.nutrition') && !host.textContent.includes('Loading…')); return f
}
async function save() { await act(async () => host.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); await wait(() => !host.querySelector('form') || !!host.querySelector('[role="alert"]')) }

const search = label => host.querySelector(`input[aria-label="${label}"]`)
async function searchFor(label, value) {
  const input = search(label); expect(input).toBeTruthy()
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value)
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: value || null, inputType: value ? 'insertText' : 'deleteContentBackward' }))
  })
  expect(search(label).value).toBe(value)
}
async function clearSearch(label) {
  const clear = search(label).closest('.searchf').querySelector('[aria-label="Clear"]')
  expect(clear).toBeTruthy(); await act(async () => clear.click())
  expect(search(label).value).toBe('')
  expect(search(label).closest('.searchf').querySelector('.clear')).toBeNull()
}

test('real Journal search handles input, accents, no matches and clearing before durably adding a food', async () => {
  await mount('/nutrition?date=2026-10-10', async ui => ui.batch([
    food({ id: 'apple', name: 'Pômme', brand: 'Orchard' }), food(), recipe(),
  ].map(value => ({ collection: value.ingredients ? 'recipes' : 'customFoods', id: value.id, value, base: null }))))
  await click('Add food'); await wait(() => host.querySelectorAll('.nutrition-result').length === 3)
  const results = () => [...host.querySelectorAll('.nutrition-result strong')].map(node => node.textContent)
  await searchFor('Search foods and recipes', '  pOMME  '); expect(results()).toEqual(['Pômme'])
  await searchFor('Search foods and recipes', 'orchard'); expect(results()).toEqual(['Pômme'])
  await searchFor('Search foods and recipes', 'not-a-food'); expect(results()).toEqual([])
  expect(host.textContent).toContain('No matching foods. Create a personal food to begin.')
  await clearSearch('Search foods and recipes'); expect(results()).toHaveLength(3)
  await searchFor('Search foods and recipes', 'OATS'); expect(results()).toEqual(['Oats'])
  await searchFor('Search foods and recipes', ''); expect(results()).toHaveLength(3)
  await searchFor('Search foods and recipes', 'porr'); expect(results()).toEqual(['Porridge'])
  await clearSearch('Search foods and recipes')
  await searchFor('Search foods and recipes', 'pomme')
  await act(async () => host.querySelector('.nutrition-result').click()); await type('Quantity', '50'); await save()
  await wait(() => !host.querySelector('form'))
  const saved = (await ui.day('2026-10-10')).entries
  expect(saved).toHaveLength(1); expect(saved[0].snapshot.name).toBe('Pômme'); expect(saved[0].quantity.amount).toBe(50)
  await wait(() => host.textContent.includes('190'))
  expect(host.textContent).toContain('190'); expect((await ui.store.read()).pendingOperations.length).toBeGreaterThan(0)
})

test.each(['foods', 'recipes'])('real %s library search filters and clears through the shared input contract', async kind => {
  await mount(`/nutrition?view=${kind}&date=2026-10-10`, async ui => ui.batch(
    (kind === 'foods' ? [food(), food({ id: 'apple', name: 'Pômme' })] : [recipe(), recipe({ id: 'apple-recipe', name: 'Pômme bowl' })])
      .map(value => ({ collection: kind === 'foods' ? 'customFoods' : 'recipes', id: value.id, value, base: null }))
  ))
  const names = () => [...host.querySelectorAll('section.card > h3')].map(node => node.textContent)
  expect(names()).toHaveLength(2)
  await searchFor('Search', '  POMME  '); expect(names()).toEqual([kind === 'foods' ? 'Pômme' : 'Pômme bowl'])
  await searchFor('Search', 'nothing-found'); expect(names()).toEqual([])
  await clearSearch('Search'); expect(names()).toHaveLength(2)
  await searchFor('Search', 'o'); expect(names()).toHaveLength(2)
  await searchFor('Search', ''); expect(names()).toHaveLength(2)
})

test('first opening is a real empty journal with four meals, no fabricated catalogue and local-only status', async () => {
  await mount(); expect(host.querySelectorAll('h2').length).toBeGreaterThan(3)
  expect(host.textContent).toContain('No goal defined'); expect(host.textContent).toContain('Nutrition is saved on this device only')
  await click('Add food'); expect(host.textContent).toContain('No matching foods. Create a personal food to begin.')
  expect(button('Create food')).toBeTruthy()
})
test('create food, log a portion, edit quantity, navigate/reload and delete through real storage', async () => {
  await mount('/nutrition?view=foods&date=2026-10-10'); await click('Create food')
  await type('Name', 'Oat bowl'); await type('Calories', '380'); await type('Protein', '13'); await type('Carbohydrates', '60'); await type('Fat', '7')
  await click('Add portion'); await type('Portion name', 'Scoop'); await type('Portion amount', '40'); await save()
  await wait(() => host.textContent.includes('Oat bowl') && !host.querySelector('form'))
  await click('Journal'); await wait(() => buttons().some(b => b.textContent.trim() === 'Add food')); await click('Add food')
  await act(async () => host.querySelector('.nutrition-result').click()); await type('Unit', 'portion:'+ (await ui.library()).domains[0].records.customFoods[0].portions[0].id)
  await type('Quantity', '1,5'); await save(); await wait(() => host.textContent.includes('228'))
  expect((await ui.day('2026-10-10')).entries[0].quantity.amount).toBe(1.5)
  await act(async () => host.querySelector('[aria-label="Edit Oat bowl"]').click()); await type('Quantity', '2'); await save(); await wait(() => host.textContent.includes('304'))
  await click('Next'); await wait(() => host.textContent.includes('No food logged in this meal')); await click('Prev'); await wait(() => host.textContent.includes('304'))
  const row = (await ui.day('2026-10-10')).entries[0]
  await act(async () => host.querySelector('[aria-label="Delete Oat bowl"]').click()); await click('Delete'); await wait(() => !host.textContent.includes('Oat bowl'))
  expect((await ui.day(row.d)).entries).toEqual([]); expect(ui.getSnapshot().pending).toBe(1)
})
test('recipe creation/calculation and ingredient edit persist; journal snapshots survive later changes', async () => {
  await mount('/nutrition?view=recipes&date=2026-10-10', async ui => ui.save('customFoods', food()))
  await click('Create recipe'); await type('Name', 'Breakfast recipe'); await click('Add ingredient'); await type('Servings', '2')
  expect(host.textContent).toContain('Recipe total'); expect(host.textContent).toContain('190')
  await save(); await wait(() => buttons().some(b => b.textContent.trim() === 'Add to journal')); await click('Add to journal'); await save()
  await wait(() => buttons().some(b => b.textContent.trim() === 'Edit')); const before = (await ui.day('2026-10-10')).entries[0].snapshot
  await click('Edit'); await type('Quantity', '200'); await save(); await wait(() => !host.querySelector('form'))
  expect((await ui.library()).domains.flatMap(p => p.records.recipes ?? [])[0].ingredients[0].quantity.amount).toBe(200)
  expect((await ui.day('2026-10-10')).entries[0].snapshot).toEqual(before)
})
test('goals update daily engine indicators and history includes date navigation', async () => {
  await mount('/nutrition?view=goals&date=2026-10-10', async ui => ui.save('foodEntries', entry()))
  await click('Create nutrition goal'); await type('Calories', '100'); await type('Protein', '0'); await save(); await wait(() => !host.querySelector('form'))
  await click('Journal'); await wait(() => host.textContent.includes('90 over goal')); expect(host.textContent).toContain('6.5 over goal')
  await click('History'); await wait(() => host.textContent.includes('Average on recorded days')); expect(host.textContent).toContain('190')
  expect(host.querySelectorAll('.nutrition-list > li')).toHaveLength(7)
})
test('history uses the same goal feedback when switching between defined, zero and absent nutrient targets', async () => {
  await mount('/nutrition?view=history&date=2026-10-10', async ui => ui.batch([
    { collection: 'foodEntries', id: entry().id, value: entry(), base: null },
    { collection: 'nutritionGoals', id: 'goal', value: { schemaVersion: 1, id: 'goal', start: '2026-10-10', end: null, mode: 'custom', targets: { kcal: 100, protein: 0 } }, base: null },
  ]))
  await wait(() => host.textContent.includes('Average on recorded days'))
  const latest = () => [...host.querySelectorAll('.nutrition-list > li')].at(-1)
  expect(latest().querySelector('.nutrition-goal-over').textContent).toBe('90 over goal')
  await type('Nutrient', 'protein')
  expect(latest().textContent).toContain('Goal: 0')
  expect(latest().querySelector('.nutrition-goal-over').textContent).toBe('6.5 over goal')
  for (const nutrient of ['carbs', 'fat']) {
    await type('Nutrient', nutrient)
    expect([...latest().querySelectorAll('p')].map(p => p.textContent)).toEqual(['No goal defined'])
    expect(latest().querySelector('.nutrition-goal-over')).toBeNull()
  }
})
test('invalid numbers never save; labels are associated, inline editor takes focus and Escape cancels', async () => {
  await mount('/nutrition?view=foods&date=2026-10-10'); await click('Create food')
  expect(document.activeElement).toBe(field('Name'))
  await type('Name', 'Food'); await type('Calories', '-20'); await save(); expect(host.querySelector('[role="alert"]')).toBeTruthy()
  expect((await ui.library()).domains).toEqual([])
  await act(async () => field('Name').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(host.querySelector('form')).toBeNull()
})
test('double submit creates exactly one durable entry and unmount does not clear the queue', async () => {
  await mount('/nutrition?date=2026-10-10', async ui => ui.save('customFoods', food())); await click('Add food'); await act(async () => host.querySelector('.nutrition-result').click())
  await act(async () => { const form = host.querySelector('form'); form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
  await wait(() => !host.querySelector('form')); expect((await ui.day('2026-10-10')).entries).toHaveLength(1)
  await act(async () => root.unmount()); root = createRoot(host); expect((await ui.store.read()).pendingOperations).toHaveLength(1)
})
test('backup UI exports, rejects malformed data, previews and explicitly restores Nutrition', async () => {
  const f = await mount('/nutrition?view=backup&date=2026-10-10', async ui => ui.save('foodEntries', entry()))
  await click('Export Nutrition'); await wait(() => saveNutritionBackup.mock.calls.length > 0); expect(host.textContent).toContain('Download requested')
  const exported = await ui.export(), input = field('Backup file')
  await act(async () => { Object.defineProperty(input, 'files', { configurable: true, value: [new NodeBlob(['{'])] }); input.dispatchEvent(new Event('change', { bubbles: true })) })
  await click('Verify and preview'); await wait(() => !!host.querySelector('[role="alert"]')); expect((await ui.day(entry().d)).entries).toHaveLength(1)
  await act(async () => { Object.defineProperty(input, 'files', { configurable: true, value: [exported.blob] }); input.dispatchEvent(new Event('change', { bubbles: true })) })
  await click('Verify and preview'); await wait(() => host.textContent.includes('Backup preview')); expect(button('Confirm Nutrition restoration').disabled).toBe(false)
  await click('Confirm Nutrition restoration'); await wait(() => host.textContent.includes('Nutrition restored locally'))
  expect((await f.store.read()).pendingOperations.length).toBeGreaterThan(0)
  expect(host.textContent).toContain('Global restoration is unavailable')
})
test('replacement is blocked without explicit intent and read errors expose a retry', async () => {
  await mount('/nutrition?view=backup&date=2026-10-10'); await type('Restore mode', 'replace'); expect(button('Verify and preview').disabled).toBe(true)
  await click('Journal'); ui.day = async () => { throw Error('disk read failure') }
  await click('Next'); await wait(() => !!host.querySelector('[role="alert"]')); expect(button('Reload')).toBeTruthy()
})
test('stable view capture retries a concurrent publication instead of mixing goals and daily entries', async () => {
  const fake = { library: vi.fn().mockResolvedValueOnce({ head: { n: 1 }, domains: [] }).mockResolvedValue({ head: { n: 2 }, domains: [] }), day: vi.fn(async () => ({ head: { n: 2 }, entries: [entry()], status: 'partially-verified' })) }
  expect((await loadNutritionView(fake, entry().d, true)).entries).toHaveLength(1); expect(fake.library).toHaveBeenCalledTimes(2)
})
test('French forms and decimal display use the existing locale system', async () => {
  await mount('/nutrition?date=2026-10-10', async ui => ui.save('foodEntries', entry()))
  await act(async () => setLang('fr', false)); expect(host.textContent).toContain('Protéines'); expect(host.textContent).toContain('6,5')
})
test('recipe drafts do not erase unknown ingredient metadata and names remain escaped text', async () => {
  const record = recipe({ name: '<img src=x onerror=alert(1)>' })
  record.ingredients[0].amount = 'future metadata'; record.ingredients[0].option = 'another metadata'; record.ingredients[0].quantity.extra = 'retain'
  await mount('/nutrition?view=recipes&date=2026-10-10', async ui => ui.save('recipes', record))
  expect(host.querySelector('img')).toBeNull(); expect(host.textContent).toContain(record.name)
  await click('Edit'); await type('Name', 'Edited'); await save(); await wait(() => !host.querySelector('form'))
  const saved = (await ui.library()).domains.flatMap(p => p.records.recipes ?? [])[0]
  expect(saved.ingredients[0].amount).toBe('future metadata'); expect(saved.ingredients[0].option).toBe('another metadata'); expect(saved.ingredients[0].quantity.extra).toBe('retain')
})
test('editing a food retains future metadata on its default logging quantity', async () => {
  const record = food({ defaultQuantity: { amount: 50, unit: 'g', future: 'retain' } })
  await mount('/nutrition?view=foods&date=2026-10-10', async ui => ui.save('customFoods', record))
  await click('Edit'); await type('Name', 'Edited food'); await save(); await wait(() => !host.querySelector('form'))
  const saved = (await ui.library()).domains.flatMap(p => p.records.customFoods ?? [])[0]
  expect(saved.defaultQuantity).toEqual(record.defaultQuantity)
})
test('the earliest supported day has a bounded seven-day history and can navigate forward', async () => {
  await mount('/nutrition?view=history&date=0001-01-01')
  await wait(() => host.textContent.includes('Average on recorded days'))
  expect(host.querySelectorAll('.nutrition-list > li')).toHaveLength(1)
  expect(host.querySelector('[aria-label="Previous day"]').disabled).toBe(true)
  expect(host.querySelector('[aria-label="Next day"]').disabled).toBe(false)
})
test('removing the default portion requires an explicit compatible unit instead of a misleading select value', async () => {
  const record = food({ defaultQuantity: { amount: 2, unit: 'portion', portionId: 'scoop' } })
  await mount('/nutrition?view=foods&date=2026-10-10', async ui => ui.save('customFoods', record))
  await click('Edit'); await click('Remove portion')
  expect(field('Unit').selectedOptions[0].textContent).toBe('Choose a compatible unit')
  await save(); expect(host.querySelector('[role="alert"]')).toBeTruthy()
  expect((await ui.library()).domains.flatMap(p => p.records.customFoods ?? [])[0]).toEqual(record)
  await type('Unit', 'g'); await type('Quantity', '80'); await save(); await wait(() => !host.querySelector('form'))
  expect((await ui.library()).domains.flatMap(p => p.records.customFoods ?? [])[0].defaultQuantity).toEqual({ amount: 80, unit: 'g' })
})
test('backup remains accessible without a successful library read; its own full validator controls export', async () => {
  const failingLibrary = vi.fn(async () => { throw Error('library unavailable') })
  await mount('/nutrition?view=backup&date=2026-10-10', async ui => { await ui.save('foodEntries', entry()); ui.library = failingLibrary })
  expect(failingLibrary).not.toHaveBeenCalled()
  await click('Export Nutrition'); await wait(() => saveNutritionBackup.mock.calls.length > 0)
  expect(host.textContent).toContain('Download requested')
})
test('chart day labels remain aligned with calendar ids in UTC+14', async () => {
  const previous = process.env.TZ
  process.env.TZ = 'Pacific/Kiritimati'
  try {
    await mount('/nutrition?view=history&date=2026-10-10', async ui => {
      await ui.batch([entry({ id: 'nine', d: '2026-10-09' }), entry()].map(value => ({ collection: 'foodEntries', id: value.id, value, base: null })))
    })
    await wait(() => host.textContent.includes('Average on recorded days'))
    const ticks = [...host.querySelectorAll('svg text')].map(node => node.textContent)
    expect(ticks).toContain('9 Oct'); expect(ticks).toContain('10 Oct'); expect(ticks).not.toContain('11 Oct')
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous }
})
test('retrying an archive copy after a lost local response does not duplicate a durable entry', async () => {
  await mount('/nutrition?view=conflicts&date=2026-10-10', async ui => {
    ui.conflicts = async () => [{ hash: 'a'.repeat(64), collection: 'foodEntries', record: entry() }]
    const save = ui.save; let lost = true
    ui.save = async (...args) => { const result = await save(...args); if (lost) { lost = false; throw Error('lost local response') } return result }
  })
  await wait(() => buttons().some(b => b.textContent.trim() === 'Import as a separate copy'))
  await click('Import as a separate copy'); await wait(() => !!host.querySelector('[role="alert"]'))
  await click('Import as a separate copy'); await wait(() => host.textContent.includes('A separate copy was saved locally.'))
  expect((await ui.day('2026-10-10')).entries).toHaveLength(1)
})
test('decimal-comma density enables the same compatible logging units as the domain parser', async () => {
  await mount('/nutrition?view=foods&date=2026-10-10', async ui => ui.save('customFoods', food({ portions: [], defaultQuantity: { amount: 100, unit: 'g' } })))
  await click('Edit'); await type('Density (g/ml, optional)', '1,1')
  expect([...field('Unit').options].map(option => option.value)).toContain('ml')
  await type('Unit', 'ml'); await type('Quantity', '10'); await save(); await wait(() => !host.querySelector('form'))
  const saved = (await ui.library()).domains.flatMap(p => p.records.customFoods ?? [])[0]
  expect(saved.densityGPerMl).toBe(1.1); expect(saved.defaultQuantity).toEqual({ amount: 10, unit: 'ml' })
})
