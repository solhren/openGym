// @vitest-environment happy-dom
import React,{act,useSyncExternalStore}from'react'
import{createRoot}from'react-dom/client'
import{MemoryRouter}from'react-router-dom'
import{beforeEach,afterEach,test,expect,vi}from'vitest'
const scanner=vi.hoisted(()=>({isSupported:vi.fn(),checkPermissions:vi.fn(),requestPermissions:vi.fn(),isGoogleBarcodeScannerModuleAvailable:vi.fn(),scan:vi.fn()}))
vi.mock('../../lib/mobile.js',async original=>({...await original(),MOBILE:true}))
vi.mock('@capacitor-mlkit/barcode-scanning',()=>({BarcodeScanner:scanner}))
import{NutritionScreen}from'../Nutrition.jsx'
import{createNutritionUISession}from'../../lib/nutrition/ui-session.js'
import{backupFixture}from'../../lib/nutrition/backup.test-util.js'
import{setLang}from'../../lib/i18n.js'
import{referenceFixture}from'../../../../scripts/nutrition-local-catalog/off-integration-fixtures.mjs'
import{localCapabilities,localBody,localRecord}from'../../lib/nutrition/catalog/local-fixtures.test-util.js'
import{response}from'../../lib/nutrition/catalog/fixtures.test-util.js'
globalThis.IS_REACT_ACT_ENVIRONMENT=true
let host,root,fixture,service,remote,local,record
const wait=async predicate=>{const end=Date.now()+6000;while(!predicate()){if(Date.now()>end)throw Error(host.textContent);await act(async()=>{await new Promise(r=>setTimeout(r,10))})}}
const click=async label=>{const b=[...host.querySelectorAll('button')].find(b=>b.textContent.trim()===label);expect(b,label).toBeTruthy();await act(async()=>b.click())}
const field=label=>[...host.querySelectorAll('label')].find(l=>l.querySelector('span')?.textContent===label)?.querySelector('input,select')
const type=async(el,value)=>{await act(async()=>{Object.getOwnPropertyDescriptor(el.constructor.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}))})}
async function mount(){function App(){const status=useSyncExternalStore(service.subscribe,service.getSnapshot);return <NutritionScreen service={service} status={status}/>}
 await act(async()=>root.render(<MemoryRouter initialEntries={['/nutrition?date=2026-10-27']}><App/></MemoryRouter>));await wait(()=>host.textContent.includes('Add food'))}
const make=()=>createNutritionUISession({store:fixture.store,session:fixture.session.value,getSession:()=>fixture.session.value,online:()=>false,catalogLocalOnly:true,catalogTransport:remote,catalogLocalTransport:local,catalogCapabilitiesTransport:async()=>response(localCapabilities)})
beforeEach(async()=>{await setLang('en',false);vi.clearAllMocks();scanner.isSupported.mockResolvedValue({supported:true});scanner.checkPermissions.mockResolvedValue({camera:'granted'});scanner.requestPermissions.mockResolvedValue({camera:'denied'});scanner.isGoogleBarcodeScannerModuleAvailable.mockResolvedValue({available:true});record=(await referenceFixture('drink')).record;scanner.scan.mockResolvedValue({barcodes:[{rawValue:record.code,format:'EAN_13'}]});fixture=await backupFixture('fs');remote=vi.fn(()=>{throw Error('external food provider forbidden')});local=vi.fn(async()=>response(localBody({product:record})));service=make();host=document.createElement('div');document.body.append(host);root=createRoot(host);await mount()})
afterEach(async()=>{await act(async()=>root.unmount());service.close();host.remove()})
async function open(){await click('Add food');await click('Food catalogue');await wait(()=>service.catalog.localReady)}
async function save(){await act(async()=>host.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));await wait(()=>!host.querySelector('.nutrition-editor'));expect(service.getSnapshot().error).toBeNull()}
for(const kind of ['spread','drink'])test(`native ${kind}: scan -> exact local barcode -> quantity -> durable journal and reopen`,async()=>{
 record=(await referenceFixture(kind)).record;scanner.scan.mockResolvedValue({barcodes:[{rawValue:record.code,format:'EAN_13'}]});await open();expect(scanner.scan).not.toHaveBeenCalled();await click('Scan product barcode');await wait(()=>host.querySelector('.nutrition-product'))
 expect(local.mock.calls[0][0]).toContain('code='+record.code);expect(host.textContent).toContain('100 '+record.reference.unit);await click('Choose quantity');await type(field('Quantity'),'50');await save()
 let row=(await service.day('2026-10-27')).entries[0];expect(row.snapshot).toEqual(record.food);expect(row.quantity).toEqual({amount:50,unit:record.reference.unit});await wait(()=>host.querySelector(`[aria-label="Edit ${record.name}"]`));await act(async()=>host.querySelector(`[aria-label="Edit ${record.name}"]`).click());await type(field('Quantity'),'75');await save()
 await act(async()=>root.unmount());service.close();await fixture.reopen();service=make();await service.refresh();root=createRoot(host);await mount();row=(await service.day('2026-10-27')).entries[0];expect(row.quantity.amount).toBe(75);expect(row.snapshot).toEqual(record.food);expect(service.getSnapshot().pending).toBeGreaterThan(0)
 await wait(()=>host.querySelector(`[aria-label="Delete ${record.name}"]`));await act(async()=>host.querySelector(`[aria-label="Delete ${record.name}"]`).click());await click('Delete');await wait(()=>!service.getSnapshot().busy&&!host.querySelector(`[aria-label="Edit ${record.name}"]`));expect((await service.day('2026-10-27')).entries).toHaveLength(0);expect(remote).not.toHaveBeenCalled()
},15000)
test('native cancellation leaves no error, provider request or journal entry',async()=>{scanner.scan.mockRejectedValueOnce(new Error('scan canceled.'));await open();await click('Scan product barcode');await wait(()=>scanner.scan.mock.calls.length===1);expect(host.querySelector('[role="alert"]')).toBeNull();expect(local).not.toHaveBeenCalled();expect((await service.day('2026-10-27')).entries).toHaveLength(0)})
test('camera refusal is explicit and never starts capture or requests a product',async()=>{scanner.checkPermissions.mockResolvedValue({camera:'prompt'});await open();await click('Scan product barcode');await wait(()=>host.querySelector('[role="alert"]'));expect(host.textContent).toContain('Camera permission is needed');expect(scanner.scan).not.toHaveBeenCalled();expect(local).not.toHaveBeenCalled()})
for(const [status,code,message]of[[404,'catalog-not-found','No catalogue products found'],[409,'catalog-ambiguous-barcode','Several local products share this barcode']])test(`scan status ${status} cannot enable quantity or create an entry`,async()=>{local.mockResolvedValue(response({code},status));await open();await click('Scan product barcode');await wait(()=>host.querySelector('[role="alert"]'));expect(host.textContent).toContain(message);expect(host.textContent).not.toContain('Choose quantity');expect((await service.day('2026-10-27')).entries).toHaveLength(0);expect(remote).not.toHaveBeenCalled()})
test('a scanned identity without a reliable reference remains visibly non-addable',async()=>{const p={...localRecord(),food:null,reference:null,validationStatus:'needs-verification'};scanner.scan.mockResolvedValue({barcodes:[{rawValue:p.code,format:'EAN_8'}]});local.mockResolvedValue(response(localBody({product:p})));await open();await click('Scan product barcode');await wait(()=>host.querySelector('.nutrition-product'));expect(host.textContent).toContain('cannot be added');expect(host.textContent).not.toContain('Choose quantity');expect((await service.day('2026-10-27')).entries).toHaveLength(0)})
