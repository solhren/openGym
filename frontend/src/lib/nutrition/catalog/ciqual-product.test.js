import {test,expect,vi} from 'vitest'
import {normalizeLocalProduct} from './local-product.js'
import {createFoodCatalog} from './client.js'
import {response} from './fixtures.test-util.js'
import {localBody} from './local-fixtures.test-util.js'
import {ciqualRecord,ciqualCapabilities} from './ciqual-fixtures.test-util.js'
import {isCiqualId} from './identity.js'

test.each(['fr','en'])('Ciqual %s uses official names, explicit mass and licence without a fabricated barcode',language=>{
 const row=ciqualRecord(language),product=normalizeLocalProduct(row)
 expect(product.food).toEqual(row.food);expect(product.code).toBeNull()
 expect(product.reference).toEqual({amount:100,unit:'g'})
 expect(product.sourceUrl).toBe('https://doi.org/10.57745/RDMHWY')
 expect(product.food.nutrients.kcal).toBe(46.5)
 product.food.name='Changed';expect(row.food.name).not.toBe('Changed')
})
test('partial Ciqual values remain unknown and review-only rows have no Food',()=>{
 const row=ciqualRecord();row.food.nutrients.kcal=null;row.validationStatus='partial';row.warnings=['missing-values']
 expect(normalizeLocalProduct(row).food.nutrients.kcal).toBeNull()
 row.food=null;row.reference=null;row.validationStatus='needs-verification'
 expect(normalizeLocalProduct(row).food).toBeNull()
})
const changes={
 fabricatedBarcode:r=>r.code='3017620422003',volume:r=>r.food.reference.unit='ml',density:r=>r.food.densityGPerMl=1,
 serving:r=>r.food.portions.push({id:'cup',name:'Cup',amount:100,unit:'g'}),id:r=>r.id='ciqual:../../123',
 identity:r=>r.source.foodCode='234',future:r=>r.source.version='2099',source:r=>r.source.provider='wger',
 licence:r=>r.source.license.id='CC0-1.0',unsafeUrl:r=>r.source.license.url='javascript:alert(1)',
 sourceHash:r=>r.source.sourceSha256='no',namesHash:r=>r.source.namesSourceSha256='no',falseLocale:r=>r.language='de',
 fabricatedTranslation:r=>r.name='Invented name',badNutrient:r=>r.food.nutrients.protein=101,
 falseComplete:r=>r.food.nutrients.kcal=null,missingReference:r=>r.reference=null,
 lostProvenance:r=>r.food.source.publicCatalogImport={...r.source,foodCode:'0'},
 inconsistentLicense:r=>r.food.source.license={...r.source.license,id:'ODbL-1.0'},
}
test.each(Object.keys(changes))('reject Ciqual corruption: %s',key=>{
 const row=ciqualRecord();changes[key](row);expect(()=>normalizeLocalProduct(row)).toThrow()
})
test('bounded Ciqual namespace preserves leading zeros and refuses paths',()=>{
 expect(isCiqualId('ciqual:00123')).toBe(true)
 for(const id of ['ciqual:','ciqual:123456789','ciqual:1/2','wger:123','ciqual:1.2'])expect(isCiqualId(id)).toBe(false)
})
test('Ciqual capability, multilingual text, local selection and barcode miss never call a food provider',async()=>{
 const row=ciqualRecord('en'),external=vi.fn(()=>{throw Error('no food provider')})
 const local=vi.fn(async path=>{
  const url=new URL(path,'http://local')
  if(url.searchParams.has('code'))return response({code:'catalog-not-found'},404)
  return response(localBody(path.includes('/search?')?{products:[row],count:1,page:1,pageSize:20,literalOnly:true,registryVerified:true,catalogueVersion:'a'.repeat(64)}:{product:row}))
 })
 const client=createFoodCatalog({localOnlyV1:true,transport:external,localTransport:local,capabilitiesTransport:async()=>response(ciqualCapabilities)})
 try {
  expect(await client.capabilities()).toMatchObject({provider:'ciqual',available:true})
  expect((await client.search('milk',{language:'en'})).products[0].name).toBe('Test milk')
  expect((await client.localProduct(row.id,{language:'en'})).product.food.name).toBe('Test milk')
  await expect(client.product('3017620422003')).rejects.toMatchObject({code:'not-found'})
  expect(local.mock.calls[0][0]).toContain('lc=en');expect(external).not.toHaveBeenCalled()
 } finally {client.close()}
})
