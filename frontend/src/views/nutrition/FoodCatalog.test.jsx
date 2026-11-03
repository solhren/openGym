// @vitest-environment happy-dom
import React, { act, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, afterEach, test, expect, vi } from 'vitest'
import { NutritionScreen } from '../Nutrition.jsx'
import { createNutritionUISession } from '../../lib/nutrition/ui-session.js'
import { backupFixture } from '../../lib/nutrition/backup.test-util.js'
import { offProduct, response } from '../../lib/nutrition/catalog/fixtures.test-util.js'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setLang } from '../../lib/i18n.js'
import { localCapabilities, localBody, localSearchBody, localRecord } from '../../lib/nutrition/catalog/local-fixtures.test-util.js'
import { FoodSource } from './common.jsx'
import { validateFood } from '../../lib/nutrition/validate.js'
import { referenceFixture } from '../../../../scripts/nutrition-local-catalog/off-integration-fixtures.mjs'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let host, root, service, fixture, transport, limits
beforeEach(async () => {
  await setLang('en', false); host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  fixture = await backupFixture(); limits = { reserve: vi.fn(async () => {}), block: vi.fn() }
  transport = vi.fn(async url => new URL(url).pathname.includes('/product/') ? response({ status: 'success', product: offProduct() }) : response({ count: 1, products: [offProduct()] }))
  service = createNutritionUISession({ store: fixture.store, session: fixture.session.value, getSession: () => fixture.session.value, online: () => false, catalogTransport: (...args) => transport(...args), catalogLimiter: limits })
})
afterEach(async () => { await act(async () => root.unmount()); service.close(); host.remove(); vi.unstubAllGlobals() })
const wait = async predicate => { const end = Date.now() + 6000; while (!predicate()) { if (Date.now() > end) throw Error(host.textContent); await act(async () => { await new Promise(r => setTimeout(r, 10)) }) } }
const button = label => { const found = [...host.querySelectorAll('button')].find(b => b.textContent.trim() === label); expect(found, label).toBeTruthy(); return found }
const click = async label => { await act(async () => button(label).click()) }
async function type(el, value) {
  expect(el).toBeTruthy(); await act(async () => { Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set.call(el, value); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })) })
}
const field = label => [...host.querySelectorAll('label')].find(l => l.querySelector('span')?.textContent === label)?.querySelector('input,select')
async function mount() {
  function Harness() { const status = useSyncExternalStore(service.subscribe, service.getSnapshot); return <NutritionScreen service={service} status={status} /> }
  await act(async () => root.render(<MemoryRouter initialEntries={['/nutrition?date=2026-10-10']}><Harness /></MemoryRouter>)); await wait(() => host.textContent.includes('Add food'))
}
async function search() {
  await click('Add food'); await type(field('Meal'), 'lunch'); await click('Open Food Facts')
  await type(host.querySelector('input[aria-label="Search Open Food Facts"]'), 'pâte Example'); expect(transport).toHaveBeenCalledTimes(0)
  await click('Search'); await wait(() => host.querySelector('.nutrition-result')); await act(async () => host.querySelector('.nutrition-result').click())
}
async function save() { await act(async () => host.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); await wait(() => !host.querySelector('.nutrition-editor') || host.querySelector('[role="alert"]')) }

