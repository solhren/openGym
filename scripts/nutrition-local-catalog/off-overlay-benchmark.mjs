// Prepared French labels over EXISTING trustworthy foods, never a base rewrite.
// Labels are curated candidate translations, not supplier-provided French names.
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawn} from 'node:child_process'
import {validateFood} from '../../frontend/src/lib/nutrition/validate.js'
import {inspectExternal} from '../../frontend/src/lib/nutrition/catalog/normalize.js'
import {journalProof} from './wger-evaluate.mjs'
const check=(ok,code)=>{if(!ok)throw Error(code)}
export const selections=[
 ['Banane crue','banane','wger:c3987476-51eb-4afb-afa2-36d92b2fc8e1','Bananas, raw'],
 ['Œuf entier cru frais','œuf oeuf oeufs','wger:9694972b-c2c4-4cb2-b666-d0c6df00675f','Egg, whole, raw, fresh'],
 ['Lait entier enrichi en vitamine D — pour 100 g','lait','wger:6fd49379-2a1f-4f6d-b647-176bb669b6c5','Vitamin D Whole Milk'],
 ['Riz blanc à grain moyen cru non enrichi','riz','wger:313767d3-1b45-4500-97dc-123850dd6880','Rice, white, medium-grain, raw, unenriched'],
 ['Pâtes sèches non enrichies','pâtes','wger:84ca8c12-4038-4364-9a6d-93f819a6fb53','Pasta, Dry, Unenriched'],
 ['Yaourt nature au lait entier','yaourt','wger:ac9b9414-345b-428a-bcf7-5b56ef621e83','Yogurt, Plain, Whole Milk'],
 ['Blanc de poulet cru sans peau et sans os','poulet','wger:0de299b7-0ced-4a14-a5b3-78887012ed52','Chicken, Broiler Or Fryers, Breast, Skinless, Boneless, Meat Only, Raw']
]
export function selectFoods(report){
 inspectExternal(report)
 check(report.complete===true&&/^[a-f0-9]{64}$/.test(report.baseSha256),'invalid-analysis-report')
 const candidates=report.genericBenchmark.flatMap(v=>v.candidates)
 return selections.map(([label,terms,id,name])=>{
  const p=candidates.find(v=>v.id===id)
  check(p&&p.name===name&&p.food&&p.brand===''&&p.food.name===name,'semantic-selection-changed')
  check(validateFood(p.food).length===0&&p.food.reference.amount===100&&p.food.reference.unit==='g'&&['kcal','protein','carbs','fat'].every(k=>p.food.nutrients[k]!==null&&p.food.nutrients[k]!==undefined),'unusable-source-food')
  return {label,terms,id,food:p.food,translation:'candidate prepared by openGym; not an original French supplier label',license:p.food.source.license}
 })
}
export async function benchmark(inputName,outputName){
 check([inputName,outputName].every(v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,40}$/.test(v))&&inputName!==outputName,'invalid-workspace')
 const base=fileURLToPath(new URL('./artifacts/',import.meta.url)),input=path.join(base,inputName,'report.json'),root=path.join(base,outputName)
 check(!fs.lstatSync(path.dirname(input)).isSymbolicLink()&&!fs.lstatSync(input).isSymbolicLink()&&fs.statSync(input).size<=512*1024,'unsafe-report')
 const report=JSON.parse(fs.readFileSync(input)),aliases=selectFoods(report);fs.mkdirSync(root,{mode:0o700})
 const proofs=[]
 for(const p of aliases)proofs.push({label:p.label,id:p.id,...await journalProof(p.food)})
 // The source names, nutritional values, IDs and licence data remain unchanged.
 const measured=await new Promise((resolve,reject)=>{
  const child=spawn('python3',[fileURLToPath(new URL('./off-alias-index.py',import.meta.url)),outputName],{stdio:['pipe','pipe','pipe']});let output=''
  child.stdout.on('data',b=>{output+=b;if(output.length>65536)child.kill()});child.stderr.on('data',()=>{});child.on('error',reject);child.on('close',code=>code===0?resolve(JSON.parse(output)):reject(Error('alias-benchmark-failed')))
  child.stdin.end(JSON.stringify(aliases.map(p=>({id:p.id,label:p.label,terms:p.terms,foodId:p.food.id,license:p.license}))))
 })
 const result={complete:true,source:'real existing wger foods; seven proposed French aliases',baseSha256:report.baseSha256,applicationActivated:false,nutritionChanged:false,networkCalls:0,foodProofs:proofs,...measured}
 fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(result,null,2),{flag:'wx'});return result
}
if(process.argv[1]===fileURLToPath(import.meta.url))benchmark(...process.argv.slice(2)).then(r=>console.log(JSON.stringify(r,null,2))).catch(e=>{console.error(e.message);process.exitCode=1})
