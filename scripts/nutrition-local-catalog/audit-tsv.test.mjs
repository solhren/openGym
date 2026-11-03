import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
import {auditSample} from './audit-tsv.mjs'
const base=fileURLToPath(new URL('./artifacts/',import.meta.url))
function fixture(t){
  const root=fs.mkdtempSync(path.join(base,'audit-tsv-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}))
  const body='code\tproduct_name\tbrands\tcountries_tags\tenergy-kcal_100g\tproteins_100g\tcarbohydrates_100g\tfat_100g\n00012345\t"Synthetic identity\tExample\ten:france\t42.125\t0\t3.5\t\n'
  fs.writeFileSync(path.join(root,'sample.tsv'),body)
  const manifest={format:'opengym-off-tsv-sample',version:1,complete:true,rows:1,columns:body.split('\n')[0].split('\t'),sampleBytes:Buffer.byteLength(body),sampleSha256:createHash('sha256').update(body).digest('hex'),source:'https://static.openfoodfacts.org/data/en.openfoodfacts.org.products.csv.gz'}
  const file=path.join(root,'sample-manifest.json');fs.writeFileSync(file,JSON.stringify(manifest))
  return {root,file,manifest}
}
test('actual TSV parser and engine audit missing unit while preserving source cells for diagnosis',async t=>{
  const f=fixture(t),r=await auditSample(f.file)
  assert.equal(r.counts.accepted,1);assert.equal(r.counts.unusable,1);assert.equal(r.counts.france,1);assert.equal(r.counts.leadingZeroCodes,1)
  assert.deepEqual(r.profile.nutritionReferenceColumns,[]);assert.equal(r.examples[0].rawNutrientCells['energy-kcal_100g'],'42.125')
  assert.equal(r.examples[0].nutrients.kcal,null);assert.equal(r.representative,false)
})
test('audit rejects incomplete receipt, bad hashes, counts and invented header',async t=>{
  const f=fixture(t)
  for(const changes of [{complete:false},{sampleSha256:'0'.repeat(64)},{rows:2},{columns:['code','product_name','nutrition_data_per']}]){
    fs.writeFileSync(f.file,JSON.stringify({...f.manifest,...changes}));await assert.rejects(auditSample(f.file))
  }
})
