// Bounded sample only, not a complete-dump parser or an application route.
// Verify the capture receipt, schema and actual projection through the real engine.
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawn} from 'node:child_process'
import {createHash} from 'node:crypto'
import {Transform} from 'node:stream'
import {pipeline} from 'node:stream/promises'
import {jsonLines} from './build.mjs'
import {projectTsv,normalizeRecord} from './normalize.mjs'
const directory=fileURLToPath(new URL('.',import.meta.url)),base=fs.realpathSync(path.join(directory,'artifacts'))
const fail=(condition,code)=>{if(!condition)throw Error(code)}
export async function auditSample(manifestFile){
  const root=path.dirname(fs.realpathSync(manifestFile));fail(root.startsWith(base+path.sep)&&!fs.lstatSync(manifestFile).isSymbolicLink(),'unsafe-sample')
  fail(fs.statSync(manifestFile).size<=65536,'oversized-receipt')
  const m=JSON.parse(fs.readFileSync(manifestFile,'utf8'))
  fail(m.format==='opengym-off-tsv-sample'&&m.version===1&&m.complete===true&&Number.isSafeInteger(m.rows)&&m.rows>0&&m.rows<=20000&&Array.isArray(m.columns)&&m.columns.length<=512&&m.columns.every(k=>typeof k==='string'&&k.length>0&&k.length<=120)&&new Set(m.columns).size===m.columns.length&&/^[a-f0-9]{64}$/.test(m.sampleSha256),'invalid-sample-receipt')
  const file=path.join(root,'sample.tsv');fail(!fs.lstatSync(file).isSymbolicLink()&&fs.statSync(file).size===m.sampleBytes&&m.sampleBytes<=64*1024**2,'invalid-sample-size')
  const fd=fs.openSync(file,'r');let header
  try{const buffer=Buffer.alloc(1024*1024+1),length=fs.readSync(fd,buffer,0,buffer.length,0),end=buffer.subarray(0,length).indexOf(10);fail(end>=0&&end<=1024*1024,'invalid-header');header=new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,end)).replace(/\r$/,'').split('\t')}finally{fs.closeSync(fd)}
  fail(JSON.stringify(header)===JSON.stringify(m.columns),'sample-header-mismatch')
  const child=spawn('python3',[path.join(directory,'tsv.py')],{stdio:['pipe','pipe','inherit']})
  child.stdin.on('error',()=>{})
  const ended=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>code===0?resolve():reject(Error('tsv-parser-failed'))) });ended.catch(()=>{})
  const hash=createHash('sha256');let size=0
  const checksum=new Transform({transform(chunk,_,cb){size+=chunk.length;if(size>64*1024**2)return cb(Error('sample-too-large'));hash.update(chunk);cb(null,chunk)}})
  const flowing=pipeline(fs.createReadStream(file),checksum,child.stdin);flowing.catch(()=>{})
  const columns=m.columns, seen=new Set(), counts={rows:0,accepted:0,rejected:0,complete:0,partial:0,unusable:0,ambiguousReference:0,nutritionRejected:0,rawFourValues:0,france:0,leadingZeroCodes:0,duplicates:0}
  const reasons={},units={},examples=[];let normalizedBytes=0
  const start=performance.now()
  try{
    for await(const line of jsonLines(child.stdout)){
      const raw=JSON.parse(line);counts.rows++;fail(counts.rows<=m.rows,'unexpected-row-count')
      if(['energy-kcal_100g','proteins_100g','carbohydrates_100g','fat_100g'].every(k=>typeof raw[k]==='string'&&raw[k].trim()))counts.rawFourValues++
      try{
        const projected=projectTsv(raw),record=await normalizeRecord(projected.raw,projected)
        counts.accepted++;if(projected.ambiguousReference)counts.ambiguousReference++;if(record.warnings.includes('nutrition-rejected'))counts.nutritionRejected++
        const known=Object.values(record.nutrients).filter(v=>v!==null).length;counts[known===4?'complete':known?'partial':'unusable']++
        units[record.reference?.unit??'unknown']=(units[record.reference?.unit??'unknown']??0)+1
        if(record.countries.includes('en:france'))counts.france++
        if(record.code.startsWith('0'))counts.leadingZeroCodes++
        if(seen.has(record.code))counts.duplicates++;seen.add(record.code)
        normalizedBytes+=Buffer.byteLength(JSON.stringify(record))
        if(examples.length<10)examples.push({code:record.code,name:record.name,reference:record.reference,nutrients:record.nutrients,warnings:record.warnings,rawNutrientCells:Object.fromEntries(['energy-kcal_100g','energy-kj_100g','energy_100g','proteins_100g','carbohydrates_100g','fat_100g'].filter(k=>Object.hasOwn(raw,k)).map(k=>[k,raw[k]])),rawValuesNotValidatedForJournal:true})
      }catch(error){if(!error.code)throw error;counts.rejected++;reasons[error.code]=(reasons[error.code]??0)+1}
    }
    await flowing;await ended
    fail(counts.rows===m.rows&&hash.digest('hex')===m.sampleSha256,'sample-integrity-mismatch')
    return {source:m.source,finalUrl:m.finalUrl,etag:m.etag,s3VersionId:m.s3VersionId,sourceCompressedBytes:m.sourceCompressedBytes,sampleSha256:m.sampleSha256,representative:false,columns,profile:{brandColumns:columns.filter(k=>['brands','brands_tags','brands_en','brands_fr'].includes(k)),localizedNameColumns:columns.filter(k=>/^product_name_[a-z]/.test(k)),nutritionReferenceColumns:columns.filter(k=>['nutrition_data_per','product_quantity_unit','serving_quantity_unit'].includes(k)),nutritionValueColumns:columns.filter(k=>['energy-kcal_100g','energy-kj_100g','energy_100g','proteins_100g','carbohydrates_100g','fat_100g'].includes(k)),qualityColumns:columns.filter(k=>/^data_quality|^no_nutrition_data$|^completeness$/.test(k)),modifierColumns:columns.filter(k=>k.endsWith('_modifier'))},counts,units,reasons,normalizedBytes,meanNormalizedBytes:counts.accepted?normalizedBytes/counts.accepted:null,seconds:(performance.now()-start)/1000,nodePeakRssKiB:process.resourceUsage().maxRSS,examples}
  }finally{checksum.destroy();child.stdin.destroy();if(child.exitCode===null)child.kill();await flowing.catch(()=>{});await ended.catch(()=>{})}
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  try{fail(process.argv.length===3,'invalid-audit-arguments');console.log(JSON.stringify(await auditSample(process.argv[2]),null,2))}
  catch(error){console.error(JSON.stringify({error:error.code??error.message}));process.exitCode=1}
}
