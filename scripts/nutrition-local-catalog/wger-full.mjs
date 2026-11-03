/** Full-dump maintenance import, isolated from the running app and user storage.
 * One bounded row at a time. Pipe backpressure bounds the Python writer queue.
 * No end receipt on CRC/hash/child failure means no published generation.
 */
import fs from 'node:fs'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {Transform} from 'node:stream'
import {pipeline} from 'node:stream/promises'
import {createGunzip} from 'node:zlib'
import {fileURLToPath} from 'node:url'
import {jsonLines} from './build.mjs'
import {createWgerNormalizer} from './wger-normalize.mjs'
import {repositoryRegistry} from './wger-registry.mjs'
import {inspectExternal} from '../../frontend/src/lib/nutrition/catalog/normalize.js'
const directory=fileURLToPath(new URL('.',import.meta.url)),base=path.join(directory,'artifacts')
const check=(ok,code)=>{if(!ok)throw Error(code)}
const safe=name=>typeof name==='string'&&/^[A-Za-z0-9_-]{1,40}$/.test(name)
const sha=b=>createHash('sha256').update(b).digest('hex')
function copyUnsealed(source,target){
 const size=fs.statSync(source).size
 const guard=remaining=>{
  const disk=fs.statfsSync(path.dirname(target)),available=Number(/^MemAvailable:\s+(\d+)/m.exec(fs.readFileSync('/proc/meminfo','utf8'))?.[1])*1024
  check(disk.bavail*disk.bsize>=20*1024**3+remaining&&available>=2*1024**3,'insufficient-replay-resources')
 }
 guard(size);const input=fs.openSync(source,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW),output=fs.openSync(target,'wx',0o600),buffer=Buffer.alloc(65536);let copied=0
 try{
  for(let n;(n=fs.readSync(input,buffer,0,buffer.length,null))>0;){let offset=0;while(offset<n)offset+=fs.writeSync(output,buffer,offset,n-offset);copied+=n;if(copied%(64*1024**2)===0)guard(size-copied)}
  check(copied===size,'reuse-source-changed');fs.fsyncSync(output);guard(0)
 }finally{fs.closeSync(input);fs.closeSync(output)}
}

export function loadRegistry(name){
 if(!name)return repositoryRegistry
 check(safe(name)||/^wger-meta\.[A-Za-z0-9]{6}$/.test(name),'unsafe-metadata-workspace')
 const root=path.join(base,name);check(!fs.lstatSync(root).isSymbolicLink(),'unsafe-metadata')
 const evidence={}
 const read=kind=>{const file=path.join(root,kind+'.json');check(!fs.lstatSync(file).isSymbolicLink()&&fs.statSync(file).size<=1024**2,'unsafe-registry-file');const b=fs.readFileSync(file),data=JSON.parse(b);inspectExternal(data);check(Array.isArray(data.results)&&data.results.length<=100&&data.next===null&&data.count===data.results.length,'incomplete-registry');check(new Set(data.results.map(v=>v.id)).size===data.results.length&&data.results.every(v=>Number.isSafeInteger(v.id)&&v.id>0),'invalid-registry');evidence[kind]={sha256:sha(b),bytes:b.length};return data.results}
 const languages=read('language'),licenses=read('license')
 check(languages.every(v=>typeof v.short_name==='string'&&/^[a-z]{2}(?:-[a-z]{2})?$/.test(v.short_name))&&new Set(languages.map(v=>v.short_name)).size===languages.length&&licenses.every(v=>typeof v.url==='string'),'invalid-registry')
 return{languages,licenses,verified:true,evidence:{kind:'operator-provided-server-registries',files:evidence}}
}
export function verifyRegistryCoverage(registry,audit){
 if(!registry.verified)return // A provisional evaluation deliberately has gaps.
 check(audit.languageIds&&audit.licenseIds,'missing-audit-registry-ids')
 check(Object.keys(audit.languageIds).every(id=>registry.languages.some(v=>v.id===Number(id))),'registry-source-language-missing')
 check(Object.keys(audit.licenseIds).every(id=>registry.licenses.some(v=>v.id===Number(id))),'registry-source-license-missing')
}