test('real journal external search -> detail -> quantity -> durable atomic food/intake; double submit once; local reuse', async () => {
  await mount(); await search(); expect(host.textContent).toContain('Source: Open Food Facts contributors'); await click('Choose quantity')
  expect(field('Meal').value).toBe('lunch'); await type(field('Quantity'), '50')
  await act(async () => { const form = host.querySelector('form'); form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
  await wait(() => !host.querySelector('.nutrition-editor') || !!host.querySelector('.nutrition-editor [role="alert"]')); expect(service.getSnapshot().error).toBeNull(); const saved = await service.day('2026-10-10'), library = await service.library()
  expect(saved.entries).toHaveLength(1); expect(saved.entries[0]).toMatchObject({ meal: 'lunch', quantity: { amount: 50, unit: 'g' } })
  expect(library.domains.flatMap(p => p.records.savedFoods ?? [])).toHaveLength(1); expect(library.domains.flatMap(p => p.records.customFoods ?? [])).toHaveLength(0)
  expect(host.textContent).toContain('269.5'); expect(service.getSnapshot().pending).toBeGreaterThan(0); expect(host.textContent).not.toContain('Nutrition synchronized')
  await click('Add food'); await click('Local foods and recipes'); await wait(() => host.querySelector('.nutrition-result')); await act(async () => host.querySelector('.nutrition-result').click()); await save(); expect((await service.day('2026-10-10')).entries).toHaveLength(2); expect(transport).toHaveBeenCalledTimes(1)
})

test('V1 local-only combobox -> UUID -> durable journal -> edit -> reopen -> delete; no provider needed',async()=>{
  service.close();await fixture.reopen()
  const local=vi.fn(async path=>response(path.includes('/search?')?localSearchBody():localBody({product:localRecord()})))
  const make=()=>createNutritionUISession({store:fixture.store,session:fixture.session.value,getSession:()=>fixture.session.value,online:()=>false,
    catalogLocalOnly:true,catalogTransport:transport,catalogLocalTransport:local,catalogCapabilitiesTransport:async()=>response(localCapabilities)})
  service=make();await mount();await click('Add food');await type(field('Meal'),'lunch')
  await wait(()=>host.querySelector('[role="combobox"]'));expect(host.querySelector('.nutrition-summary')).toBeNull()
  expect(host.querySelector('[aria-label="Food catalogue"]')).toBe(document.activeElement)
  expect(local).not.toHaveBeenCalled();expect(transport).not.toHaveBeenCalled()
  const input=host.querySelector('[role="combobox"]');await act(async()=>input.focus());await type(input,'riz');await wait(()=>host.querySelector('[role="option"]'))
  await key(input,'ArrowDown');await key(input,'Enter');await wait(()=>host.querySelector('.nutrition-product'))
  expect(host.textContent).toContain('Riz cru');expect(host.textContent).toContain('USDA');await click('Choose quantity');await type(field('Quantity'),'50');await save()
  const first=(await service.day('2026-10-10')).entries[0];expect(first.quantity).toEqual({amount:50,unit:'g'});expect(first.snapshot.name).toBe('Rice, raw');expect(first.snapshot.source.publicCatalogImport.provider).toBe('wger')
  expect((await service.library()).domains.flatMap(p=>p.records.savedFoods??[])).toHaveLength(1)
  await act(async()=>host.querySelector('[aria-label="Edit Rice, raw"]').click());await type(field('Quantity'),'75');await save()
  expect((await service.day('2026-10-10')).entries[0].quantity.amount).toBe(75)
  await act(async()=>root.unmount());service.close();await fixture.reopen();service=make();root=createRoot(host);await mount()
  expect((await service.day('2026-10-10')).entries[0].snapshot).toEqual(first.snapshot)
  await act(async()=>host.querySelector('[aria-label="Delete Rice, raw"]').click());await click('Delete');await wait(()=>!service.getSnapshot().busy && !host.querySelector('[aria-label="Edit Rice, raw"]'))
  expect((await service.day('2026-10-10')).entries).toHaveLength(0);expect(service.getSnapshot().pending).toBeGreaterThan(0)
  await click('Add food');await click('Local foods and recipes');await wait(()=>host.querySelector('.nutrition-result'));await act(async()=>host.querySelector('.nutrition-result').click());await save()
  expect((await service.day('2026-10-10')).entries[0].snapshot).toEqual(first.snapshot);expect(transport).not.toHaveBeenCalled();expect(local).toHaveBeenCalledTimes(2)
},10000)

for(const kind of ['spread','drink'])test(`certified OFF ${kind}: real React search, quantity, edit, file reopen, deletion and offline reuse`,async()=>{
  const {record}=await referenceFixture(kind),food=record.food;service.close();fixture=await backupFixture('fs')
  let apiAvailable=true
  const local=vi.fn(async path=>{if(!apiAvailable)throw Error('backend offline');return response(localBody(path.includes('/search?')?{products:[record],count:1,page:1,pageSize:20,literalOnly:true,registryVerified:true,catalogueVersion:'b'.repeat(64)}:{product:record}))})
  const make=()=>createNutritionUISession({store:fixture.store,session:fixture.session.value,getSession:()=>fixture.session.value,online:()=>false,
    catalogLocalOnly:true,catalogTransport:transport,catalogLocalTransport:local,catalogCapabilitiesTransport:async()=>response(localCapabilities)})
  service=make();await mount();await click('Add food');await type(field('Meal'),'dinner');await click('Food catalogue')
  const input=host.querySelector('[role="combobox"]');await act(async()=>input.focus());await type(input,record.name);await wait(()=>host.querySelector('[role="option"]'))
  await key(input,'ArrowDown');await key(input,'Enter');await wait(()=>host.querySelector('.nutrition-product'))
  expect(host.textContent).toContain(`100 ${food.reference.unit}`);expect(host.textContent).toContain('Source: Open Food Facts contributors');await click('Choose quantity')
  expect(field('Unit').value).toBe(food.reference.unit);expect([...field('Unit').options].some(o=>o.value===(food.reference.unit==='ml'?'g':'ml'))).toBe(false)
  await type(field('Quantity'),'50');await save();expect(service.getSnapshot().error).toBeNull()
  const first=(await service.day('2026-10-10')).entries[0];expect(first.snapshot).toEqual(food);expect(first.quantity).toEqual({amount:50,unit:food.reference.unit});expect(first.meal).toBe('dinner')
  await wait(()=>host.querySelector(`[aria-label="Edit ${food.name}"]`))
  await act(async()=>host.querySelector(`[aria-label="Edit ${food.name}"]`).click());await type(field('Quantity'),'75');await save()
  expect((await service.day('2026-10-10')).entries[0].quantity.amount).toBe(75)
  await act(async()=>root.unmount());service.close();apiAvailable=false;await fixture.reopen();service=make();await service.refresh();root=createRoot(host);await mount()
  expect((await service.day('2026-10-10')).entries[0].snapshot).toEqual(food);expect(service.getSnapshot().pending).toBeGreaterThan(0)
  await wait(()=>host.querySelector(`[aria-label="Delete ${food.name}"]`))
  await act(async()=>host.querySelector(`[aria-label="Delete ${food.name}"]`).click());await click('Delete');await wait(()=>!service.getSnapshot().busy&&!host.querySelector(`[aria-label="Edit ${food.name}"]`))
  expect((await service.day('2026-10-10')).entries).toHaveLength(0)
  await click('Add food');await click('Local foods and recipes');await wait(()=>host.querySelector('.nutrition-result'));await act(async()=>host.querySelector('.nutrition-result').click());await save()
  expect((await service.day('2026-10-10')).entries[0].snapshot).toEqual(food);expect(transport).not.toHaveBeenCalled();expect(local).toHaveBeenCalledTimes(2)
},15000)

test('local exact review-only result stays visible and cannot enable quantity or journal writes',async()=>{
  service.close();await fixture.reopen();const row={...localRecord(),food:null,reference:null,validationStatus:'needs-verification'}
  service=createNutritionUISession({store:fixture.store,session:fixture.session.value,getSession:()=>fixture.session.value,online:()=>false,catalogLocalOnly:true,catalogTransport:transport,
    catalogCapabilitiesTransport:async()=>response(localCapabilities),catalogLocalTransport:async path=>response(localBody(path.includes('/search?')?{products:[row],count:1,page:1,pageSize:20,literalOnly:true,registryVerified:true,catalogueVersion:'a'.repeat(64)}:{product:row}))})
  await mount();await click('Add food');await click('Food catalogue');const input=host.querySelector('[role="combobox"]');await act(async()=>input.focus());await type(input,'riz')
  await wait(()=>host.querySelector('[role="option"]'));expect(host.querySelector('[role="option"]').textContent).toContain('cannot be added')
  await key(input,'ArrowDown');await key(input,'Enter');await wait(()=>host.querySelector('.nutrition-product'));expect(host.textContent).toContain('cannot be added')
  expect([...host.querySelectorAll('button')].some(b=>b.textContent==='Choose quantity')).toBe(false);expect((await service.day('2026-10-10')).entries).toHaveLength(0);expect(transport).not.toHaveBeenCalled()
})

test('restored JSON catalogue metadata is text-only in source credits and cannot crash React',async()=>{
  const food=localRecord().food
  food.source.publicCatalogImport.sourceName={unexpected:'metadata object'}
  food.source.publicCatalogImport.licenseMetadata.title={unexpected:'title object'}
  food.source.publicCatalogImport.licenseMetadata.authorUrl='javascript:alert(1)'
  expect(validateFood(food)).toEqual([])
  await act(async()=>root.render(<FoodSource food={food} />))
  expect(host.textContent).toContain('wger');expect(host.textContent).toContain('CC0-1.0')
  expect([...host.querySelectorAll('a')].every(a=>a.href.startsWith('https://creativecommons.org/'))).toBe(true)
})
test('V1 recovers from a failed initial capability probe on explicit retry without provider fallback',async()=>{
  service.close();await fixture.reopen()
  const capability=vi.fn().mockResolvedValueOnce(response({},503)).mockResolvedValueOnce(response({},503)).mockImplementation(async()=>response(localCapabilities))
  const local=vi.fn(async()=>response(localSearchBody()))
  service=createNutritionUISession({store:fixture.store,session:fixture.session.value,getSession:()=>fixture.session.value,online:()=>false,
    catalogLocalOnly:true,catalogTransport:transport,catalogLocalTransport:local,catalogCapabilitiesTransport:capability})
  await mount();await click('Add food');await click('Food catalogue');const input=host.querySelector('[role="combobox"]');await act(async()=>input.focus());await type(input,'riz')
  await wait(()=>host.querySelector('[role="alert"]'));expect(local).not.toHaveBeenCalled();expect(service.catalog.localReady).toBe(false)
  await click('Search');await wait(()=>host.querySelector('[role="option"]'));expect(service.catalog.localReady).toBe(true)
  expect(capability).toHaveBeenCalledTimes(3);expect(local).toHaveBeenCalledTimes(1);expect(transport).not.toHaveBeenCalled()
})
test('manual barcode preserves zeros; not found and malformed are explicit without storage mutation', async () => {
  await mount(); await click('Add food'); await click('Open Food Facts'); await click('Barcode')
  transport.mockImplementation(async () => response({}, 404)); await type(host.querySelector('input[aria-label="Product barcode"]'), '0034000470693'); await click('Search'); await wait(() => host.querySelector('[role="alert"]'))
  expect(host.textContent).toContain('not listed'); expect(new URL(transport.mock.calls[0][0]).pathname).toContain('0034000470693'); expect((await service.day('2026-10-10')).entries).toHaveLength(0)
  await type(host.querySelector('input[aria-label="Product barcode"]'), 'bad'); await click('Search'); await wait(() => host.textContent.includes('8, 12, 13')); expect(transport).toHaveBeenCalledTimes(1)
})
test('clear does not accidentally submit and invalid product cannot be chosen', async () => {
  await mount(); await click('Add food'); await click('Open Food Facts'); await type(host.querySelector('input[aria-label="Search Open Food Facts"]'), 'pâte')
  await act(async () => host.querySelector('.searchf .clear').click()); expect(transport).toHaveBeenCalledTimes(0); expect(host.querySelector('.searchf input').value).toBe('')
  transport.mockImplementation(async () => response({ count: 1, products: [offProduct({ nutriments: {}, serving_size: 'Unknown', serving_quantity: null })] }))
  await type(host.querySelector('.searchf input'), 'pâte'); await click('Search'); await wait(() => host.querySelector('.nutrition-result')); await act(async () => host.querySelector('.nutrition-result').click())
  expect(host.textContent).toContain('cannot be added'); expect([...host.querySelectorAll('button')].some(b => b.textContent === 'Choose quantity')).toBe(false)
})
test('late request after changing text or date cannot replace current view', async () => {
  let resolve; transport.mockImplementation(() => new Promise(r => { resolve = r }))
  await mount(); await click('Add food'); await click('Open Food Facts'); await type(host.querySelector('.searchf input'), 'pâte'); await click('Search')
  await type(host.querySelector('.searchf input'), 'other'); await act(async () => resolve(response({ count: 1, products: [offProduct()] })))
  expect(host.querySelector('.nutrition-result')).toBeNull(); expect(host.querySelector('.searchf input').value).toBe('other')
  transport.mockImplementation(() => new Promise(r => { resolve = r })); await click('Search'); await act(async () => host.querySelector('[aria-label="Next day"]').click()); await act(async () => resolve(response({ count: 1, products: [offProduct()] })))
  expect(host.querySelector('.nutrition-catalog')).toBeNull(); expect(host.textContent).not.toContain('Pâte à tartiner')
})
test('network/rate errors preserve local data; camera unsupported never requests permission', async () => {
  await mount(); await click('Add food'); await click('Open Food Facts'); await click('Scan product barcode'); await wait(() => host.querySelector('[role="alert"]')); expect(host.textContent).toContain('Type the code instead')
  transport.mockRejectedValueOnce(new Error('offline')); await type(host.querySelector('.searchf input'), 'pâte'); await click('Search'); await wait(() => host.textContent.includes('catalogue is unavailable'))
  transport.mockImplementation(async () => response({}, 429, { 'retry-after': '60' })); await type(host.querySelector('.searchf input'), 'pâte again'); await click('Search'); await wait(() => host.textContent.includes('limit was reached'))
  expect(limits.block).toHaveBeenCalledWith(60); expect((await service.day('2026-10-10')).entries).toHaveLength(0)
})
test('account change during provider request cannot leak result or write old account', async () => {
  let resolve; transport.mockImplementation(() => new Promise(r => { resolve = r })); await mount(); await click('Add food'); await click('Open Food Facts'); await type(host.querySelector('.searchf input'), 'pâte'); await click('Search')
  fixture.session.value = { ...fixture.session.value, epoch: 2 }; await act(async () => resolve(response({ count: 1, products: [offProduct()] })))
  expect(host.querySelector('.nutrition-result')).toBeNull(); await expect(service.day('2026-10-10')).rejects.toThrow()
})
test('used products appear in library and ingredient choices while personal foods remain separate', async () => {
  await mount(); await search(); await click('Choose quantity'); await save(); expect(service.getSnapshot().error).toBeNull(); await click('Personal foods'); await wait(() => host.textContent.includes('Previously used products'))
  expect(host.textContent).toContain('Hazelnut spread'); expect(host.textContent).toContain('No personal foods yet'); expect(transport).toHaveBeenCalledTimes(1)
})

test('bounded twenty-result React search opens and renders without durable reads per keystroke', async () => {
  await mount(); const start = performance.now(); await click('Add food'); await click('Open Food Facts'); const opened = performance.now() - start
  transport.mockImplementation(async () => response({ count: 20, products: Array.from({ length: 20 }, (_, i) => offProduct({ code: `301762042${String(i).padStart(4, '0')}` })) }))
  await type(host.querySelector('.searchf input'), 'pâte'); expect(transport).toHaveBeenCalledTimes(0)
  const renderStart = performance.now(); await click('Search'); await wait(() => host.querySelectorAll('.nutrition-result').length === 20)
  // Numeric measurements only, in the OS temporary directory; no real account data.
  await writeFile(join(tmpdir(), 'opengym-catalog-component-benchmark.json'), JSON.stringify({ environment: 'happy-dom React commit, not browser paint', openedMs: +(opened).toFixed(2), searchThroughCommitMs: +(performance.now() - renderStart).toFixed(2), results: 20, requests: transport.mock.calls.length }))
  expect((await service.day('2026-10-10')).entries).toHaveLength(0)
})

test('OFF attribution follows ingredients into recipe library and immutable logged recipe snapshots', async () => {
  const { normalizeProduct } = await import('../../lib/nutrition/catalog/normalize.js'), food = (await normalizeProduct(offProduct())).food
  await service.save('recipes', { schemaVersion: 1, id: 'off-recipe', name: 'Spread recipe', ingredients: [{ id: 'spread', food, quantity: { amount: 100, unit: 'g' } }], yield: { servings: 2 } })
  await mount(); await click('Recipes'); await wait(() => host.textContent.includes('Spread recipe'))
  expect(host.textContent).toContain('Source: Open Food Facts contributors'); await click('Add to journal'); expect(host.textContent).toContain('Source: Open Food Facts contributors')
  await save(); await click('Journal'); await wait(() => host.textContent.includes('Spread recipe'))
  expect(host.textContent).toContain('Source: Open Food Facts contributors'); expect((await service.day('2026-10-10')).entries[0].snapshot.ingredientSources[0].source.license.id).toBe('ODbL-1.0')
})

test('restored provider provenance remains visible but arbitrary source URLs cannot become links', async () => {
  const { normalizeProduct } = await import('../../lib/nutrition/catalog/normalize.js'), food = (await normalizeProduct(offProduct())).food
  await service.save('savedFoods', { ...food, name: '<img src=x onerror=alert(1)>', source: { ...food.source, url: 'https://attacker.example/collect' } })
  await mount(); await click('Personal foods'); await wait(() => host.textContent.includes('Previously used products'))
  expect(host.textContent).toContain('Source: Open Food Facts contributors'); expect(host.querySelector('a[href*="attacker.example"]')).toBeNull(); expect(host.textContent).toContain('<img src=x onerror=alert(1)>'); expect(host.querySelector('img')).toBeNull()
})

test('guest real Nutrition component uses web relay for nutella and persists product/intake without forwarding credentials', async () => {
  const { createCatalogRelay } = await import('../../../../api/nutrition/food-catalog.js')
  const provider = vi.fn(async () => new Response(JSON.stringify({ count: 1, products: [offProduct({ product_name: 'Nutella', product_name_fr: 'Nutella', product_name_en: 'Nutella' })] })))
  const relay = createCatalogRelay({ fetcher: provider })
  const web = vi.fn(async (url, options) => {
    if (url === '/api/nutrition/catalog/capabilities') return new Response(JSON.stringify({schemaVersion:1,textSearch:'explicit-remote'}))
    expect(url.startsWith('/api/nutrition/catalog/search?')).toBe(true); expect(options.credentials).toBe('omit'); expect(options.headers.Authorization).toBeUndefined()
    const result = await relay.read('search', url)
    return new Response(JSON.stringify(result.body), { status: result.status })
  })
  vi.stubGlobal('fetch', web); service.close(); fixture = await backupFixture()
  service = createNutritionUISession({ store: fixture.store, session: fixture.session.value, getSession: () => fixture.session.value, online: () => false, catalogLimiter: limits })
  await mount(); await click('Add food'); await type(field('Meal'), 'lunch'); await click('Open Food Facts'); await type(host.querySelector('.searchf input'), 'nutella'); await click('Search')
  await wait(() => host.querySelector('.nutrition-result')); await act(async () => host.querySelector('.nutrition-result').click()); await click('Choose quantity'); await type(field('Quantity'), '50'); await save()
  expect(service.getSnapshot().error).toBeNull(); const day = await service.day('2026-10-10'), library = await service.library()
  expect(day.entries).toHaveLength(1); expect(library.domains.flatMap(p => p.records.savedFoods ?? [])).toHaveLength(1); expect(library.domains.flatMap(p => p.records.customFoods ?? [])).toHaveLength(0)
  expect(day.entries[0].snapshot.name).toBe('Nutella'); expect(web).toHaveBeenCalledTimes(2); expect(provider).toHaveBeenCalledTimes(1)
  expect(provider.mock.calls[0][1].headers['User-Agent']).toContain('openGym/'); expect(new URL(provider.mock.calls[0][0]).searchParams.has('User-Agent')).toBe(false)
})

test('provider 503 reports unavailability and a protective delay without claiming exhausted quota', async () => {
  transport.mockImplementation(async () => response({}, 503, { 'retry-after': '60' }))
  await mount(); await click('Add food'); await click('Open Food Facts'); await type(host.querySelector('.searchf input'), 'nutella'); await click('Search')
  await wait(() => host.textContent.includes('catalogue is unavailable'))
  expect(host.textContent).toContain('Try again in 60 seconds.'); expect(host.textContent).not.toContain('request limit was reached')
  expect((await service.day('2026-10-10')).entries).toHaveLength(0); expect(transport).toHaveBeenCalledTimes(1)
})

test('during text-search 503 the user can use barcode and durably saved foods without losing journal data', async () => {
  await mount(); await search(); await click('Choose quantity'); await save();
  transport.mockImplementation(async url => new URL(url).pathname.includes('/product/') ? response({ status: 'success', product: offProduct() }) : response({}, 503, { 'retry-after': '60' }))
  await click('Add food'); await click('Open Food Facts'); await type(host.querySelector('.searchf input'), 'nutella'); await click('Search'); await wait(() => host.textContent.includes('catalogue is unavailable'))
  expect(host.textContent).toContain('Product name or brand:'); await click('Barcode'); await type(host.querySelector('.searchf input'), '3017620422003'); await click('Search')
  await wait(() => host.textContent.includes('Choose quantity')); expect(host.textContent).not.toContain('catalogue is unavailable')
  await click('Local foods and recipes'); await wait(() => host.querySelector('.nutrition-result')); await act(async () => host.querySelector('.nutrition-result').click()); await save()
  expect((await service.day('2026-10-10')).entries).toHaveLength(2); expect(service.getSnapshot().pending).toBeGreaterThan(0)
})

// Real Journal/editor/catalogue/service/engine; only provider bytes are fixtures.
const localCapability = () => { service.catalog.capabilities = vi.fn(async () => ({ textSearch:'local' })) }
const key = async (el, value) => { await act(async () => el.dispatchEvent(new KeyboardEvent('keydown',{key:value,bubbles:true,cancelable:true}))) }
async function localSearch(value='pâte') {
  localCapability(); await mount(); await click('Add food'); await click('Open Food Facts')
  const input=host.querySelector('[role="combobox"]'); expect(input).toBeTruthy(); await act(async()=>input.focus()); await type(input,value)
  await wait(()=>host.querySelector('[role="option"]')); return input
}
test('local combobox updates while typing, keyboard selection reaches durable meal editor',async()=>{
  const input=await localSearch('pâte'); expect(transport).toHaveBeenCalledTimes(1)
  expect(input.getAttribute('aria-expanded')).toBe('true'); expect(input.getAttribute('aria-autocomplete')).toBe('list')
  expect(document.getElementById(input.getAttribute('aria-controls')).getAttribute('role')).toBe('listbox')
  expect(input.hasAttribute('aria-activedescendant')).toBe(false); await key(input,'ArrowDown')
  expect(document.activeElement).toBe(input); const option=document.getElementById(input.getAttribute('aria-activedescendant')); expect(option.getAttribute('aria-selected')).toBe('true'); expect(option.tabIndex).toBe(-1)
  await key(input,'Enter'); await wait(()=>host.textContent.includes('Choose quantity')); expect(transport).toHaveBeenCalledTimes(2); expect(host.textContent).toContain('Choose quantity'); expect(document.activeElement.tagName).toBe('H3')
  await click('Choose quantity'); await type(field('Quantity'),'50'); await save()
  expect((await service.day('2026-10-10')).entries).toHaveLength(1); expect(service.getSnapshot().pending).toBeGreaterThan(0)
})
test('local typing is debounced, clearing resets results and focus without a request',async()=>{
  localCapability(); await mount(); await click('Add food'); await click('Open Food Facts'); const input=host.querySelector('[role="combobox"]'); input.focus()
  for(const value of ['p','pâ','pât','pâte']) await type(input,value)
  expect(transport).toHaveBeenCalledTimes(0); await wait(()=>host.querySelector('[role="option"]')); expect(transport).toHaveBeenCalledTimes(1)
  await act(async()=>host.querySelector('.searchf .clear').click()); expect(input.value).toBe(''); expect(document.activeElement).toBe(input); expect(host.querySelector('[role="option"]')).toBeNull()
  await act(async()=>new Promise(r=>setTimeout(r,350))); expect(transport).toHaveBeenCalledTimes(1)
})
test('local Escape closes, arrows reopen and Tab never accepts a suggestion',async()=>{
  const input=await localSearch(); await key(input,'ArrowUp'); expect(input.hasAttribute('aria-activedescendant')).toBe(true)
  await key(input,'Escape'); expect(input.getAttribute('aria-expanded')).toBe('false'); expect(input.hasAttribute('aria-activedescendant')).toBe(false)
  await key(input,'ArrowDown'); expect(input.getAttribute('aria-expanded')).toBe('true')
  await key(input,'Tab'); await act(async()=>button('Search').focus()); expect(input.getAttribute('aria-expanded')).toBe('false'); expect(host.querySelector('.nutrition-product')).toBeNull()
  expect((await service.day('2026-10-10')).entries).toHaveLength(0)
})
test('local stale response and aborted request cannot replace later suggestions',async()=>{
  const pending=[]; transport.mockImplementation((url,{signal})=>new Promise(resolve=>pending.push({url,signal,resolve})))
  localCapability(); await mount(); await click('Add food'); await click('Open Food Facts'); const input=host.querySelector('[role="combobox"]'); input.focus()
  await type(input,'first'); await wait(()=>pending.length===1); await type(input,'second'); expect(pending[0].signal.aborted).toBe(true); await wait(()=>pending.length===2)
  await act(async()=>pending[1].resolve(response({count:1,products:[offProduct({product_name_fr:'Second product',product_name_en:'Second product'})]}))); await wait(()=>host.textContent.includes('Second product'))
  await act(async()=>pending[0].resolve(response({count:1,products:[offProduct({product_name_fr:'Old product',product_name_en:'Old product'})]}))); expect(host.textContent).not.toContain('Old product')
  expect(input.value).toBe('second')
})
test('local IME composition waits until committed text, and short queries do not send',async()=>{
  localCapability(); await mount(); await click('Add food'); await click('Open Food Facts'); const input=host.querySelector('[role="combobox"]'); input.focus()
  await type(input,'p'); await act(async()=>new Promise(r=>setTimeout(r,350))); expect(transport).toHaveBeenCalledTimes(0)
  await act(async()=>input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}))); await type(input,'pâte'); await act(async()=>new Promise(r=>setTimeout(r,350))); expect(transport).toHaveBeenCalledTimes(0)
  await act(async()=>input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}))); await wait(()=>host.querySelector('[role="option"]')); expect(transport).toHaveBeenCalledTimes(1)
})
test('leaving local search before debounce cancels work and no background request runs',async()=>{
  localCapability(); await mount(); await click('Add food'); await click('Open Food Facts'); await type(host.querySelector('[role="combobox"]'),'pâte')
  await click('Local foods and recipes'); await act(async()=>new Promise(r=>setTimeout(r,350))); expect(transport).toHaveBeenCalledTimes(0)
})

