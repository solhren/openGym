import {afterEach,beforeEach,test,expect,vi} from 'vitest'
import {offProduct} from './fixtures.test-util.js'
const bridge=vi.hoisted(()=>({get:vi.fn()}))
vi.mock('@capacitor/core',()=>({Capacitor:{isNativePlatform:()=>true},CapacitorHttp:{get:bridge.get}}))
let catalog
beforeEach(()=>{
 vi.resetModules();vi.stubEnv('VITE_MOBILE','1');vi.stubEnv('VITE_NUTRITION_CATALOG_ORIGIN','https://catalogue.example');bridge.get.mockReset()
 bridge.get.mockImplementation(async ({url})=>({status:200,headers:{},data:url.endsWith('capabilities')?{schemaVersion:1,textSearch:'local'}:url.includes('/product?')?{status:'success',product:offProduct()}:{count:1,products:[offProduct({nutrition_data_per:null,nutriments:{},serving_size:'',serving_quantity:null})]}}))
})
afterEach(()=>{catalog?.close();vi.unstubAllEnvs()})
test('guest Android public origin serves local suggestions and validated selection without account credentials',async()=>{
 const {createFoodCatalog}=await import('./client.js');catalog=createFoodCatalog();expect(await catalog.capabilities()).toEqual({textSearch:'local'})
 const search=await catalog.search('nutela',{localOnly:true});expect(search.products[0].food).toBeNull()
 const selected=await catalog.product(offProduct().code);expect(selected.product.food.reference).toEqual({amount:100,unit:'g'})
 expect(bridge.get).toHaveBeenCalledTimes(3)
 for(const [request] of bridge.get.mock.calls){expect(new URL(request.url).origin).toBe('https://catalogue.example');expect(request.headers).toEqual({Accept:'application/json'});expect(request).not.toHaveProperty('cookies');expect(request).not.toHaveProperty('Authorization')}
 expect(bridge.get.mock.calls[1][0].url).toContain('local=1');expect(bridge.get.mock.calls[2][0].url).toContain('/api/nutrition/catalog/product?')
})
test('guest build endpoint remains anonymous when no account server is supplied',async()=>{
 const {createFoodCatalog}=await import('./client.js');catalog=createFoodCatalog();await catalog.capabilities()
 expect(new URL(bridge.get.mock.calls[0][0].url).origin).toBe('https://catalogue.example')
 expect(bridge.get.mock.calls[0][0].headers).toEqual({Accept:'application/json'})
})
test('unsafe public origin is refused before the native bridge starts',async()=>{
 vi.stubEnv('VITE_NUTRITION_CATALOG_ORIGIN','file:///private');const {createFoodCatalog}=await import('./client.js');expect(()=>createFoodCatalog()).toThrow();expect(bridge.get).not.toHaveBeenCalled()
})
