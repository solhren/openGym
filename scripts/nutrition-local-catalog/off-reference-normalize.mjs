// Isolated OFF input-set adapter. Never trust an aggregate's per for mixed sets.
import {pathToFileURL} from 'node:url'
import {normalizeProduct,inspectExternal,CatalogError} from '../../frontend/src/lib/nutrition/catalog/normalize.js'
import {contentHash} from '../../frontend/src/lib/nutrition/persistence-contract.js'
import {convertQuantity} from '../../frontend/src/lib/nutrition/calculate.js'
const fail=(ok,code)=>{if(!ok)throw new CatalogError(code)}
const required=['proteins','carbohydrates','fat'], sources=['manufacturer','packaging','usda']
const declared=n=>n&&typeof n==='object'&&!Array.isArray(n)&&n.value!=null&&n.modifier==null
const energy=set=>declared(set.nutrients?.['energy-kcal'])?'energy-kcal':declared(set.nutrients?.['energy-kj'])?'energy-kj':null
const relevantKeys=[...required,'energy-kcal','energy-kj']
const gtinValid=s=>typeof s==='string'&&/^(?:\d{8}|\d{12,14})$/.test(s)&&!/^0+$/.test(s)&&[...s.slice(0,-1)].reverse().reduce((sum,d,i)=>sum+Number(d)*(i%2?1:3),0)%10===(10-Number(s.at(-1)))%10
const object=v=>fail(v&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v))&&!Object.keys(v).some(k=>['__proto__','constructor','prototype'].includes(k)),'invalid-product')
const own=(o,k)=>{const d=Object.getOwnPropertyDescriptor(o,k);if(!d)return undefined;fail(Object.hasOwn(d,'value')&&d.enumerable,'invalid-product');return d.value}
export function projectRaw(raw){
 object(raw)
 const out={}
 for(const key of ['code','product_name','product_name_fr','generic_name','brands','schema_version','last_modified_t','no_nutrition_data','data_quality_errors_tags','product_type']){const v=own(raw,key);if(v!=null)out[key]=v}
 const nutrition=own(raw,'nutrition')
 if(nutrition!=null){
  object(nutrition)
  const sets=own(nutrition,'input_sets')
  if(sets!=null){fail(Array.isArray(sets)&&sets.length<=32,'invalid-input-sets');out.nutrition={input_sets:sets.map(s=>{
   object(s)
   const r={};for(const k of ['source','preparation','per','per_unit','per_quantity']){const v=own(s,k);if(v!=null)r[k]=v}
   const nutrients=own(s,'nutrients')
   if(nutrients!=null){object(nutrients);r.nutrients={};for(const k of relevantKeys){const v=own(nutrients,k);if(v!=null)r.nutrients[k]=v}}
   return r
  })}}
 }
 inspectExternal(out);return out
}
function errorsFor(errors,set){
 return errors.filter(tag=>{
  if(!/^en:(nutrition-|energy-)/.test(tag))return false
  const m=/^en:nutrition-(manufacturer|packaging|usda|estimate)-(as-sold|prepared)-(100g|100ml|serving|1kg|1l)-/.exec(tag)
  if(m)return m[1]===set.source&&m[2]==='as-sold'&&m[3]===set.per
  // A missing serving quantity is irrelevant to an explicit 100 g/ml input.
  if(tag==='en:nutrition-data-per-serving-missing-serving-size')return false
  return true // Unscoped/unknown nutrition errors remain blocking.
 })
}
export async function normalizeReference(raw,evidence){
 const p=projectRaw(raw);inspectExternal(evidence)
 fail(evidence&&['raw-jsonl','api-v3.5','fixture'].includes(evidence.kind)&&/^[a-f0-9]{64}$/.test(evidence.rowSha256),'invalid-evidence')
 fail(typeof p.code==='string'&&/^(?:\d{8}|\d{12,14})$/.test(p.code)&&!/^0+$/.test(p.code),'invalid-barcode')
 fail(p.schema_version==null||(Number.isInteger(p.schema_version)&&p.schema_version>=0&&p.schema_version<=1004),'unsupported-product-schema')
 fail(!['1','on',1,true].includes(p.no_nutrition_data),'no-nutrition-data')
 fail(p.product_type==null||p.product_type==='food','nonfood-product')
 const errors=p.data_quality_errors_tags??[];fail(Array.isArray(errors)&&errors.every(s=>typeof s==='string'),'invalid-quality')
 const sets=p.nutrition?.input_sets??[];fail(sets.length>0,'original-input-sets-unavailable')
 const candidates=[],rejected=[]
 for(let index=0;index<sets.length;index++){
  const set=sets[index]
  try{
   fail(sources.includes(set.source)&&set.preparation==='as_sold'&&['100g','100ml'].includes(set.per),'unsupported-or-estimated-reference')
   const unit=set.per==='100g'?'g':'ml'
   fail((set.per_unit==null||set.per_unit===unit)&&(set.per_quantity==null||set.per_quantity===100),'contradictory-reference')
   fail(errorsFor(errors,set).length===0,'source-scoped-quality-error')
   const ek=energy(set);fail(ek,'explicit-energy-missing');const ns={}
   for(const key of [...required,ek]){
    const n=set.nutrients?.[key];fail(declared(n),'missing-or-qualified-value')
    fail(n.unit===(key==='energy-kcal'?'kcal':key==='energy-kj'?'kJ':'g'),'incompatible-nutrient-unit');ns[key]={value:n.value,unit:n.unit,source:set.source}
   }
   // Keep both explicitly declared energies for the existing consistency check.
   for(const k of ['energy-kcal','energy-kj'])if(declared(set.nutrients?.[k])){const n=set.nutrients[k];fail(n.unit===(k==='energy-kcal'?'kcal':'kJ'),'incompatible-nutrient-unit');ns[k]={value:n.value,unit:n.unit,source:set.source}}
   const slice={code:p.code,product_name:p.product_name_fr||p.product_name||p.generic_name,brands:p.brands??'',nutrition:{aggregated_set:{preparation:'as_sold',per:set.per,nutrients:ns}}}
   const product=await normalizeProduct(slice,{expectedCode:p.code,requireExplicitReference:true,requireAggregatedReference:true})
   fail(product.code===p.code||(gtinValid(p.code)&&gtinValid(product.code)&&p.code.padStart(14,'0')===product.code.padStart(14,'0')),'untrusted-barcode-alias')
   fail(product.food&&['kcal','protein','carbs','fat'].every(k=>product.food.nutrients[k]!=null),'incomplete-food')
   fail(['kcal','protein','carbs','fat'].some(k=>product.food.nutrients[k]>0),'zero-only-needs-review')
   // Test dimension compatibility with the existing core, never assume density.
   fail(convertQuantity(100,unit,product.food.reference.unit)===100,'incompatible-reference')
   candidates.push({index,set,product})
  }catch(e){if(!(e instanceof CatalogError))throw e;rejected.push({index,reason:e.code})}
 }
 if(candidates.length===0)throw new CatalogError('no-usable-input-set',{rejectedInputSets:rejected})
 const signatures=new Set(candidates.map(c=>JSON.stringify({reference:c.product.food.reference,nutrients:c.product.food.nutrients})))
 fail(signatures.size===1,'conflicting-valid-input-sets')
 // Identical complete sets coalesce; standard OFF source priority only selects
 // provenance, never a winner between conflicting nutritional values.
 candidates.sort((a,b)=>sources.indexOf(a.set.source)-sources.indexOf(b.set.source)||a.index-b.index)
 const c=candidates[0],food=c.product.food
 const lineage={policy:'coherent-as-sold-input-set-v1',originalCode:p.code,per:c.set.per,source:c.set.source,inputIndex:c.index,preparation:'as_sold',...evidence,
  ...(p.last_modified_t!=null?{lastModified:p.last_modified_t}:{}),qualityErrors:errors,rejectedInputSets:rejected}
 const value={...food,source:{...food.source,offReference:lineage}};delete value.id
 const final={...value,id:`off-${c.product.code}-${await contentHash(value)}`}
 return {code:p.code,reference:final.reference,food:final,lineage,normalizedFromInput:true,sourceKind:evidence.kind}
}
// Sequential, bounded IPC worker for the Python streaming builder; no network.
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 let buffer=''
 process.stdin.setEncoding('utf8')
 try{
  for await(const chunk of process.stdin){buffer+=chunk.toString('utf8');fail(Buffer.byteLength(buffer)<=256*1024,'input-line-limit')
   let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1)
    try{const {product,evidence}=JSON.parse(line);const result=await normalizeReference(product,evidence);process.stdout.write(JSON.stringify({ok:true,...result})+'\n')}
    catch(e){process.stdout.write(JSON.stringify({ok:false,code:e.code??'invalid-product',...(Array.isArray(e.rejectedInputSets)?{rejectedInputSets:e.rejectedInputSets}:{})})+'\n')}
   }
  }
  fail(buffer.length===0,'truncated-input-line')
 }catch(e){console.error(e.code??'normalizer-failed');process.exitCode=1}
}