test('local explicit Search and pagination refocus the combobox and leave results visible',async()=>{
  const input=await localSearch(); transport.mockImplementation(async()=>response({count:41,products:[offProduct()]}))
  await type(input,'pâte changed');await act(async()=>button('Search').focus());await click('Search');await wait(()=>host.querySelector('[role="option"]'))
  expect(document.activeElement).toBe(input);expect(input.getAttribute('aria-expanded')).toBe('true')
  const next=[...host.querySelectorAll('.nutrition-catalog button')].find(b=>b.textContent.trim()==='Next');expect(next).toBeTruthy()
  await act(async()=>next.focus());await act(async()=>next.click());await wait(()=>host.textContent.includes('Page 2'))
  expect(document.activeElement).toBe(input);expect(input.getAttribute('aria-expanded')).toBe('true');expect(host.querySelector('[role="listbox"]').hidden).toBe(false)
})
test('leaving the field before debounce does not reopen a popup or select anything',async()=>{
  localCapability(); await mount(); await click('Add food');await click('Open Food Facts');const input=host.querySelector('[role="combobox"]');input.focus();await type(input,'pâte')
  await act(async()=>button('Search').focus());await wait(()=>host.querySelector('[role="option"]'))
  expect(input.getAttribute('aria-expanded')).toBe('false');expect(host.querySelector('.nutrition-product')).toBeNull()
})


