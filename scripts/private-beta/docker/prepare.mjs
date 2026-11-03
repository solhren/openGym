// Frozen source + immutable public catalogue snapshot. Never installs or deploys.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {stack} from './stack.mjs';
const repo=fileURLToPath(new URL('../../../',import.meta.url));
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
export const PINS=[
 ['wger-full-registered-20261025',5351129088,'1ec86569b6ca5e5c9dfb132eba42a308ae7495c61905ba9636d9f8972dcb5cca','278c13f8ec5d30c8a4388d7aa33e0e3155fc0be3ab6d0abeb3f3c0d64a6782cd'],
 ['wger-fr-quality-20261026',434176,'139054d4329495f645d635763dc78d5d96480a67057764506ea72a239496c862','0e51da60221e679a4348f607d702fd524b057b443e71bea70a375e4f2e3c82c7'],
 ['off-reference-full2-20261026',1762095104,'cead4b01ef23bc1e12470820ad4fe06fc1207899c850fa9f1ed835b91c79a6a7','9173eb198644112ef323e70a1645d7b01bfa8616163175e7e0c77e2e22d30822'],
 ['wger-off-search-20261026',302596096,'851708f9e25f6a0f64d85ceeafe2b19208d81e00363fe32d33bd5a2915527372','92f02a508494016a36f36c9b814e684a27493ffb4b86cddf5d41c65155fcca7d']
];
export function resources(dir,{additionalBytes=0,start=false}={}){
 const s=fs.statfsSync(dir),memory=Number(fs.readFileSync('/proc/meminfo','utf8').match(/^MemAvailable:\s+(\d+)/m)[1])*1024;
 const free=s.bavail*s.bsize;
 if(free<(20.25*1024**3+additionalBytes)||memory<(start?3:2.25)*1024**3)throw Error('docker-beta-resource-reserve');
 return {freeDiskBytes:free,availableMemoryBytes:memory};
}
const regular=file=>{const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink())throw Error('unsafe-snapshot-source');return st;};
/** Hash streaming; writable sources are copied, sealed 0444 sources share an
 * inode without changing it. Publish a receipt only after every byte verifies.
 */
