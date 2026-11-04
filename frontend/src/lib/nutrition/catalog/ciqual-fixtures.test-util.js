// Synthetic records using the public source contract; not copied food values.
export const ciqualCapabilities={schemaVersion:2,textSearch:'local',provider:'ciqual',selection:'local-only',productIds:true}
export function ciqualRecord(language='fr') {
  const names={fr:'Lait de test',en:'Test milk'},id='ciqual:00123'
  const license={id:'Etalab-2.0',url:'https://spdx.org/licenses/etalab-2.0.html',attribution:'Anses. Ciqual 2025. Synthetic test record.'}
  const source={provider:'ciqual',foodCode:'00123',version:'2025',sourceName:'Anses — Ciqual 2025',sourceUrl:'https://doi.org/10.57745/RDMHWY',sourceSha256:'a'.repeat(64),namesSourceSha256:'b'.repeat(64),names,license}
  const food={schemaVersion:1,kind:'food',id:`ciqual-00123-${language}-revision`,name:names[language],brand:'',reference:{amount:100,unit:'g'},nutrients:{kcal:46.5,protein:3.2,carbs:4.8,fat:1.6},portions:[],source:{kind:'custom',externalId:id,url:source.sourceUrl,license,publicCatalogImport:source}}
  return {id,code:null,name:food.name,brand:'',language,food,reference:food.reference,validationStatus:'validated',issues:[],warnings:[],source}
}
