import test from 'node:test'
import assert from 'node:assert/strict'
import {selections,selectFoods} from './off-overlay-benchmark.mjs'
const report=()=>({complete:true,baseSha256:'0'.repeat(64),genericBenchmark:[{candidates:selections.map(([, ,id,name],index)=>({id,name,brand:'',food:{schemaVersion:1,kind:'food',id:'synthetic-'+index,name,reference:{amount:100,unit:'g'},nutrients:{kcal:100,protein:3,carbs:10,fat:4},portions:[],source:{kind:'custom',license:{id:'CC0-1.0',url:'https://creativecommons.org/publicdomain/zero/1.0/',attribution:'Synthetic fixture'}}}}))}]})
test('curated labels preserve original snapshots, IDs, units and licences',()=>{
 const input=report(),copy=structuredClone(input),rows=selectFoods(input);assert.equal(rows.length,7);assert.deepEqual(input,copy)
 rows.forEach((v,index)=>{assert.equal(v.food.name,selections[index][3]);assert.equal(v.food.reference.unit,'g');assert.equal(v.license.id,'CC0-1.0')})
})
test('changed source identity, missing macros and ml cannot silently become curated grams',()=>{
 for(const change of [p=>p.name='Other preparation',p=>p.food.nutrients.protein=null,p=>p.food.reference.unit='ml',p=>p.food.nutrients.fat=-1]){
  const input=report();change(input.genericBenchmark[0].candidates[0]);assert.throws(()=>selectFoods(input))
 }
})
test('incomplete or unsafe reports cannot become benchmark foods',()=>{
 assert.throws(()=>selectFoods({...report(),complete:false}));assert.throws(()=>selectFoods(Object.assign(Object.create({complete:true}),report())))
})