test('local TSV identity hydrates via v3 only when selected, then actually enters the journal',async()=>{
  transport.mockImplementation(async url=>new URL(url).pathname.includes('/product/') ? response({status:'success',product:offProduct()}) : response({count:1,products:[offProduct({nutrition_data_per:null,nutriments:{},serving_size:'',serving_quantity:null})]}))
  const input=await localSearch('nutella'); expect(transport).toHaveBeenCalledTimes(1); await key(input,'ArrowDown'); await key(input,'Enter');
  await wait(()=>host.textContent.includes('Choose quantity')); expect(transport).toHaveBeenCalledTimes(2); expect(new URL(transport.mock.calls[1][0]).pathname).toContain('/api/v3/product/')
  await click('Choose quantity'); await type(field('Quantity'),'50'); await save(); const day=await service.day('2026-10-10'); expect(day.entries).toHaveLength(1); await wait(()=>host.textContent.includes('269.5'))
})
test('late v3 selection after typing cannot display or add the old product',async()=>{
  let finish
  transport.mockImplementation(async url=>new URL(url).pathname.includes('/product/') ? new Promise(resolve=>finish=resolve) : response({count:1,products:[offProduct()]}))
  const input=await localSearch('nutella'); await key(input,'ArrowDown'); await key(input,'Enter'); await wait(()=>!!finish)
  await type(input,'other'); await act(async()=>finish(response({status:'success',product:offProduct()})))
  expect(host.querySelector('.nutrition-product')).toBeNull(); expect((await service.day('2026-10-10')).entries).toHaveLength(0)
})
test('v3 supplier failure never enables addition using the index nutrition',async()=>{
  transport.mockImplementation(async url=>new URL(url).pathname.includes('/product/') ? response({},503,{'retry-after':'60'}) : response({count:1,products:[offProduct()]}))
  const input=await localSearch('nutella'); await key(input,'ArrowDown'); await key(input,'Enter'); await wait(()=>host.querySelector('[role="alert"]'))
  expect(host.querySelector('.nutrition-product')).toBeNull(); expect(host.textContent).not.toContain('Choose quantity'); expect((await service.day('2026-10-10')).entries).toHaveLength(0)
})
