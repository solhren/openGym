// Evaluation only. Never disguise a wger UUID as a barcode or wger data as OFF.
import {inspectExternal} from '../../frontend/src/lib/nutrition/catalog/normalize.js'
import {validateFood,validateNutrients} from '../../frontend/src/lib/nutrition/validate.js'
import {contentHash} from '../../frontend/src/lib/nutrition/persistence-contract.js'
const text=(v,max=300)=>v==null?'':typeof v==='string'&&v.length<=max&&!/[\u0000-\u001f\u007f]/.test(v)?v.trim():null
const uuidPattern=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
export function licenseInfo(value){
 const input=typeof value==='object'&&value?value.url:null
 if(typeof input!=='string')return null
 try{
  const u=new URL(input);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.port||u.search||u.hash)return null
  const cc=/^\/licenses\/(by-sa|by)\/(3\.0|4\.0)\/(?:deed\.[a-z]+)?$/.exec(u.pathname)
  if(u.hostname==='creativecommons.org'&&cc)return{id:`CC-${cc[1].toUpperCase()}-${cc[2]}`,url:`https://creativecommons.org/licenses/${cc[1]}/${cc[2]}/`}
  if(u.hostname==='creativecommons.org'&&/^\/publicdomain\/zero\/1\.0\/?$/.test(u.pathname))return{id:'CC0-1.0',url:'https://creativecommons.org/publicdomain/zero/1.0/'}
  if(u.hostname==='opendatacommons.org'&&/^\/licenses\/odbl\/(?:1-0\/)?$/.test(u.pathname))return{id:'ODbL-1.0',url:'https://opendatacommons.org/licenses/odbl/1-0/'}
 }catch{}return null
}
const safeUrl=value=>{if(value==null||value==='')return'';if(typeof value!=='string')return null;try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&value.length<=1000?u.href:null}catch{return null}}
function checkedRegistry(context){
 inspectExternal(context)
 if(!Array.isArray(context?.languages)||!Array.isArray(context?.licenses))throw Error('invalid-registries')
 return context
}
/** Validate the bulk import's registry once, then capture a private frozen copy.
 * Every product still receives the same complete external-data and business
 * validation. Caller mutations cannot change mappings during a long import.
 */
export function createWgerNormalizer(context){
 const {languages,licenses}=checkedRegistry(context),copy=structuredClone({languages,licenses})
 const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v)}return v}
 freeze(copy)
 return row=>normalizeWithRegistry(row,copy)
}
/** Source references come from the source model, not from name/package guesses.
 * OFF-derived wger rows are quarantined: the importer lost the 100g/100ml base.
 * Non-OFF prototype Foods use v1's custom source with EXPLICIT public-import
 * provenance, and savedFoods (not customFoods). This is not a new user contract.
 */
