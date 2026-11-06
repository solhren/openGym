// @vitest-environment happy-dom
import{beforeEach,afterEach,test,expect,vi}from'vitest'
const secure=vi.hoisted(()=>({values:new Map(),get:vi.fn(),set:vi.fn(),remove:vi.fn()}))
const legacy=vi.hoisted(()=>({loadRemoteFile:vi.fn(),saveRemoteFile:vi.fn()}))
vi.mock('./mobile.js',()=>({MOBILE:true,...legacy}))
vi.mock('@capacitor/core',()=>({Capacitor:{isNativePlatform:()=>true,getPlatform:()=> 'android'}}))
vi.mock('@aparajita/capacitor-secure-storage',()=>({SecureStorage:secure}))
const origin='https://gym.example.com'
beforeEach(()=>{vi.resetModules();vi.stubEnv('VITE_OPENGYM_PERSONAL_BETA','1');vi.stubEnv('VITE_NUTRITION_LOCAL_V1','1');vi.stubEnv('VITE_MOBILE','1');vi.stubEnv('VITE_NUTRITION_CATALOG_ORIGIN',origin);vi.clearAllMocks();secure.values.clear();secure.get.mockImplementation(async k=>secure.values.get(k)??null);secure.set.mockImplementation(async(k,v)=>secure.values.set(k,v));secure.remove.mockImplementation(async k=>secure.values.delete(k))})
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs()})
const pairing=()=>new Response(JSON.stringify({token:'synthetic-session-token',user:{id:'synthetic-owner',name:'Fixture'}}),{status:200})
test('personal build forbids guest access before config, during an outage and despite a guest-capable response',async()=>{
 const{guestAllowed}=await import('./guest.js');for(const config of [null,undefined,{}, {allow_guest:true},{allow_guest:false}])expect(guestAllowed(config)).toBe(false)
})
test('personal Android pairs through existing flow; secure session survives module reload, never legacy JSON',async()=>{
 const fetch=vi.fn(async()=>pairing());vi.stubGlobal('fetch',fetch);let remote=await import('./remote.js');await remote.connect(origin,'PAIR1234');expect(fetch.mock.calls[0][0]).toBe(origin+'/api/pair/redeem');expect(legacy.saveRemoteFile).not.toHaveBeenCalled()
 vi.resetModules();remote=await import('./remote.js');const saved=await remote.loadRemote();expect(saved.token).toBe('synthetic-session-token');const api=await import('./api.js');api.setRemoteAuth(saved.base,saved.token)
 fetch.mockResolvedValue(new Response('{}',{status:200}));await api.authenticatedCatalogFetch('/api/nutrition/catalog/search?q=lait');expect(fetch.mock.calls.at(-1)[1].headers.Authorization).toBe('Bearer synthetic-session-token');expect(fetch.mock.calls.at(-1)[0]).toBe(origin+'/api/nutrition/catalog/search?q=lait')
 await remote.renewToken(saved,'renewed-synthetic-token');expect((await remote.loadRemote()).token).toBe('renewed-synthetic-token');expect(legacy.loadRemoteFile).not.toHaveBeenCalled()
})
test('failed native persistence cannot become a successful pairing or a memory-only login',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>pairing()));secure.set.mockRejectedValue(new Error('Keystore unavailable'));const remote=await import('./remote.js');await expect(remote.connect(origin,'PAIR1234')).rejects.toThrow('Keystore unavailable');const api=await import('./api.js');expect(()=>api.authenticatedCatalogFetch('/api/nutrition/catalog/capabilities')).toThrow();expect(secure.values.size).toBe(0)
})
test('unpaired personal catalogue never falls back to anonymous/native/provider requests',async()=>{
 const fetch=vi.fn();vi.stubGlobal('fetch',fetch);const{createFoodCatalog}=await import('./nutrition/catalog/client.js');const c=createFoodCatalog();try{expect((await c.capabilities()).available).toBe(false);expect(()=>c.search('Nutella')).toThrow();expect(fetch).not.toHaveBeenCalled()}finally{c.close()}
})
test('wrong origin and local-only choice are refused without changing existing credentials',async()=>{
 const fetch=vi.fn();vi.stubGlobal('fetch',fetch);const remote=await import('./remote.js');await expect(remote.connect('https://foreign.example.org','PAIR1234')).rejects.toThrow('Wrong personal beta server');await expect(remote.chooseLocal()).rejects.toThrow();expect(fetch).not.toHaveBeenCalled();expect(legacy.saveRemoteFile).not.toHaveBeenCalled()
})
test('authenticated catalogue uses AbortSignal and a fixed API path without exposing tokens to redirects',async()=>{
 const fetch=vi.fn(async()=>new Response('{}'));vi.stubGlobal('fetch',fetch);const api=await import('./api.js');api.setRemoteAuth(origin,'synthetic');const ctl=new AbortController();await api.authenticatedCatalogFetch('/api/nutrition/catalog/product?code=3017620422003',{signal:ctl.signal});expect(fetch.mock.calls[0][1]).toMatchObject({signal:ctl.signal,redirect:'error',credentials:'omit'});expect(()=>api.authenticatedCatalogFetch('/api/me')).toThrow();expect(()=>api.setRemoteAuth('http://gym.example.com','synthetic')).toThrow()
})

test('personal builds require an explicit server origin',async()=>{vi.stubEnv('VITE_NUTRITION_CATALOG_ORIGIN','');await expect(import('./personal-beta.js')).rejects.toThrow('Set VITE_NUTRITION_CATALOG_ORIGIN')})