export function stageCatalogues(source,target,{pins=PINS,guard=()=>resources(target)}={}){
 if(fs.existsSync(target))throw Error('catalogue-target-must-be-new');fs.mkdirSync(target,{mode:0o755});
 const records=[];let copied=0,linked=0;
 for(const [name,bytes,sha,manifestSha] of pins){
  if(!/^[A-Za-z0-9_-]{1,40}$/.test(name))throw Error('unsafe-generation-name');
  const root=path.join(source,name);if(fs.lstatSync(root).isSymbolicLink()||fs.realpathSync(root)!==root)throw Error('unsafe-generation-root');
  const mp=path.join(root,'current.json');if(regular(mp).size>65536)throw Error('unsafe-manifest');
  const raw=fs.readFileSync(mp),m=JSON.parse(raw);
  if(hash(raw)!==manifestSha||!m.complete||m.bytes!==bytes||m.sha256!==sha||!/^[a-z]+-[a-f0-9]{32}\.sqlite$/.test(m.file))throw Error('unapproved-catalogue-generation');
  const input=path.join(root,m.file),before=regular(input);
  if(before.size!==bytes)throw Error('catalogue-size-mismatch');
  const dir=path.join(target,name);fs.mkdirSync(dir,{mode:0o755});const output=path.join(dir,m.file);
  const link=(before.mode&0o222)===0&&(before.mode&0o444)===0o444&&before.dev===fs.statSync(target).dev;
  if(link)fs.linkSync(input,output);
  const from=fs.openSync(input,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  let to;const digest=crypto.createHash('sha256'),buffer=Buffer.alloc(1024*1024);let total=0,checked=0;
  try{
   if(!link)to=fs.openSync(output,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o444);
   let n;while((n=fs.readSync(from,buffer,0,buffer.length,null))){
    digest.update(buffer.subarray(0,n));if(to!==undefined){let offset=0;while(offset<n)offset+=fs.writeSync(to,buffer,offset,n-offset);}
    total+=n;if(total-checked>=32*1024**2){guard();checked=total;}
   }
   const after=fs.fstatSync(from);
   if(total!==bytes||digest.digest('hex')!==sha||after.size!==before.size||after.mtimeMs!==before.mtimeMs||hash(fs.readFileSync(mp))!==manifestSha)throw Error('catalogue-changed-or-corrupt');
   if(to!==undefined)fs.fsyncSync(to);
  }finally{fs.closeSync(from);if(to!==undefined)fs.closeSync(to);}
  fs.writeFileSync(path.join(dir,'current.json'),raw,{mode:0o444,flag:'wx'});
  const fd=fs.openSync(dir,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  if(link)linked+=bytes;else copied+=bytes;
  records.push({name,file:m.file,bytes,sha256:sha,manifestSha256:manifestSha,storage:link?'sealed-hardlink':'independent-copy'});guard();
 }
 return {records,copiedBytes:copied,linkedBytes:linked};
}
export function allowedSource(name){
 if(/[\u0000-\u001f\u007f]/.test(name))return false;
 if(name.includes('..')||/(?:^|\/)(?:\.env[^/]*|node_modules|data|artifacts|runtime|build|dist|\.gradle|test|__tests__)(?:\/|$)/.test(name)||/\.test[.-]|(?:^|\/)test_|\.(?:pem|key|keystore|jks|sqlite|gz|log)$/.test(name)||name.endsWith('local.properties'))return false;
 return /^(?:api\/(?:[^/]+\.(?:js|json|yaml)|(?:coach|nutrition|shared)\/)|frontend\/(?:src\/|public\/|scripts\/|android\/|[^/]+\.(?:json|js|html))|scripts\/(?:private-beta\/|catalogue\/|nutrition-local-catalog\/[^/]+\.(?:py|mjs)$)|catalogue\/media\/|(?:LICENSE|NOTICE)(?:\.|$))/.test(name);
}
export function prepare(target,{sourceOnly=false}={}){
 if(fs.existsSync(target)||!path.isAbsolute(target)||!target.startsWith(path.join(repo,'scripts/nutrition-local-catalog/runtime/private-beta-compose-'))||fs.realpathSync(path.dirname(target))!==path.dirname(target))throw Error('new-isolated-compose-directory-required');
 const names=[...new Set(execFileSync('git',['-C',repo,'ls-files','-z','--cached','--others','--exclude-standard'],{maxBuffer:8*1024**2}).toString().split('\0').filter(allowedSource))].sort();
 const sourceBytes=names.reduce((n,name)=>n+regular(path.join(repo,name)).size,0);if(sourceBytes>512*1024**2)throw Error('source-context-budget');
 const catalogues=path.join(repo,'scripts/nutrition-local-catalog/artifacts');
 const copyBytes=sourceOnly?0:PINS.reduce((n,[name,bytes,sha,manifestSha])=>{const raw=fs.readFileSync(path.join(catalogues,name,'current.json')),m=JSON.parse(raw);if(hash(raw)!==manifestSha||m.sha256!==sha||m.bytes!==bytes||!/^[a-z]+-[a-f0-9]{32}\.sqlite$/.test(m.file))throw Error('unapproved-catalogue-generation');const s=regular(path.join(catalogues,name,m.file));return n+((s.mode&0o222)||(s.mode&0o444)!==0o444||s.dev!==fs.statSync(path.dirname(target)).dev?bytes:0);},0);
 const initial=resources(path.dirname(target),{additionalBytes:copyBytes+sourceBytes+4*1024**3,start:true});
 fs.mkdirSync(target,{mode:0o700});const source=path.join(target,'source');fs.mkdirSync(source,{mode:0o755});
 const inventory=[],sourceHash=crypto.createHash('sha256');
 for(const name of names){const from=path.join(repo,name),out=path.join(source,name);fs.mkdirSync(path.dirname(out),{recursive:true,mode:0o755});fs.copyFileSync(from,out,fs.constants.COPYFILE_EXCL);fs.chmodSync(out,(regular(from).mode&0o111)?0o755:0o644);const sha256=hash(fs.readFileSync(out));inventory.push({name,sha256});sourceHash.update(name+'\0'+sha256+'\n');if(inventory.length%100===0)resources(target);}
 for(const {name,sha256} of inventory)if(hash(fs.readFileSync(path.join(repo,name)))!==sha256)throw Error('source-changed-during-preparation');
 fs.writeFileSync(path.join(source,'.dockerignore'),'**/.env*\n**/node_modules\n**/artifacts\n**/runtime\n**/data\n**/dist\n**/android\n**/ios\n**/*.pem\n**/*.key\n**/*.keystore\n',{mode:0o644,flag:'wx'});
 const ignoreHash=hash(fs.readFileSync(path.join(source,'.dockerignore')));inventory.push({name:'.dockerignore',sha256:ignoreHash});sourceHash.update('.dockerignore\0'+ignoreHash+'\n');
 const catalog=sourceOnly?{cataloguesOmitted:true,records:[],copiedBytes:0,linkedBytes:0}:stageCatalogues(catalogues,path.join(target,'catalogues'));
 const sha=sourceHash.digest('hex'),release='beta-'+new Date().toISOString().slice(0,10).replaceAll('-','')+'-'+sha.slice(0,12);
 const write=(name,value)=>fs.writeFileSync(path.join(target,name),JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});
 write('compose.json',stack());write('compose.lab.json',stack({lab:true}));write('source-inventory.json',inventory);
 fs.copyFileSync(new URL('./manage.sh',import.meta.url),path.join(target,'manage.sh'),fs.constants.COPYFILE_EXCL);fs.chmodSync(path.join(target,'manage.sh'),0o755);
 fs.copyFileSync(path.join(repo,'docs/dev/PERSONAL_BETA_DOCKER.md'),path.join(target,'INSTALL.md'),fs.constants.COPYFILE_EXCL);fs.chmodSync(path.join(target,'INSTALL.md'),0o644);
 fs.writeFileSync(path.join(target,'source.sha256'),inventory.map(v=>v.sha256+'  source/'+v.name+'\n').join(''),{mode:0o600,flag:'wx'});
 if(!sourceOnly)fs.writeFileSync(path.join(target,'catalogues.sha256'),catalog.records.flatMap(v=>[v.sha256+'  catalogues/'+v.name+'/'+v.file+'\n',v.manifestSha256+'  catalogues/'+v.name+'/current.json\n']).join(''),{mode:0o600,flag:'wx'});
 fs.writeFileSync(path.join(target,'deployment.sha256'),['compose.json','compose.lab.json','manage.sh'].map(name=>hash(fs.readFileSync(path.join(target,name)))+'  '+name+'\n').join(''),{mode:0o600,flag:'wx'});
 fs.mkdirSync(path.join(target,'backups'),{mode:0o700});
 const receipt={format:'opengym-personal-compose-preparation',version:1,complete:true,enabled:false,release,sourceSha256:sha,sourceBytes,...catalog,initial,final:resources(target),dockerValidated:false};
 write('prepared.json',receipt);const fd=fs.openSync(target,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}return receipt;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 try{if(![3,4].includes(process.argv.length)||(process.argv[3]&&process.argv[3]!=='--source-only'))throw Error('Usage: node prepare.mjs NEW_ABSOLUTE_PRIVATE_BETA_COMPOSE_WORKSPACE [--source-only]');console.log(JSON.stringify(prepare(process.argv[2],{sourceOnly:process.argv[3]==='--source-only'})));}
 catch(e){console.error(e.message);process.exitCode=1;}
}
