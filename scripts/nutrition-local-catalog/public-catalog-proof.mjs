// Optional developer check using the actual application DTO, validators and
// quantity engine. No provider calls, account store, dependencies or DB writes.
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import path from 'node:path'
import {createInterface} from 'node:readline'
import {normalizeLocalProduct} from '../../frontend/src/lib/nutrition/catalog/local-product.js'
import {validateFood} from '../../api/nutrition/core/validate.js'
import {nutrientsForQuantity} from '../../api/nutrition/core/calculate.js'

const directory=process.argv[2]
assert.ok(directory,'Usage: node public-catalog-proof.mjs GENERATION_DIRECTORY')
const scripts=fileURLToPath(new URL('.',import.meta.url))
const program=`import importlib.util,json,resource,sqlite3,sys
from pathlib import Path
resource.setrlimit(resource.RLIMIT_AS,(128*1024**2,128*1024**2))
s=importlib.util.spec_from_file_location('bootstrap',Path(sys.argv[1])/'public-bootstrap.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
root=Path(sys.argv[2]);manifest=m.inspect_generation(root)
print(json.dumps({'manifest':manifest}),flush=True)
c=sqlite3.connect((root/manifest['file']).resolve().as_uri()+'?mode=ro&immutable=1',uri=True)
try:
 for(payload,)in c.execute('SELECT payload FROM foods ORDER BY rowid'):
  for language in ('fr','en'):print(m.canonical(m.localize_record(json.loads(payload),language)),flush=True)
finally:c.close()
`
const child=spawn('python3',['-c',program,scripts,path.resolve(directory)],{stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,PYTHONDONTWRITEBYTECODE:'1',PYTHONNOUSERSITE:'1'}})
let errorText=''
child.stderr.setEncoding('utf8');child.stderr.on('data',value=>{errorText+=value;if(errorText.length>16384)child.kill('SIGKILL')})
const completed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>code===0?resolve():reject(Error(errorText||'public-catalogue-proof-failed')))})
const timer=setTimeout(()=>child.kill('SIGKILL'),30000)
const variants={fr:0,en:0},seen=new Set();let manifest,total=0,addable=0,partial=0,rejected=0
try {
 for await(const line of createInterface({input:child.stdout,crlfDelay:Infinity})) {
  assert.ok(Buffer.byteLength(line)<=16384)
  const value=JSON.parse(line)
  if(!manifest){manifest=value.manifest;assert.equal(manifest.provider,'ciqual');continue}
  assert.ok(++total<=8000)
  const product=normalizeLocalProduct(value)
  variants[product.language]++;seen.add(product.id)
  if(!product.food){assert.equal(product.validationStatus,'needs-verification');rejected++;continue}
  assert.deepEqual(validateFood(product.food),[])
  const whole=nutrientsForQuantity(product.food,{amount:100,unit:'g'}),half=nutrientsForQuantity(product.food,{amount:50,unit:'g'})
  for(const key of ['kcal','protein','carbs','fat']) {
   assert.equal(whole[key],product.food.nutrients[key])
   assert.equal(half[key],product.food.nutrients[key]===null?null:product.food.nutrients[key]/2)
  }
  assert.throws(()=>nutrientsForQuantity(product.food,{amount:50,unit:'ml'}))
  addable++;if(product.validationStatus==='partial')partial++
 }
 await completed
 assert.equal(seen.size,manifest.rows);assert.equal(total,manifest.rows*2)
 assert.equal(addable,manifest.usableFoodCount*2);assert.equal(rejected,manifest.rejectedFoodCount*2)
 console.log(JSON.stringify({uniqueSourceFoods:seen.size,localeVariantsChecked:total,variants,uniqueCompleteFoods:manifest.completeFoodCount,uniquePartialFoods:partial/2,uniqueAddableFoods:manifest.usableFoodCount,uniqueUnusableFoods:manifest.rejectedFoodCount,applicationDtoValidation:true,applicationFoodValidation:true,wholeAndHalfGramCalculations:true,volumeRejectedWithoutDensity:true,externalFoodRequests:0,catalogueSha256:manifest.sha256}))
} catch(error) {
 child.kill('SIGKILL');await completed.catch(()=>{});throw error
} finally {clearTimeout(timer)}
