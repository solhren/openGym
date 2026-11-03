import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { combine } from './combine-sample.mjs'
// Do not import a test module to reuse fixtures: it would register its tests twice.
const features = [{ name:'code',type:{dtype:'string'} }, {name:'product_name',type:{_type:'List',feature:{lang:{dtype:'string'},text:{dtype:'string'}}}}, {name:'nutriments',type:{_type:'List',feature:{name:{dtype:'string'},'100g':{dtype:'float32'},serving:{dtype:'float32'}}}}]
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = v => JSON.stringify((function sort(v){return Array.isArray(v)?v.map(sort):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])])):v})(v))
function setup(t) {
  const base = fileURLToPath(new URL('./artifacts/',import.meta.url)); fs.mkdirSync(base,{recursive:true})
  const root=fs.mkdtempSync(path.join(base,'combine-test-')); t.after(()=>fs.rmSync(root,{recursive:true,force:true}))
  const manifest = {format:'opengym-hf-sample',version:1,complete:true,source:'https://huggingface.co/datasets/openfoodfacts/product-database',license:'ODbL-1.0',contentLicense:'DbCL-1.0',rows:2,totalRowsReported:100,bytes:0,schemaSha256:hash(canonical(features)),pages:[]}
  for(let i=0;i<2;i++) {
    const body=JSON.stringify({features,partial:false,num_rows_total:100,num_rows_per_page:100,rows:[{row_idx:i*30,truncated_cells:[],row:{code:'0001234'+i,product_name:[{lang:'fr',text:'Pâtes'}],nutrition_data_per:'100g',nutriments:null}}]})
    const name=`page-00${i}.json`; fs.writeFileSync(path.join(root,name),body)
    manifest.bytes+=Buffer.byteLength(body); manifest.pages.push({file:name,bytes:Buffer.byteLength(body),sha256:hash(body),rows:1})
  }
  const file=path.join(root,'sample-manifest.json'),output=path.join(root,'products.jsonl')
  const save=()=>fs.writeFileSync(file,JSON.stringify(manifest)); save()
  return {root,manifest,file,output,save}
}
test('verified multi-page capture converts without loading the entire sample',async t=>{
  const f=setup(t), result=await combine(f.file,f.output)
  assert.equal(result.projected,2); assert.equal(result.classes.unusable,2)
  assert.equal(hash(fs.readFileSync(f.output)),result.jsonlSha256)
  await assert.rejects(combine(f.file,f.output))
})
test('aborted captures, checksum changes, schema drift and unsafe file paths never publish',async t=>{
  const f=setup(t)
  for(const mutate of [m=>m.complete=false,m=>m.pages[0].sha256='0'.repeat(64),m=>m.schemaSha256='0'.repeat(64),m=>m.pages[0].file='../elsewhere',m=>m.rows=3]){
    const before=structuredClone(f.manifest); mutate(f.manifest); f.save()
    await assert.rejects(combine(f.file,f.output)); assert.equal(fs.existsSync(f.output),false)
    for(const key of Object.keys(f.manifest)) delete f.manifest[key]; Object.assign(f.manifest,before)
  }
})
test('duplicate global row indices across valid pages fail rather than double-count',async t=>{
  const f=setup(t), page=f.manifest.pages[1], source=path.join(f.root,page.file)
  const data=JSON.parse(fs.readFileSync(source)); data.rows[0].row_idx=0
  const body=JSON.stringify(data); fs.writeFileSync(source,body); page.sha256=hash(body); f.manifest.bytes+=Buffer.byteLength(body)-page.bytes; page.bytes=Buffer.byteLength(body); f.save()
  await assert.rejects(combine(f.file,f.output),{code:'duplicate-sample-row'})
  assert.equal(fs.existsSync(f.output),false)
})
