import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {initializeState} from '../../scripts/private-beta/init-state.mjs';
import {privateBetaConfig} from '../nutrition/catalog-beta.js';
import {stack} from '../../scripts/private-beta/docker/stack.mjs';
import {allowedSource,stageCatalogues} from '../../scripts/private-beta/docker/prepare.mjs';
import {resolveImage} from '../../scripts/private-beta/docker/resolve-images.mjs';
const runtime=fileURLToPath(new URL('../../scripts/nutrition-local-catalog/runtime/',import.meta.url)),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function directory(t){fs.mkdirSync(runtime,{recursive:true,mode:0o700});const d=fs.mkdtempSync(path.join(runtime,'private-beta-docker-test-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;}
test('container listening is explicit, personal-only and never changes ordinary beta binding',t=>{
 const dir=directory(t),origin='https://gym.solhren.fr';initializeState(dir,origin,{personal:true});
 const environment={OPENGYM_PRIVATE_BETA:'1',OPENGYM_PERSONAL_BETA:'1',ALLOW_GUEST:'0',INVITE_ONLY:'1',BETA_MAX_USERS:'1',NODE_ENV:'production',ORIGIN:origin,RP_ID:'gym.solhren.fr',DATA_DIR:dir,NUTRITION_LOCAL_CATALOG:'1',NUTRITION_LOCAL_CATALOG_KIND:'wger-v1',...Object.fromEntries(['WORKSPACE','COMPLEMENT','REFERENCE','REFERENCE_INDEX'].map(n=>['NUTRITION_LOCAL_CATALOG_'+n,'fixture']))};
 assert.equal(privateBetaConfig({environment}).listenHost,'127.0.0.1');assert.equal(privateBetaConfig({environment:{...environment,OPENGYM_BETA_DOCKER:'1'}}).listenHost,'0.0.0.0');
 for(const v of [{OPENGYM_PRIVATE_BETA:'0'},{OPENGYM_PERSONAL_BETA:'0'},{ALLOW_GUEST:'1'}])assert.throws(()=>privateBetaConfig({environment:{...environment,OPENGYM_BETA_DOCKER:'1',...v}}));
});
test('Compose is private, nonroot, bounded, persistent and joins Traefik only through nginx',()=>{
 const c=stack();assert.equal(c.networks.private.internal,true);assert.deepEqual(c.services.backend.networks,['private']);assert.deepEqual(c.services.frontend.networks,['private','edge']);
 for(const s of Object.values(c.services)){assert.equal(s.ports,undefined);assert.equal(s.privileged,undefined);assert.equal(s.read_only,true);assert.deepEqual(s.cap_drop,['ALL']);assert.ok(s.logging.options['max-size']);assert.ok(s.mem_limit);assert.ok(!s.user.startsWith('0:'));}
 const backend=c.services.backend;assert.equal(backend.environment.ALLOW_GUEST,'0');assert.equal(backend.environment.OPENGYM_BETA_DOCKER,'1');assert.equal(backend.volumes[1].read_only,true);assert.equal(backend.volumes[0].type,'volume');
 assert.equal(c.services.frontend.volumes,undefined);assert.equal(c.networks.edge.name,'net');assert.ok(!JSON.stringify(c).includes('/home/codex'));assert.ok(!JSON.stringify(c).includes('authelia'));assert.ok(!JSON.stringify(c).includes('systemd'));
});
test('isolated Docker trial never registers a Traefik route or touches the personal data volume',()=>{
 const c=stack({lab:true});assert.equal(c.networks.edge,undefined);assert.equal(c.services.frontend.labels,undefined);assert.deepEqual(c.services.frontend.networks,['private']);assert.match(c.volumes.data.name,/^opengym-personal-lab-/);assert.notEqual(c.volumes.data.name,stack().volumes.data.name);
});
test('both Compose profiles provide nginx cache temp space inside the existing container memory limit',()=>{
 for(const lab of [false,true]){
  const c=stack({lab}),f=c.services.frontend;
  assert.equal(f.read_only,true);assert.equal(f.user,'101:101');assert.equal(f.mem_limit,'128m');assert.equal(f.cpus,0.5);assert.equal(f.pids_limit,32);
  assert.ok(f.tmpfs.includes('/tmp:rw,nosuid,nodev,size=64m,mode=1777'));
  assert.ok(f.tmpfs.includes('/var/cache/nginx:rw,nosuid,nodev,noexec,size=4m,uid=101,gid=101,mode=0700'));
  assert.equal(c.services.backend.volumes[1].read_only,true);assert.equal(f.ports,undefined);
 }
});
function installedFixture(t){
 const dir=directory(t),before={};
 for(const [name,lab]of [['compose.json',false],['compose.lab.json',true]]){
  const c=stack({lab});c.services.frontend.tmpfs=c.services.frontend.tmpfs.filter(v=>!v.startsWith('/var/cache/nginx:'));
  before[name]=JSON.stringify(c,null,2)+'\n';fs.writeFileSync(path.join(dir,name),before[name]);
 }
 fs.writeFileSync(path.join(dir,'deployment.sha256'),Object.entries(before).map(([n,v])=>sha(v)+'  '+n+'\n').join('')+'a'.repeat(64)+'  manage.sh\n');
 fs.writeFileSync(path.join(dir,'source.sha256'),'source snapshot must stay unchanged');
 const script=fileURLToPath(new URL('../../scripts/private-beta/docker/fix-nginx-tmpfs.py',import.meta.url));
 return {dir,before,run:()=>spawnSync('python3',[script,dir],{encoding:'utf8'})};
}
test('installed nginx fix updates both real-format Compose files and checksums without changing services or sources',t=>{
 const f=installedFixture(t),r=f.run();assert.equal(r.status,0,r.stderr);
 for(const name of Object.keys(f.before)){
  const patched=JSON.parse(fs.readFileSync(path.join(f.dir,name),'utf8'));
  assert.match(patched.services.frontend.tmpfs.pop(),/^\/var\/cache\/nginx:.*uid=101,gid=101/);
  assert.deepEqual(patched,JSON.parse(f.before[name]));
  assert.ok(fs.readFileSync(path.join(f.dir,'deployment.sha256'),'utf8').includes(sha(fs.readFileSync(path.join(f.dir,name)))+'  '+name));
 }
 assert.equal(fs.readFileSync(path.join(f.dir,'source.sha256'),'utf8'),'source snapshot must stay unchanged');
 const backups=fs.readdirSync(f.dir).filter(n=>n.startsWith('nginx-tmpfs-backup-'));assert.equal(backups.length,1);
 for(const name of Object.keys(f.before))assert.equal(fs.readFileSync(path.join(f.dir,backups[0],name),'utf8'),f.before[name]);
 const again=f.run();assert.equal(again.status,0,again.stderr);assert.match(again.stdout,/already corrected/);assert.equal(fs.readdirSync(f.dir).filter(n=>n.startsWith('nginx-tmpfs-backup-')).length,1);
});
test('installed nginx fix refuses unrecorded local changes before writing either Compose file',t=>{
 const f=installedFixture(t);fs.appendFileSync(path.join(f.dir,'compose.lab.json'),'\n');const r=f.run();assert.equal(r.status,1);assert.match(r.stderr,/unrecorded changes/);assert.equal(fs.readFileSync(path.join(f.dir,'compose.json'),'utf8'),f.before['compose.json']);assert.equal(fs.readdirSync(f.dir).some(n=>n.startsWith('nginx-tmpfs-backup-')),false);
});
test('source selection excludes secrets, user data, build artifacts and tests, preserves required runtime',()=>{
 for(const n of ['.env','frontend/.env.production','api/data/db.json','frontend/android/local.properties','scripts/nutrition-local-catalog/artifacts/file.sqlite','frontend/node_modules/a.js','api/test/a.test.js','frontend/src/lib/personal-beta.test.js','scripts/private-beta/docker/key.pem'])assert.equal(allowedSource(n),false,n);
 for(const n of ['api/server.js','api/coach/routes.js','api/nutrition/catalog-beta.js','frontend/src/lib/nutrition/catalog/client.js','frontend/scripts/sw-stamp.mjs','frontend/android/gradlew','scripts/nutrition-local-catalog/wger-v1-reader.py','scripts/private-beta/docker/health.mjs','catalogue/media/NOTICE.md'])assert.equal(allowedSource(n),true,n);
});
function catalogue(t,{writable=false}={}){
 const dir=directory(t),source=path.join(dir,'source'),name='fixture',folder=path.join(source,name);fs.mkdirSync(folder,{recursive:true});const raw=Buffer.from('synthetic SQLite bytes'),file='catalog-'+ 'a'.repeat(32)+'.sqlite';fs.writeFileSync(path.join(folder,file),raw,{mode:writable?0o600:0o444});const manifest=JSON.stringify({complete:true,file,bytes:raw.length,sha256:sha(raw)});fs.writeFileSync(path.join(folder,'current.json'),manifest);return {dir,source,name,file,pins:[[name,raw.length,sha(raw),sha(manifest)]],raw};
}
test('sealed catalogues share only immutable file inodes and retain their original permissions',t=>{
 const f=catalogue(t),target=path.join(f.dir,'snapshot'),input=path.join(f.source,f.name,f.file),before=fs.statSync(input);const receipt=stageCatalogues(f.source,target,{pins:f.pins,guard:()=>{}});assert.equal(receipt.linkedBytes,f.raw.length);assert.equal(fs.statSync(path.join(target,f.name,f.file)).ino,before.ino);assert.equal(fs.statSync(input).mode,before.mode);assert.deepEqual(fs.readFileSync(path.join(target,f.name,'current.json')),fs.readFileSync(path.join(f.source,f.name,'current.json')));
});
test('writable catalogue bytes are independent copies, without chmod/chown of the source',t=>{
 const f=catalogue(t,{writable:true}),target=path.join(f.dir,'snapshot'),input=path.join(f.source,f.name,f.file);const receipt=stageCatalogues(f.source,target,{pins:f.pins,guard:()=>{}});const output=path.join(target,f.name,f.file);assert.equal(receipt.copiedBytes,f.raw.length);assert.notEqual(fs.statSync(output).ino,fs.statSync(input).ino);assert.equal(fs.statSync(input).mode&0o777,0o600);assert.equal(fs.statSync(output).mode&0o777,0o444);fs.writeFileSync(input,'changed source');assert.deepEqual(fs.readFileSync(output),f.raw);
});
test('corruption, unapproved manifests, symlinks and repeated output are refused',t=>{
 const f=catalogue(t),target=path.join(f.dir,'snapshot');assert.throws(()=>stageCatalogues(f.source,target,{pins:[[f.name,f.raw.length,'0'.repeat(64),f.pins[0][3]]],guard:()=>{}}),/unapproved/);assert.throws(()=>stageCatalogues(f.source,target,{pins:f.pins,guard:()=>{}}),/must-be-new/);
 fs.chmodSync(path.join(f.source,f.name,f.file),0o600);fs.writeFileSync(path.join(f.source,f.name,f.file),Buffer.alloc(f.raw.length));assert.throws(()=>stageCatalogues(f.source,path.join(f.dir,'corrupt'),{pins:f.pins,guard:()=>{}}),/corrupt/);
 const other=catalogue(t);fs.renameSync(path.join(other.source,other.name),path.join(other.source,'real'));fs.symlinkSync('real',path.join(other.source,other.name));assert.throws(()=>stageCatalogues(other.source,path.join(other.dir,'out'),{pins:other.pins,guard:()=>{}}),/unsafe-generation/);
});
test('resource guard aborts before a snapshot is published and preserves original bytes',t=>{
 const f=catalogue(t),target=path.join(f.dir,'snapshot');assert.throws(()=>stageCatalogues(f.source,target,{pins:f.pins,guard:()=>{throw Error('reserve');}}),/reserve/);assert.deepEqual(fs.readFileSync(path.join(f.source,f.name,f.file)),f.raw);assert.equal(fs.existsSync(path.join(f.dir,'prepared.json')),false);
});
test('registry metadata pins exact digests without pulling images or exposing anonymous tokens',async()=>{
 const calls=[];const result=await resolveImage('library/node','22-alpine',{fetchImpl:async(u,o)=>{calls.push([u,o]);return calls.length===1?new Response('{"token":"synthetic-public-registry-token"}'):new Response(null,{headers:{'docker-content-digest':'sha256:'+'a'.repeat(64)}});}});assert.equal(result,'node:22-alpine@sha256:'+'a'.repeat(64));assert.equal(calls[1][1].method,'HEAD');assert.equal(calls[1][1].redirect,'error');await assert.rejects(resolveImage('foreign/image','alpine'),/unsupported/);
});
test('registry 429/503 and invalid digests stop once without an automatic retry',async()=>{
 for(const status of [429,503,200]){let calls=0;await assert.rejects(resolveImage('library/node','22-alpine',{fetchImpl:async()=>++calls===1?new Response('{"token":"synthetic"}'):new Response(null,{status})}),/manifest-unavailable/);assert.equal(calls,2);}
});
test('offline backup validates its private state, estimates space and emits only a complete tar archive',t=>{
 const dir=directory(t);initializeState(dir,'https://gym.solhren.fr',{personal:true});
 const env={PATH:process.env.PATH,OPENGYM_PRIVATE_BETA:'1',OPENGYM_PERSONAL_BETA:'1',ALLOW_GUEST:'0',INVITE_ONLY:'1',BETA_MAX_USERS:'1',NODE_ENV:'production',ORIGIN:'https://gym.solhren.fr',RP_ID:'gym.solhren.fr',DATA_DIR:dir,NUTRITION_LOCAL_CATALOG:'1',NUTRITION_LOCAL_CATALOG_KIND:'wger-v1',...Object.fromEntries(['WORKSPACE','COMPLEMENT','REFERENCE','REFERENCE_INDEX'].map(n=>['NUTRITION_LOCAL_CATALOG_'+n,'fixture']))};
 const script=fileURLToPath(new URL('../../scripts/private-beta/docker/backup.mjs',import.meta.url));
 const estimate=spawnSync(process.execPath,[script,'--estimate'],{env,encoding:'utf8'});assert.equal(estimate.status,0,estimate.stderr);assert.ok(Number(estimate.stdout)>fs.statSync(path.join(dir,'db.json')).size);
 const archive=spawnSync(process.execPath,[script],{env});assert.equal(archive.status,0,archive.stderr.toString());const list=spawnSync('tar',['-tzf','-'],{input:archive.stdout,encoding:'utf8'});assert.equal(list.status,0,list.stderr);assert.match(list.stdout,/\.\/db\.json/);assert.match(list.stdout,/\.opengym-private-beta\.json/);
 const other=directory(t);const invalid=spawnSync(process.execPath,[script],{env:{...env,DATA_DIR:other}});assert.equal(invalid.status,1);assert.equal(invalid.stdout.length,0);
 fs.symlinkSync('/etc/passwd',path.join(dir,'forbidden-synthetic-link'));const links=spawnSync(process.execPath,[script,'--estimate'],{env});assert.equal(links.status,1);assert.equal(links.stdout.length,0);
});
