// Prepared DTO boundary only: no application route, account or user store.
import {inspectExternal,CatalogError} from '../../frontend/src/lib/nutrition/catalog/normalize.js'
import {validateFood} from '../../frontend/src/lib/nutrition/validate.js'
import {normalizeLocalProduct} from '../../frontend/src/lib/nutrition/catalog/local-product.js'
import {isLocalCatalogId,sameCatalogBarcode} from '../../frontend/src/lib/nutrition/catalog/identity.js'
const check=(ok,code='catalog-wger-invalid-response')=>{if(!ok)throw new CatalogError(code)}
export function publicWgerProduct(record){
 inspectExternal(record)
 check(record&&isLocalCatalogId(record.id)&&typeof record.name==='string'&&record.name.length>0&&record.name.length<=300)
 check(record.barcode===null||typeof record.barcode==='string'&&/^(?:\d{8}|\d{12,14})$/.test(record.barcode))
 check(['validated','partial','needs-verification'].includes(record.validationStatus))
 check(record.food===null||validateFood(record.food).length===0)
 check(record.validationStatus==='needs-verification'?record.food===null:record.food!==null)
 const dto={id:record.id,code:record.barcode,name:record.name,brand:record.brand,language:record.language,food:record.food,
  reference:record.food?.reference??null,validationStatus:record.validationStatus,issues:record.issues,warnings:record.warnings,source:record.provenance,
  ...(record.translation?{translation:record.translation,originalName:record.originalName}:{}),...(record.lookupId?{lookupId:record.lookupId}:{})}
 normalizeLocalProduct(dto);return dto
}
/** Future HTTP handlers may expose this public bounded service. Product selection
 * always reads SQLite by UUID. Neither miss nor failure delegates to OFF/wger.
 */
export function createWgerLocalCatalog(worker){
 return {
  async search({q,page=1,lc='fr'},{signal}={}){
   check(typeof q==='string'&&q.length>=2&&q.length<=120&&Number.isSafeInteger(page)&&page>=1&&page<=50&&typeof lc==='string'&&/^[a-z]{2}(?:-[a-z]{2})?$/.test(lc),'catalog-invalid-query')
   const tokens=q.normalize('NFC').match(/[\p{L}\p{N}]+/gu)??[]
   check(tokens.length>=1&&tokens.length<=8&&tokens.every(v=>v.length<=40),'catalog-invalid-query')
   const value=await worker.request('search',{query:q,page,pageSize:20,language:lc},{signal});inspectExternal(value)
   check(value.literalOnly===true&&Array.isArray(value.products)&&value.products.length<=20&&Number.isSafeInteger(value.count)&&value.count>=value.products.length&&value.count<=5000000&&/^[a-f0-9]{64}$/.test(value.catalogueVersion))
   return {...value,products:value.products.map(publicWgerProduct)}
  },
  async product(id,{signal}={}){
   check(isLocalCatalogId(id),'catalog-invalid-id')
   const value=await worker.request('product',{uid:id},{signal});if(value===null)return null
   check(value.id===id||value.lookupId===id);return publicWgerProduct(value)
  },
  async barcode(code,{signal}={}){
   check(typeof code==='string'&&/^(?:\d{8}|\d{12,14})$/.test(code),'catalog-invalid-barcode')
   const values=await worker.request('barcode',{code},{signal});inspectExternal(values);check(Array.isArray(values)&&values.length<=20&&values.every(v=>sameCatalogBarcode(v.barcode,code)));return values.map(publicWgerProduct)
  },
  close:()=>worker.close()
 }
}