export async function normalizeWger(row,context){return normalizeWithRegistry(row,checkedRegistry(context))}
async function normalizeWithRegistry(row,{languages,licenses}){
 inspectExternal(row)
 if(!row||Array.isArray(row)||typeof row.uuid!=='string'||!uuidPattern.test(row.uuid))throw Error('invalid-wger-identity')
 const name=text(row.name),brand=text(row.brand),commonName=text(row.common_name)
 if(!name||brand===null||commonName===null)throw Error('invalid-wger-text')
 const id='wger:'+row.uuid.toLowerCase(),issues=[],warnings=[]
 const language=languages.find(v=>v.id===row.language)?.short_name??null
 if(!language||!/^[a-z]{2}(?:-[a-z]{2})?$/.test(language))issues.push('unresolved-language')
 const licenseRecord=licenses.find(v=>v.id===row.license),license=licenseInfo(licenseRecord)
 if(!license)issues.push('unresolved-license')
 const sourceName=text(row.source_name,200),sourceUrl=safeUrl(row.source_url),author=text(row.license_author,10000)
 if(sourceName===null||sourceUrl===null||author===null)issues.push('invalid-provenance')
 const barcode=typeof row.code==='string'&&/^(?:\d{8}|\d{12,14})$/.test(row.code)?row.code:null
 if(row.code!=null&&row.code!==''&&!barcode)warnings.push('invalid-barcode-kept-as-uuid')
 let sourceKind='unknown'
 if(/open[\s_-]*food[\s_-]*facts/i.test(sourceName??'')||/https?:\/\/([a-z]+\.)?openfoodfacts\.org\//.test(sourceUrl??''))sourceKind='off-derived'
 else if(sourceName==='USDA')sourceKind='usda'
 else if(sourceName==='wger'||(!sourceName&&(row.code==null||row.code==='')))sourceKind='wger'
 if(sourceKind==='off-derived')issues.push('off-100g-or-100ml-reference-lost')
 if(sourceKind==='unknown')issues.push('unresolved-source-reference')
 if(license?.id==='ODbL-1.0'&&sourceKind!=='off-derived')issues.push('database-and-content-license-review-required')
 const values={},map={kcal:'energy',protein:'protein',carbs:'carbohydrates',fat:'fat',sugar:'carbohydrates_sugar',saturatedFat:'fat_saturated',fiber:'fiber',sodium:'sodium'}
 for(const [key,field] of Object.entries(map)){
  const value=row[field]
  if(value==null||value===''){values[key]=null;continue}
  if(!['string','number'].includes(typeof value)||(typeof value==='string'&&!/^\d+(?:\.\d+)?$/.test(value))){issues.push('invalid-'+field);values[key]=null;continue}
  const n=Number(value)
  if(!Number.isFinite(n)||n<0||n>(key==='kcal'?2000:100)){issues.push('invalid-'+field);values[key]=null}else values[key]=n
 }
 const complete=['kcal','protein','carbs','fat'].every(k=>values[k]!==null)
 // Cross-nutrient rules apply even when an ambiguous reference prevents a Food.
 // Keep rejected identities searchable without claiming their values are valid.
 const nutrientIssues=validateNutrients(values)
 if(nutrientIssues.length)issues.push('engine-nutrient-validation-failed')
 if(!complete)warnings.push('missing-values')
 const portions=[]
 if(row.weight_units!=null){
  if(!Array.isArray(row.weight_units)||row.weight_units.length>100)issues.push('invalid-weight-units')
  else for(const unit of row.weight_units){
   if(!unit||typeof unit.uuid!=='string'||!uuidPattern.test(unit.uuid)||!text(unit.name,200)||!Number.isSafeInteger(unit.gram)||unit.gram<=0||unit.gram>100000){warnings.push('invalid-portion-omitted');continue}
   const portionId='wger-'+unit.uuid.toLowerCase()
   if(portions.some(p=>p.id===portionId)){issues.push('duplicate-portion');continue}
   portions.push({id:portionId,label:text(unit.name,200),amount:unit.gram,unit:'g'})
  }
 }
 if(!author)warnings.push('original-author-unspecified')
 const provenance={provider:'wger',uuid:row.uuid,barcode,sourceName,sourceUrl,language,license:license??null,licenseMetadata:{title:text(row.license_title),author,authorUrl:safeUrl(row.license_author_url),objectUrl:safeUrl(row.license_object_url),derivativeUrl:safeUrl(row.license_derivative_source_url)}}
 if(Object.values(provenance.licenseMetadata).includes(null))issues.push('invalid-license-metadata')
 let food=null
 if(!issues.length&&Object.values(values).some(v=>v!==null)){
  const address=Number.isSafeInteger(row.id)&&row.id>0?`https://wger.de/api/v2/ingredient/${row.id}/`:`https://wger.de/api/v2/ingredient/?uuid=${row.uuid}`
  const data={schemaVersion:1,kind:'food',name,brand,reference:{amount:100,unit:'g'},nutrients:values,portions,
   source:{kind:'custom',externalId:id,url:address,license:{...license,attribution:author?`wger; ${author}`:'wger (original author not supplied)'},publicCatalogImport:provenance}}
  food={...data,id:`wger-${row.uuid}-${await contentHash(data)}`}
  if(validateFood(food).length){food=null;issues.push('engine-validation-failed')}
 }
 return{id,barcode,name,nameFr:language==='fr'?name:'',brand,commonName,language,provenance,sourceKind,nutrients:values,reference:food?.reference??null,referenceEvidence:sourceKind==='off-derived'?'wger-declared-100g-original-off-base-unavailable':'wger-model-declared-100g',nutritionValuesValid:!nutrientIssues.length&&!issues.some(v=>/^invalid-(?:energy|protein|carbohydrates|fat|fiber|sodium)/.test(v)),food,complete,issues:[...new Set(issues)],warnings:[...new Set(warnings)]}
}
