import {test,expect,vi} from 'vitest'
import {createPublicCatalogRelay} from './public-relay.js'
import {createFoodCatalog} from './client.js'
import {localCapabilities} from './local-fixtures.test-util.js'
import {response} from './fixtures.test-util.js'
const address='https://gym.example.test'
const native=get=>async()=>({Capacitor:{isNativePlatform:()=>true},CapacitorHttp:{get}})
const url='https://world.openfoodfacts.org/cgi/search.pl?search_terms=nutela&lc=fr&page=1'
test('paired native local text uses fixed openGym endpoint without tokens or OFF fetch',async()=>{
  const get=vi.fn(async()=>({status:200,data:{count:0,products:[]},headers:{}})),relay=createPublicCatalogRelay(address,{loadNative:native(get)})
  const result=await relay.transport(url,{signal:new AbortController().signal,localOnly:true})
  expect(get.mock.calls[0][0].url).toBe(address+'/api/nutrition/catalog/search?lc=fr&staging=0&q=nutela&page=1&local=1')
  expect(get.mock.calls[0][0].headers).toEqual({Accept:'application/json'});expect(result.catalogRelay).toBe(true);expect(JSON.parse(await result.text()).count).toBe(0)
  await relay.capabilities(null,{});expect(get.mock.calls[1][0].url).toBe(address+'/api/nutrition/catalog/capabilities')
})
test('native late socket response is discarded and outstanding requests are bounded',async()=>{
  const pending=[],get=vi.fn(()=>new Promise(resolve=>pending.push(resolve))),relay=createPublicCatalogRelay(address,{loadNative:native(get)}),controller=new AbortController()
  const first=relay.transport(url,{signal:controller.signal,localOnly:true}),failed=expect(first).rejects.toMatchObject({name:'AbortError'})
  await new Promise(r=>setTimeout(r,0));controller.abort();await failed
  const second=relay.transport(url,{signal:new AbortController().signal});await new Promise(r=>setTimeout(r,0))
  await expect(relay.transport(url,{signal:new AbortController().signal})).rejects.toMatchObject({code:'request-in-progress'})
  pending[0]({status:200,data:{count:0,products:[]}});pending[1]({status:200,data:{count:0,products:[]}});await second
  expect(get).toHaveBeenCalledTimes(2)
})
test('invalid origin/upstream destinations never invoke native HTTP',async()=>{
  const get=vi.fn(),relay=createPublicCatalogRelay(address,{loadNative:native(get)})
  for(const origin of ['file:///etc','https://user:secret@gym.test','https://gym.test/path']) expect(()=>createPublicCatalogRelay(origin)).toThrow()
  for(const target of ['https://evil.test/cgi/search.pl','https://world.openfoodfacts.org/admin','https://user@world.openfoodfacts.org/cgi/search.pl']) expect(()=>relay.transport(target,{})).toThrow()
  expect(get).not.toHaveBeenCalled()
})
test('UUID local request cannot become a generic endpoint/path relay',async()=>{
  const get=vi.fn(async()=>({status:200,data:{product:null}})),relay=createPublicCatalogRelay(address,{loadNative:native(get)})
  await relay.localRequest('/api/nutrition/catalog/product?id=wger%3A12345678-1234-1234-1234-123456789abc&lc=fr&staging=0',{})
  expect(get.mock.calls[0][0].url).toContain('/api/nutrition/catalog/product?id=wger%3A')
  for(const path of ['/api/me','https://evil.test/api/nutrition/catalog/product','/api/nutrition/catalog/capabilities/../../me','/api/nutrition/catalog/capabilities?token=secret','/api/nutrition/catalog/search?q=riz&q=lait'])await expect(relay.localRequest(path,{})).rejects.toMatchObject({code:'invalid-query'})
  expect(get).toHaveBeenCalledTimes(1)
})
test('native oversized strings and unsafe objects are rejected, zeros in barcode retained',async()=>{
  const get=vi.fn(async()=>({status:200,data:'x'.repeat(1024*1024+1)})),relay=createPublicCatalogRelay(address,{loadNative:native(get)})
  await expect(relay.transport(url,{})).rejects.toMatchObject({code:'response-too-large'})
  get.mockResolvedValue({status:200,data:JSON.parse('{"__proto__":{}}')});await expect(relay.transport(url,{})).rejects.toThrow()
  get.mockResolvedValue({status:200,data:'{"status":"failure"}'});await relay.transport('https://world.openfoodfacts.org/api/v3/product/0034000470693',{})
  expect(get.mock.calls.at(-1)[0].url).toContain('code=0034000470693')
})
test.each([429,503])('native status %i preserves Retry-After without parsing an HTML error page',async status=>{
  const relay=createPublicCatalogRelay(address,{loadNative:native(async()=>({status,data:'<html>error</html>',headers:{'Retry-After':'30'}}))})
  const response=await relay.transport(url,{});expect(response.status).toBe(status);expect(response.headers.get('retry-after')).toBe('30')
})

test('native socket cap survives replacement of the account-bound relay',async()=>{
  const pending=[],get=vi.fn(()=>new Promise(resolve=>pending.push(resolve))),first=createPublicCatalogRelay(address,{loadNative:native(get)}),second=createPublicCatalogRelay(address,{loadNative:native(get)})
  const controllers=[new AbortController(),new AbortController()]
  const calls=controllers.map(c=>first.transport(url,{signal:c.signal}))
  const failures=calls.map(call=>expect(call).rejects.toMatchObject({name:'AbortError'}))
  await new Promise(r=>setTimeout(r,0));controllers.forEach(c=>c.abort());await Promise.all(failures)
  await expect(second.transport(url,{})).rejects.toMatchObject({code:'request-in-progress'})
  pending.forEach(resolve=>resolve({status:200,data:{count:0,products:[]}}));await new Promise(r=>setTimeout(r,0))
  expect(get).toHaveBeenCalledTimes(2)
})

test.each(['object','json'])('native %s conflict reaches the real catalogue client as actionable barcode ambiguity',async format=>{
  const body={code:'catalog-ambiguous-barcode'},get=vi.fn(async()=>({status:409,data:format==='json'?JSON.stringify(body):body,headers:{}}))
  const relay=createPublicCatalogRelay(address,{loadNative:native(get)}),provider=vi.fn(()=>{throw Error('external provider forbidden')})
  const catalogue=createFoodCatalog({localOnlyV1:true,transport:provider,localTransport:relay.localRequest,capabilitiesTransport:async()=>response(localCapabilities)})
  try{await catalogue.capabilities();await expect(catalogue.product('0034000470693')).rejects.toMatchObject({code:'ambiguous-barcode'});expect(provider).not.toHaveBeenCalled()}
  finally{catalogue.close()}
})

test('native conflict pages, oversized text and getters cannot leak or execute error content',async()=>{
  let invoked=false;const getter=Object.defineProperty({},'code',{get(){invoked=true;return 'catalog-ambiguous-barcode'}})
  for(const data of ['<html>private diagnostics</html>','x'.repeat(1025),getter]){
    const relay=createPublicCatalogRelay(address,{loadNative:native(async()=>({status:409,data}))})
    const r=await relay.localRequest('/api/nutrition/catalog/product?code=0034000470693',{})
    expect(await r.text()).toBe('{"code":"catalog-request-cancelled"}')
  }
  expect(invoked).toBe(false)
})
