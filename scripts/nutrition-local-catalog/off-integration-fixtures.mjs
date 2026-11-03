// Test-only, deterministic declared input sets. No Internet or production data.
import {normalizeReference} from './off-reference-normalize.mjs'
import {catalogBarcodeKey} from '../../api/shared/nutrition-catalog-identity.js'
export async function referenceFixture(kind='drink') {
 const values=kind==='spread'?{code:'3017620422003',name:'Nutella',brand:'Ferrero',unit:'g',energy:539,protein:6.3,carbs:57.5,fat:30.9}
  :kind==='milk'?{code:'3250392190484',name:'Lait nature',brand:'Fixture',unit:'ml',energy:41,protein:3.2,carbs:4.8,fat:1}
  :{code:'5449000000996',name:'Coca-Cola',brand:'Coca-Cola',unit:'ml',energy:43.021032504780116,protein:0,carbs:10.6,fat:0}
 const raw={code:values.code,product_name:values.name,brands:values.brand,nutrition:{input_sets:[{source:'packaging',preparation:'as_sold',per:values.unit==='g'?'100g':'100ml',per_unit:values.unit,per_quantity:100,
  nutrients:Object.fromEntries([['energy-kcal',values.energy,'kcal'],['proteins',values.protein,'g'],['carbohydrates',values.carbs,'g'],['fat',values.fat,'g']].map(([k,value,unit])=>[k,{value,unit}]))}]}}
 const result={ok:true,...await normalizeReference(raw,{kind:'raw-jsonl',rowSha256:'a'.repeat(64),captureSha256:'b'.repeat(64),captureConflict:false})},food=result.food
 const record={id:'off:'+catalogBarcodeKey(values.code),code:values.code,name:food.name,brand:food.brand,language:null,food,reference:food.reference,validationStatus:'validated',issues:[],warnings:[],source:food.source}
 return {raw,result,record}
}
