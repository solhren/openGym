import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {betaOrigin,privateBetaConfig,BETA_MARKER} from '../nutrition/catalog-beta.js';
import {experimentalCatalogRelay} from '../nutrition/catalog-local.js';
import {initializeState} from '../../scripts/private-beta/init-state.mjs';
import {prepare} from '../../scripts/private-beta/prepare.mjs';
import {boundedLog} from '../../scripts/private-beta/run.mjs';
import {run} from '../../scripts/private-beta/run.mjs';
import {spawn} from 'node:child_process';
const runtime=fileURLToPath(new URL('../../scripts/nutrition-local-catalog/runtime/',import.meta.url));
const origin='https://beta.example.org';
function fixture(t){
 fs.mkdirSync(runtime,{recursive:true,mode:0o700});
 const dir=fs.mkdtempSync(path.join(runtime,'private-beta-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));initializeState(dir,origin);
 return {dir,env:{OPENGYM_PRIVATE_BETA:'1',NODE_ENV:'production',DATA_DIR:dir,ORIGIN:origin,RP_ID:'beta.example.org',NUTRITION_LOCAL_CATALOG:'1',NUTRITION_LOCAL_CATALOG_KIND:'wger-v1',...Object.fromEntries(['WORKSPACE','COMPLEMENT','REFERENCE','REFERENCE_INDEX'].map(k=>['NUTRITION_LOCAL_CATALOG_'+k,'test']))}};
}
test('beta requires a distinct origin-bound private directory; production defaults stay unchanged',t=>{
 const {dir,env}=fixture(t);assert.equal(privateBetaConfig({environment:env}).dataDir,dir);assert.equal(privateBetaConfig({environment:{}}),null);
 for(const extra of [{NODE_ENV:'development'},{DATA_DIR:'/data'},{RP_ID:'example.org'},{ORIGIN:'http://localhost:3307'},{NUTRITION_LOCAL_CATALOG_REFERENCE:undefined}])assert.throws(()=>privateBetaConfig({environment:{...env,...extra}}));
 assert.throws(()=>initializeState(dir,origin));assert.equal(privateBetaConfig({environment:env}).origin,origin);
 for(const u of ['http://beta.example.org','https://127.0.0.1','https://user:secret@beta.example.org','https://beta.example.org/api','https://localhost','https://beta.invalid'])assert.throws(()=>betaOrigin(u));
});
test('wrong origin, public permissions and symlink marker cannot adopt another account store',t=>{
 const {dir,env}=fixture(t),p=path.join(dir,BETA_MARKER),marker=fs.readFileSync(p);fs.chmodSync(p,0o644);assert.throws(()=>privateBetaConfig({environment:env}));fs.chmodSync(p,0o600);
 assert.throws(()=>privateBetaConfig({environment:{...env,ORIGIN:'https://other.example.org',RP_ID:'other.example.org'}}));
 fs.renameSync(p,p+'.own-test');fs.symlinkSync(p+'.own-test',p);assert.throws(()=>privateBetaConfig({environment:env}));assert.deepEqual(fs.readFileSync(p+'.own-test'),marker);
});
test('private production beta cannot downgrade to a provider when worker initialization fails',async t=>{
 const {dir,env}=fixture(t);let remoteCalls=0;
 await assert.rejects(experimentalCatalogRelay({environment:env,dataDir:dir,remote:{read(){remoteCalls++;throw Error('external forbidden');}},loadWger:async()=>{throw Error('missing worker');}}),/private-beta-catalogue-unavailable/);
 assert.equal(remoteCalls,0);
});
test('a beta integrity warmup failure closes its reader instead of serving provider fallback',async t=>{
 const {dir,env}=fixture(t);let closed=0;
 await assert.rejects(experimentalCatalogRelay({environment:env,dataDir:dir,loadWger:async()=>({WgerCatalogWorker:class{async request(){throw Error('corrupt generation');}async close(){closed++;}},createWgerLocalCatalog:worker=>({close:()=>worker.close()})})}),/private-beta-catalogue-unavailable/);
 assert.equal(closed,1);
});
test('private beta configuration generation never installs or enables a service',t=>{
 const {dir}=fixture(t),output=dir+'-review';t.after(()=>fs.rmSync(output,{recursive:true,force:true}));prepare(origin,output);
 const review=JSON.parse(fs.readFileSync(path.join(output,'review.json')));assert.equal(review.enabled,false);assert.equal(review.requiresApproval,true);assert.equal(review.proxyNamespaceVerified,false);
 const unit=fs.readFileSync(path.join(output,'opengym-beta.service'),'utf8');assert.match(unit,/ProtectHome=tmpfs/);assert.match(unit,/IPAddressDeny=any/);assert.match(unit,/ReadWritePaths=\/var\/lib\/opengym-beta/);
 assert.throws(()=>prepare(origin,output));
 const personal=dir+'-personal-review';t.after(()=>fs.rmSync(personal,{recursive:true,force:true}));prepare('https://gym.solhren.fr',personal);
 const compose=JSON.parse(fs.readFileSync(path.join(personal,'compose.personal.json'))),web=compose.services.web;
 assert.equal(web.user,process.getuid()+':'+process.getgid());assert.notEqual(process.getuid(),0);
 assert.equal(web.ports,undefined);assert.equal(web.read_only,true);assert.deepEqual(web.cap_drop,['ALL']);assert.ok(web.volumes.every(v=>v.read_only));
 assert.ok(web.volumes.every(v=>!v.source.includes('/var/lib/opengym-beta')));assert.match(web.labels['traefik.http.routers.opengym-personal.rule'],/gym\.solhren\.fr/);
 const config=fs.readFileSync(path.join(personal,'opengym-beta.conf'),'utf8');assert.match(config,/ALLOW_GUEST=0/);assert.match(config,/OPENGYM_PERSONAL_BETA=1/);assert.match(config,/INVITE_ONLY=1/);
});
test('beta log rotation is bounded and restartable, without touching account files',t=>{
 const {dir}=fixture(t),before=fs.readFileSync(path.join(dir,BETA_MARKER)),logs=path.join(dir,'logs');let log=boundedLog(logs,256);
 for(let i=0;i<20;i++)log.write('stdout',Buffer.from('a'.repeat(60)));log.close();
 assert.ok(fs.readdirSync(logs).length<=3);for(const f of fs.readdirSync(logs))assert.ok(fs.statSync(path.join(logs,f)).size<=256);
 log=boundedLog(logs,256);log.write('stderr',Buffer.from('restart'));log.close();assert.deepEqual(fs.readFileSync(path.join(dir,BETA_MARKER)),before);
});
// Only the synthetic supervisor fixture gets resource metadata. Its two Python sleeps must
// not depend on another test/worktree consuming host headroom. Production reserves stay real.
function fixtureResources(t,dir,{disk=24*1024**3,memory=4*1024**3}={}){
 const statfs=fs.statfsSync,read=fs.readFileSync;
 t.mock.method(fs,'statfsSync',(file,...args)=>file===dir?{...statfs(file,...args),bsize:1,bavail:disk}:statfs(file,...args));
 t.mock.method(fs,'readFileSync',(file,...args)=>file==='/proc/meminfo'?`MemAvailable: ${Math.floor(memory/1024)} kB\n`:read(file,...args));
}
for(const [name,budget]of [['disk',{disk:21*1024**3-1}],['memory',{memory:3*1024**3-1024}]]){
 test(`supervisor refuses below its real ${name} startup reserve before spawning`,async t=>{
  const {dir,env}=fixture(t);fixtureResources(t,dir,budget);let spawned=0;
  await assert.rejects(run({environment:env,spawnProcess(){spawned++;throw Error('must not spawn');}}),/private-beta-resource-reserve/);
  assert.equal(spawned,0);assert.equal(fs.existsSync(path.join(dir,'logs')),false);
 });
}
test('supervisor stop during preparation terminates its own process group, including Python descendants',{timeout:10000},async t=>{
 const {dir,env}=fixture(t);fixtureResources(t,dir);let child,descendant;
 const done=run({environment:{...env,PATH:process.env.PATH},spawnProcess:(command,args,options)=>{
  child=spawn('python3',['-u','-c','import subprocess,time; p=subprocess.Popen(["python3","-c","import time;time.sleep(60)"]);print(p.pid,flush=True);time.sleep(60)'],options);
  child.stdout.once('data',b=>{descendant=Number(b.toString().trim());});return child;
 }});
 t.after(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}});
 const until=Date.now()+4000;while(!descendant&&Date.now()<until)await new Promise(r=>setTimeout(r,10));assert.ok(descendant);
 process.emit('SIGTERM');await done;
 const running=()=>{try{const stat=fs.readFileSync('/proc/'+descendant+'/stat','utf8');return !['Z','X'].includes(stat.slice(stat.lastIndexOf(')')+2).split(' ')[0]);}catch{return false;}};
 for(let i=0;i<100&&running();i++)await new Promise(r=>setTimeout(r,10));assert.equal(running(),false);
});