export async function fullImport({workspace,auditName,metadata,reuse}){
 check(safe(workspace)&&safe(auditName.replace(/\.json$/,'')),'unsafe-workspace')
 const input=path.join(base,'wger-full-source','ingredients.jsonl.gz'),root=path.join(base,workspace)
 check(!fs.existsSync(root),'workspace-exists');check(!fs.lstatSync(input).isSymbolicLink(),'unsafe-source')
 const stat=fs.statSync(input);check(stat.isFile()&&stat.size<=1024**3,'source-limit')
 const auditPath=path.join(base,auditName);check(!fs.lstatSync(auditPath).isSymbolicLink()&&fs.statSync(auditPath).size<=1024**2,'unsafe-audit')
 const auditBytes=fs.readFileSync(auditPath),audit=JSON.parse(auditBytes);inspectExternal(audit)
 check(audit.complete===true&&audit.gzipCrcVerified===true&&audit.sourceBytes===stat.size&&audit.rows<=5000000&&/^[a-f0-9]{64}$/.test(audit.sourceSha256),'incomplete-audit')
 const registry=loadRegistry(metadata);verifyRegistryCoverage(registry,audit)
 const normalize=createWgerNormalizer(registry);fs.mkdirSync(root,{mode:0o700})
 if(reuse){
  check(safe(reuse)&&reuse!==workspace,'unsafe-reuse-workspace');const previous=path.join(base,reuse)
  check(!fs.lstatSync(previous).isSymbolicLink()&&!fs.existsSync(path.join(previous,'current.json'))&&fs.existsSync(path.join(previous,'interrupted.json')),'reuse-requires-unsealed-import')
  const candidates=fs.readdirSync(previous).filter(v=>/^catalog-[a-f0-9]{32}\.sqlite$/.test(v));check(candidates.length===1,'invalid-reuse-database')
  const file=path.join(previous,candidates[0]);check(!fs.lstatSync(file).isSymbolicLink()&&fs.statSync(file).size<=8*1024**3,'unsafe-reuse-database')
  copyUnsealed(file,path.join(root,candidates[0]))
 }
 // The source/audit files remain untouched. SQLite spill files stay on this disk.
 const child=spawn('python3',['-u',path.join(directory,'wger-generation.py'),'build',workspace,...(reuse?['--replay']:[])],{stdio:['pipe','pipe','inherit'],env:{...process.env,SQLITE_TMPDIR:root,PYTHONDONTWRITEBYTECODE:'1'}})
 let output='';child.stdout.on('data',b=>{output+=b;if(output.length>65536)child.kill()});child.stdin.on('error',()=>{})
 const exit=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>code===0?resolve():reject(Error('wger-writer-failed'))) });exit.catch(()=>{})
 const send=async v=>{const line=JSON.stringify(v)+'\n';check(Buffer.byteLength(line)<=256*1024,'normalized-line-limit');if(!child.stdin.write(line))await Promise.race([once(child.stdin,'drain'),exit.then(()=>{throw Error('writer-ended')})])}
 const start=performance.now(),cpu=process.cpuUsage(),digest=createHash('sha256');let expanded=0,scanned=0,rejected=0;const reasons={}
 const wire=new Transform({transform(b,_,cb){digest.update(b);cb(null,b)}})
 const limiter=new Transform({transform(b,_,cb){expanded+=b.length;if(expanded>12*1024**3)return cb(Error('expanded-limit'));cb(null,b)}})
 const source=fs.createReadStream(input,{highWaterMark:65536});const stream=pipeline(source,wire,createGunzip(),limiter);stream.catch(()=>{})
 try{
  await send({header:{format:'opengym-wger-full-generation',version:1,sourceSha256:audit.sourceSha256,sourceBytes:stat.size,expectedRows:audit.rows,auditSha256:sha(auditBytes),registry,limits:{maxRows:5000000,maxDbBytes:8*1024**3,minDiskBytes:20*1024**3,minMemoryBytes:2*1024**3},createdAt:new Date().toISOString()}})
  for await(const line of jsonLines(limiter)){
   check(++scanned<=5000000&&Buffer.byteLength(line)<=256*1024,'source-row-limit')
   let record;try{record=await normalize(JSON.parse(line))}catch(error){rejected++;const reason=/^[a-z0-9-]{1,60}$/.test(error.code??error.message)?error.code??error.message:'invalid-row';reasons[reason]=(reasons[reason]??0)+1;check(rejected<=10000&&rejected/Math.max(scanned,1000)<=.01,'massive-invalid-normalization');continue}
   await send({record,sourceLine:scanned})
   if(scanned%25000===0)console.error(JSON.stringify({event:'wger-import-progress',scanned,rejected,elapsedSeconds:(performance.now()-start)/1000,rssBytes:process.memoryUsage().rss}))
  }
  await stream;check(digest.digest('hex')===audit.sourceSha256&&scanned===audit.rows,'source-audit-mismatch')
  const now=fs.statSync(input);check(now.size===stat.size&&now.mtimeMs===stat.mtimeMs&&now.ino===stat.ino,'source-changed')
  const used=process.cpuUsage(cpu)
  await send({finish:{scanned,rejected,reasons,gzipCrcVerified:true,sourceHashVerified:true,expandedBytes:expanded,nodeCpuSeconds:(used.user+used.system)/1e6,nodeSeconds:(performance.now()-start)/1000,nodePeakRssBytes:process.resourceUsage().maxRSS*1024}})
  child.stdin.end();await exit;return JSON.parse(output)
 }catch(error){
  source.destroy();limiter.destroy();child.stdin.destroy();child.kill('SIGTERM');await exit.catch(()=>{})
  // The Python writer may already have recorded the interruption. Keep its
  // forensic receipt and do not mask the original error with EEXIST or ENOSPC.
  try{fs.writeFileSync(path.join(root,'interrupted.json'),JSON.stringify({complete:false,scanned,rejected,error:/^[a-z0-9-]{1,100}$/.test(error.message)?error.message:'import-failed'}),{flag:'wx'})}catch{}
  throw error
 }
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const args={};for(let i=2;i<process.argv.length;i+=2){check(['--workspace','--audit','--metadata','--reuse'].includes(process.argv[i])&&process.argv[i+1],'invalid-arguments');args[process.argv[i].slice(2)]=process.argv[i+1]}
 fullImport({workspace:args.workspace,auditName:args.audit,metadata:args.metadata,reuse:args.reuse}).then(r=>console.log(JSON.stringify(r,null,2))).catch(error=>{console.error(error.message);process.exitCode=1})
}
