// Synthetic transport fixture, not a claim about an OFF product or real registry IDs.
export const localId='wger:12345678-1234-1234-1234-123456789abc'
export const localCapabilities={schemaVersion:2,textSearch:'local',provider:'wger',selection:'local-only',productIds:true}
export function localRecord() {
  const license={id:'CC0-1.0',url:'https://creativecommons.org/publicdomain/zero/1.0/'}
  const source={provider:'wger',uuid:localId.slice(5),barcode:'00012345',sourceName:'USDA',sourceUrl:'https://fdc.nal.usda.gov/',language:'en',license,licenseMetadata:{title:'Rice',author:'USDA',authorUrl:'',objectUrl:'',derivativeUrl:''}}
  const food={schemaVersion:1,kind:'food',id:'local-fixture-food',name:'Rice, raw',brand:'',reference:{amount:100,unit:'g'},nutrients:{kcal:350.6,protein:7.123,carbs:75.5,fat:1.25},portions:[],source:{kind:'custom',externalId:localId,url:'https://wger.de/api/v2/ingredient/1/',license:{...license,attribution:'wger; USDA'},publicCatalogImport:source}}
  return {id:localId,code:'00012345',name:'Riz cru',brand:'',language:'en',food,reference:food.reference,validationStatus:'validated',issues:[],warnings:[],source,originalName:food.name,translation:{language:'fr',author:'openGym',status:'curated-search-label',originalName:food.name}}
}
export const localBody=body=>({format:'opengym-local-food-catalog',schemaVersion:1,...body})
export const localSearchBody=()=>localBody({products:[localRecord()],count:1,page:1,pageSize:20,literalOnly:true,registryVerified:true,catalogueVersion:'a'.repeat(64)})
