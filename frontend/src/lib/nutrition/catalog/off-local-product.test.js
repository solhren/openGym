import {test,expect,vi} from 'vitest'
import {referenceFixture} from '../../../../../scripts/nutrition-local-catalog/off-integration-fixtures.mjs'
import {normalizeLocalProduct} from './local-product.js'
import {createFoodCatalog} from './client.js'
import {localCapabilities,localBody} from './local-fixtures.test-util.js'
import {response} from './fixtures.test-util.js'

test('certified local OFF reference keeps ml and complete immutable provenance',async()=>{
 const {record}=await referenceFixture();const p=normalizeLocalProduct(record)
 expect(p.food).toEqual(record.food);expect(p.reference).toEqual({amount:100,unit:'ml'});expect(p.source.offReference.per).toBe('100ml');expect(p.source.license.id).toBe('ODbL-1.0')
})
test('local OFF descriptor cannot forge identity, source, unit or completeness',async()=>{
 const {record}=await referenceFixture()
 for(const change of [r=>r.id='off:03017620422003',r=>r.reference={amount:100,unit:'g'},r=>r.food.nutrients.protein=null,r=>r.source={...r.source,contentLicense:'unknown'},r=>r.food.source.offReference.per='100g',r=>r.lookupId='off:00000000000000',r=>r.code='3017620422003']){
  const r=structuredClone(record);change(r);expect(()=>normalizeLocalProduct(r)).toThrow()
 }
})
test('local barcode alias and migrated UUID resolve without provider; review-only search remains non-addable',async()=>{
 const {record}=await referenceFixture(),remote=vi.fn(()=>{throw Error('external food request forbidden')})
 const old='wger:12345678-1234-1234-1234-123456789abc'
 const local=vi.fn(async path=>response(localBody({product:path.includes('id=wger')?{...record,lookupId:old}:record})))
 const c=createFoodCatalog({localOnlyV1:true,transport:remote,localTransport:local,capabilitiesTransport:async()=>response(localCapabilities)})
 try{await c.capabilities();expect((await c.product('05449000000996')).product.code).toBe('5449000000996');expect((await c.localProduct(old)).product.lookupId).toBe(old);expect(remote).not.toHaveBeenCalled()}
 finally{c.close()}
})
