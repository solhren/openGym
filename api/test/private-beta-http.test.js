import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {boundPort} from './helpers.mjs';
import {referenceCatalogFixture} from './catalog-reference.test-util.js';
import {initializeState} from '../../scripts/private-beta/init-state.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
test('private beta real HTTP is local-only in production profile, origin-isolated and restartable',{timeout:30000},async t=>{
 const fixture=await referenceCatalogFixture(),dir=fs.mkdtempSync(path.join(root,'scripts/nutrition-local-catalog/runtime/private-beta-http-'));initializeState(dir,'https://beta.example.org');let child;
 const stop=async()=>{if(child&&child.exitCode===null){const ended=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await ended;}};
 t.after(async()=>{await stop();fixture.cleanup();fs.rmSync(dir,{recursive:true,force:true});});
 const env={PATH:process.env.PATH,NODE_ENV:'production',OPENGYM_PRIVATE_BETA:'1',PORT:'0',DATA_DIR:dir,ORIGIN:'https://beta.example.org',RP_ID:'beta.example.org',INVITE_ONLY:'1',ALLOW_GUEST:'1',NUTRITION_LOCAL_CATALOG:'1',NUTRITION_LOCAL_CATALOG_KIND:'wger-v1',NUTRITION_LOCAL_CATALOG_WORKSPACE:fixture.names.base,NUTRITION_LOCAL_CATALOG_COMPLEMENT:fixture.names.quality,NUTRITION_LOCAL_CATALOG_REFERENCE:fixture.names.reference,NUTRITION_LOCAL_CATALOG_REFERENCE_INDEX:fixture.names.index};
 async function start(){child=spawn(process.execPath,['scripts/private-beta/entry.mjs'],{cwd:root,env});let out='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>out+=b);return 'http://127.0.0.1:'+await boundPort(child,()=>out);}
 let url=await start();let r=await fetch(url+'/api/nutrition/catalog/capabilities');assert.equal((await r.json()).selection,'local-only');
 for(const q of ['Nutella','Coca-Cola']){r=await fetch(url+'/api/nutrition/catalog/search?q='+encodeURIComponent(q));assert.equal(r.status,200);assert.ok((await r.json()).products[0].food);}
 r=await fetch(url+'/api/nutrition/catalog/product?code=5449000000996');assert.equal(r.status,200);assert.deepEqual((await r.json()).product.reference,{amount:100,unit:'ml'});
 assert.equal((await fetch(url+'/api/nutrition/head')).status,401);assert.equal((await fetch(url+'/api/nutrition/catalog/search?q=lait',{headers:{Origin:'https://foreign.example.org'}})).status,403);
 assert.equal((await fetch(url+'/api/nutrition/catalog/product?code=11111111')).status,404);
 const marker=fs.readFileSync(path.join(dir,'.opengym-private-beta.json'));await stop();url=await start();assert.deepEqual(fs.readFileSync(path.join(dir,'.opengym-private-beta.json')),marker);
 assert.equal((await fetch(url+'/api/nutrition/catalog/product?code=5449000000996')).status,200);
});
