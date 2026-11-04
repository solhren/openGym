import {fail,inspectExternal,barcode} from './normalize.js'
import {validateFood} from '../validate.js'
import {canonicalJson} from '../persistence-contract.js'
import {isLocalCatalogId,isWgerId,isCiqualId,catalogBarcodeKey,sameCatalogBarcode} from './identity.js'

/** A local DTO is not an OFF response. Preserve the already validated Food and
 * its identity/provenance; never infer units from a product name or barcode. */
export function normalizeLocalProduct(record) {
  inspectExternal(record)
  fail(record && typeof record==='object' && !Array.isArray(record),'invalid-response')
  const required=['id','code','name','brand','language','food','reference','validationStatus','issues','warnings','source']
  fail(required.every(k=>Object.hasOwn(record,k)) && Object.keys(record).every(k=>[...required,'translation','originalName','lookupId'].includes(k)),'invalid-response')
  fail(isLocalCatalogId(record.id),'invalid-response')
  fail(typeof record.name==='string' && record.name.trim().length>0 && record.name.length<=300 && typeof record.brand==='string' && record.brand.length<=300,'invalid-response')
  fail(record.language===null || typeof record.language==='string' && /^[a-z]{2}(?:-[a-z]{2})?$/.test(record.language),'invalid-response')
  if(record.code!==null)barcode(record.code)
  fail(['validated','partial','needs-verification'].includes(record.validationStatus),'invalid-response')
  fail(['issues','warnings'].every(k=>Array.isArray(record[k])&&record[k].length<=100&&record[k].every(v=>typeof v==='string'&&v.length<=100)),'invalid-response')
  if (isCiqualId(record.id)) {
    const provenance=record.source, food=record.food, license=provenance?.license
    const url='https://doi.org/10.57745/RDMHWY'
    fail(record.code===null && record.brand==='' && ['fr','en'].includes(record.language) && record.translation===undefined && record.originalName===undefined && record.lookupId===undefined,'invalid-response')
    fail(provenance && Object.keys(provenance).sort().join(',')==='foodCode,license,names,namesSourceSha256,provider,sourceName,sourceSha256,sourceUrl,version' && provenance.provider==='ciqual' && provenance.foodCode===record.id.slice(7) && provenance.version==='2025' && provenance.sourceName==='Anses — Ciqual 2025' && provenance.sourceUrl===url && /^[a-f0-9]{64}$/.test(provenance.sourceSha256) && /^[a-f0-9]{64}$/.test(provenance.namesSourceSha256),'invalid-response')
    fail(provenance.names && Object.keys(provenance.names).sort().join(',')==='en,fr' && typeof provenance.names.fr==='string' && provenance.names.fr.length>0 && provenance.names.fr.length<=300 && (provenance.names.en===null || typeof provenance.names.en==='string' && provenance.names.en.length>0 && provenance.names.en.length<=300) && record.name===provenance.names[record.language],'invalid-response')
    fail(license && Object.keys(license).sort().join(',')==='attribution,id,url' && license.id==='Etalab-2.0' && license.url==='https://spdx.org/licenses/etalab-2.0.html' && typeof license.attribution==='string' && license.attribution.length>0,'invalid-response')
    if (food===null) fail(record.reference===null && record.validationStatus==='needs-verification','invalid-response')
    else {
      fail(validateFood(food).length===0 && food.kind==='food' && food.name===record.name && (food.brand??'')==='' && record.validationStatus!=='needs-verification','invalid-response')
      // Ciqual reports edible portions by mass, including beverages. It supplies
      // no density or retail barcode: neither can be inferred by the UI.
      fail(food.reference.amount===100 && food.reference.unit==='g' && food.densityGPerMl===undefined && food.portions.length===0,'invalid-response')
      fail(food.source?.kind==='custom' && food.source.externalId===record.id && food.source.url===url && canonicalJson(food.source.publicCatalogImport)===canonicalJson(provenance) && canonicalJson(food.source.license)===canonicalJson(license) && canonicalJson(food.reference)===canonicalJson(record.reference),'invalid-response')
      const complete=['kcal','protein','carbs','fat'].every(k=>typeof food.nutrients[k]==='number')
      fail(record.validationStatus===(complete?'validated':'partial'),'invalid-response')
    }
    return {...structuredClone(record),image:null,serving:'',sourceUrl:url}
  }
  if(record.id.startsWith('off:')) {
    const food=record.food,source=food?.source,lineage=source?.offReference
    fail(record.code!==null&&record.id===`off:${catalogBarcodeKey(record.code)}`&&record.validationStatus==='validated'&&food&&validateFood(food).length===0,'invalid-response')
    fail(source?.kind==='open-food-facts'&&source.license?.id==='ODbL-1.0'&&source.contentLicense==='DbCL-1.0'&&sameCatalogBarcode(source.externalId,record.code),'invalid-response')
    fail(source.url===`https://world.openfoodfacts.org/product/${source.externalId}`&&source.license.url==='https://opendatacommons.org/licenses/odbl/1-0/'&&typeof source.license.attribution==='string'&&source.license.attribution.length>0,'invalid-response')
    fail(lineage?.kind==='raw-jsonl'&&lineage.policy==='coherent-as-sold-input-set-v1'&&lineage.preparation==='as_sold'&&['manufacturer','packaging','usda'].includes(lineage.source)&&lineage.captureConflict===false&&sameCatalogBarcode(lineage.originalCode,record.code),'invalid-response')
    fail(['rowSha256','captureSha256'].every(k=>/^[a-f0-9]{64}$/.test(lineage[k]??''))&&food.reference.amount===100&&lineage.per===(food.reference.unit==='ml'?'100ml':'100g'),'invalid-response')
    fail(canonicalJson(record.source)===canonicalJson(source)&&canonicalJson(record.reference)===canonicalJson(food.reference)&&food.name===record.name&&(food.brand??'')===record.brand,'invalid-response')
    fail(['kcal','protein','carbs','fat'].every(k=>typeof food.nutrients[k]==='number')&&record.translation===undefined&&record.originalName===undefined,'invalid-response')
    fail(record.lookupId===undefined||isWgerId(record.lookupId),'invalid-response')
    return {...structuredClone(record),image:null,serving:'',sourceUrl:source.url}
  }
  fail(record.lookupId===undefined&&record.source?.provider==='wger' && record.source.uuid===record.id.slice(5) && record.source.barcode===record.code,'invalid-response')
  if(record.food===null)fail(record.reference===null&&record.validationStatus==='needs-verification','invalid-response')
  else {
    fail(validateFood(record.food).length===0 && record.validationStatus!=='needs-verification','invalid-response')
    fail(record.food.source?.publicCatalogImport && record.brand===(record.food.brand??''),'invalid-response')
    fail(canonicalJson(record.reference)===canonicalJson(record.food.reference) && canonicalJson(record.source)===canonicalJson(record.food.source.publicCatalogImport),'invalid-response')
    fail(record.food.source.externalId===record.id,'invalid-response')
    if(record.validationStatus==='validated')fail(['kcal','protein','carbs','fat'].every(k=>typeof record.food.nutrients[k]==='number'),'invalid-response')
    fail(record.food.name===(record.originalName??record.name),'invalid-response')
  }
  if(record.translation!==undefined) {
    const tr=record.translation
    fail(tr && Object.keys(tr).sort().join(',')==='author,language,originalName,status' && tr.language==='fr' && tr.author==='openGym' && tr.status==='curated-search-label' && tr.originalName===record.originalName && typeof record.originalName==='string' && record.originalName.length<=300,'invalid-response')
  } else fail(record.originalName===undefined,'invalid-response')
  return {...structuredClone(record),image:null,serving:'',sourceUrl:'https://wger.de'}
}

export function localEnvelope(value) {
  inspectExternal(value)
  fail(value?.format==='opengym-local-food-catalog' && value.schemaVersion===1,'invalid-response')
  return value
}
