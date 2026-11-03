// Offline check of a REAL captured OFF v3.5/API response, no provider calls.
// Runs the real normalizer, UI command service and persistence on OWN temp files.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { normalizeProduct, inspectExternal, barcode } from '../../frontend/src/lib/nutrition/catalog/normalize.js'
import { createNutritionLocalStore } from '../../frontend/src/lib/nutrition/local-store.js'
import { nutritionFsBackend } from '../../frontend/src/lib/nutrition/local-store-fs.js'
import { createNutritionUISession } from '../../frontend/src/lib/nutrition/ui-session.js'
import { diskBridge } from '../../frontend/src/lib/nutrition/local-storage.test-util.js'
import { sumFoodEntries } from '../../frontend/src/lib/nutrition/calculate.js'
const [file, code] = process.argv.slice(2)
assert.ok(file && code && process.argv.length === 4,'usage: node check-off-journal.mjs response.json barcode')
barcode(code)
const input=await fs.open(file,'r');let payload
try {
 assert.ok((await input.stat()).isFile());const buffer=Buffer.alloc(1024*1024+1),{bytesRead}=await input.read(buffer,0,buffer.length,0)
 assert.ok(bytesRead<=1024*1024,'response >1 MiB');payload=JSON.parse(buffer.subarray(0,bytesRead).toString('utf8'));inspectExternal(payload)
} finally { await input.close() }
assert.ok(['success','success_with_warnings'].includes(payload.status),'OFF/API did not return a successful product')
const product=await normalizeProduct(payload.product,{language:'fr',expectedCode:code,requireExplicitReference:true,requireAggregatedReference:true})
assert.ok(product.food,'no trustworthy as-sold 100g/100ml aggregate: STOP, do not invent a reference')
const food=product.food,macroKeys=['kcal','protein','carbs','fat']
for(const key of macroKeys)assert.notEqual(food.nutrients[key],null,`missing ${key}: not a complete-macro validation`)
const disk=await diskBridge();let store,service
const namespace={serverOrigin:null,profileId:'off-v1-verification'},generation='off-v1-verification'
const options={namespace,generation,deviceId:'off-v1-check',backend:nutritionFsBackend({loadPlugin:async()=>disk.plugin})}
const session={userId:namespace.profileId,serverOrigin:null,epoch:1}
try {
 store=await createNutritionLocalStore(options)
 service=createNutritionUISession({store,session,getSession:()=>session,online:()=>false})
 const entry={schemaVersion:1,id:randomUUID(),d:'2026-10-12',meal:'lunch',snapshot:food,quantity:{amount:50,unit:food.reference.unit}}
 await service.batch([{collection:'savedFoods',id:food.id,value:food,base:null},{collection:'foodEntries',id:entry.id,value:entry,base:null}])
 assert.ok(service.getSnapshot().pending>0,'offline queue was lost')
 service.close();service=null
 store=await createNutritionLocalStore({...options,backend:nutritionFsBackend({loadPlugin:async()=>disk.plugin})})
 const day=await store.readDay(entry.d);assert.equal(day.entries.length,1);assert.deepEqual(day.entries[0].snapshot.nutrients,food.nutrients)
 const totals=sumFoodEntries(day.entries).totals
 for(const key of macroKeys)assert.equal(totals[key],food.nutrients[key]*.5)
 assert.ok((await store.inspect()).manifest.pendingOperations.length>0)
 console.log(JSON.stringify({passed:true,code:product.code,name:product.name,reference:food.reference,per100:food.nutrients,quantity:entry.quantity,logged:totals,reopened:true,pendingPreserved:true,storage:'isolated temporary files; native bridge simulator, not device validation'},null,2))
} finally { service?.close();store?.close();await disk.cleanup() }
