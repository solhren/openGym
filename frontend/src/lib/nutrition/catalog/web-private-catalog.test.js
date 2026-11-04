import {afterEach,expect,test,vi} from 'vitest'
import {createFoodCatalog} from './client.js'
import {response} from './fixtures.test-util.js'
import {ciqualCapabilities,ciqualRecord} from './ciqual-fixtures.test-util.js'
import {localBody} from './local-fixtures.test-util.js'
afterEach(()=>vi.unstubAllGlobals())

test('normal web local catalogue sends same-origin session cookies on capability, search and selection only',async()=>{
 const row=ciqualRecord('en')
 const fetch=vi.fn(async(path,options)=>{
  expect(path.startsWith('/api/nutrition/catalog/')).toBe(true)
  // A protected public-installation API does not accept anonymous capability
  // probes. Exercise the default web transport, not an injected local reader.
  if(options.credentials!=='same-origin')return response({error:'unauthorized'},401)
  if(path.endsWith('/capabilities'))return response(ciqualCapabilities)
  return response(localBody(path.includes('/search?')?{products:[row],count:1,page:1,pageSize:20,literalOnly:true,registryVerified:true,catalogueVersion:'a'.repeat(64)}:{product:row}))
 })
 vi.stubGlobal('fetch',fetch)
 const client=createFoodCatalog({localOnlyV1:true})
 try {
  expect(await client.capabilities()).toMatchObject({available:true,provider:'ciqual'})
  expect((await client.search('milk',{language:'en'})).products[0].food.name).toBe('Test milk')
  expect((await client.localProduct(row.id,{language:'en'})).product.id).toBe(row.id)
  expect(fetch).toHaveBeenCalledTimes(3)
  for(const [,options] of fetch.mock.calls)expect(options).toMatchObject({credentials:'same-origin',redirect:'error',referrerPolicy:'no-referrer'})
 } finally {client.close()}
})
