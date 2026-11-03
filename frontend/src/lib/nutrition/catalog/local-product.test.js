import {test,expect,vi,afterEach} from 'vitest'
import {normalizeLocalProduct} from './local-product.js'
import {createFoodCatalog} from './client.js'
import {response} from './fixtures.test-util.js'
import {localId,localRecord,localBody,localSearchBody,localCapabilities} from './local-fixtures.test-util.js'
const clients=[];afterEach(()=>clients.splice(0).forEach(c=>c.close()))
function create(options={}) {
 const remote=vi.fn(()=>{throw Error('no external request allowed')})
 const local=vi.fn(async path=>path.includes('/search?')?response(localSearchBody()):response(localBody({product:localRecord()})))
 const c=createFoodCatalog({localOnlyV1:true,transport:remote,localTransport:local,capabilitiesTransport:async()=>response(localCapabilities),...options});clients.push(c);return {c,remote,local}
}
test('local DTO retains exact nutrition, source and leading zeros, alias is search-only',()=>{
 const raw=localRecord(),p=normalizeLocalProduct(raw);expect(p.food).toEqual(raw.food);expect(p.code).toBe('00012345');expect(p.food.nutrients.protein).toBe(7.123);expect(p.food.name).toBe('Rice, raw')
})
test('local search and UUID/barcode selection never call OFF, cache is bounded and detached',async()=>{
 const {c,remote,local}=create();await c.capabilities();const found=await c.search('riz');expect(found.products[0].name).toBe('Riz cru');await c.localProduct(localId);await c.product('00012345')
 expect(local.mock.calls.every(([p])=>p.startsWith('/api/nutrition/catalog/'))).toBe(true);expect(local.mock.calls[1][0]).toContain('id=wger%3A');expect(remote).not.toHaveBeenCalled()
 found.products[0].food.nutrients.kcal=0;expect((await c.search('riz')).products[0].food.nutrients.kcal).toBe(350.6);expect(local).toHaveBeenCalledTimes(3)
})
test.each([response({},503),response({schemaVersion:1,textSearch:'explicit-remote'})])('explicit V1 cannot downgrade on old/unavailable capability',async result=>{
 const {c,remote,local}=create({capabilitiesTransport:async()=>result});expect(await c.capabilities()).toMatchObject({available:false,textSearch:'local'})
 expect(()=>c.search('riz')).toThrow('provider-unavailable');expect(()=>c.product('00012345')).toThrow();expect(remote).not.toHaveBeenCalled();expect(local).not.toHaveBeenCalled()
})
test('local corruption, lying reference/source and fabricated validation are rejected',()=>{
 for(const change of [r=>r.reference={amount:100,unit:'ml'},r=>r.source.uuid='wrong',r=>r.food.nutrients.protein=101,r=>r.food=null,r=>r.translation.status='manufacturer-label',r=>r.extra='secret']) {
  const row=structuredClone(localRecord());change(row);expect(()=>normalizeLocalProduct(row)).toThrow()
 }
 expect(()=>normalizeLocalProduct(JSON.parse('{"__proto__":{}}'))).toThrow()
})
test('barcode conflicts are explicit, absent and unavailable never trigger fallback',async()=>{
 for(const [status,code,expected] of [[409,'catalog-ambiguous-barcode','ambiguous-barcode'],[404,'catalog-not-found','not-found'],[503,'catalog-local-unavailable','provider-unavailable']]) {
  const {c,remote}=create({localTransport:async()=>Object.assign(response({code},status),{catalogRelay:true})});await c.capabilities();await expect(c.product('00012345')).rejects.toMatchObject({code:expected});expect(remote).not.toHaveBeenCalled()
 }
})
test('late local response cannot cross a session close or mutate cache',async()=>{
 let finish;const {c}=create({localTransport:()=>new Promise(r=>finish=r)});await c.capabilities();const p=c.search('riz');await Promise.resolve();c.close();finish(response(localSearchBody()));await expect(p).rejects.toThrow();expect(c.cacheInfo().entries).toBe(0)
})
test('local selection rereads a changed descriptor instead of hiding a quality revision in memory cache',async()=>{
 let calls=0
 const {c,remote}=create({localTransport:async()=>{const p=localRecord();if(++calls>1){p.food.id='new-public-revision';p.food.nutrients.kcal=351}return response(localBody({product:p}))}})
 await c.capabilities();const first=await c.localProduct(localId),second=await c.localProduct(localId)
 expect(first.product.food.nutrients.kcal).toBe(350.6);expect(second.product.food.nutrients.kcal).toBe(351);expect(second.cached).toBe(false);expect(calls).toBe(2);expect(remote).not.toHaveBeenCalled()
})
