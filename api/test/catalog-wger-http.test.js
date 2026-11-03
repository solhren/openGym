// Actual sockets, normalizer, Python, SQLite and supervisor. No provider API.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {foodCatalogRoutes} from '../nutrition/food-catalog.js';
import {createWgerRelay,WGER_CAPABILITIES} from '../nutrition/catalog-wger.js';
import {WgerCatalogWorker} from '../../scripts/nutrition-local-catalog/wger-worker-client.mjs';
import {createWgerLocalCatalog} from '../../scripts/nutrition-local-catalog/wger-api-adapter.mjs';
import {normalizeWger} from '../../scripts/nutrition-local-catalog/wger-normalize.mjs';

test('real HTTP V1 local-only search, selection, origin, concurrent requests and reader restart',{timeout:30000},async t=>{
 let routes,relay;const roots=[];
 const server=http.createServer((req,res)=>{const fn=routes?.[req.method+' '+new URL(req.url,'http://x').pathname];if(fn)fn(req,res);else{res.writeHead(404);res.end();}});
 t.after(async()=>{if(server.listening){server.closeAllConnections();await new Promise(r=>server.close(r));}await relay?.close();for(const root of roots)fs.rmSync(root,{recursive:true,force:true});});
 // Fail explicitly before fixture construction when the sandbox denies sockets.
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const address='http://127.0.0.1:'+server.address().port,base=path.resolve(import.meta.dirname,'../../scripts/nutrition-local-catalog/artifacts');
 const names=['http-wger-'+randomBytes(6).toString('hex'),'http-quality-'+randomBytes(6).toString('hex')];
 for(const name of names){const root=path.join(base,name);fs.mkdirSync(root,{mode:0o700});roots.push(root);}
 const run=(script,args,input)=>new Promise((resolve,reject)=>{
  const child=spawn('python3',[path.join(base,'..',script),...args],{stdio:['pipe','pipe','pipe']});let output='',error='';const timer=setTimeout(()=>child.kill('SIGKILL'),10000);
  child.stdout.on('data',b=>{output+=b;if(output.length>65536)child.kill();});child.stderr.on('data',b=>{error+=b;if(error.length>65536)child.kill();});child.on('error',reject);child.on('close',code=>{clearTimeout(timer);code===0?resolve(JSON.parse(output)):reject(Error(error||'fixture-build-failed'));});child.stdin.on('error',()=>{});child.stdin.end(input);
 });
 const context={languages:[{id:1,short_name:'en'}],licenses:[{id:1,url:'https://creativecommons.org/publicdomain/zero/1.0/'}]};
 const p=await normalizeWger({id:1,uuid:'12345678-1234-1234-1234-123456789abc',code:'00012345',name:'Rice, raw',brand:'',source_name:'USDA',language:1,license:1,energy:350.6,protein:'7.123',carbohydrates:'75.5',fat:'1.25'},context);
 const wire=[{header:{format:'opengym-wger-full-generation',version:1,sourceSha256:'f'.repeat(64),sourceBytes:1,expectedRows:1,registry:{verified:true,fixture:true}}},{record:p,sourceLine:1},{finish:{scanned:1,rejected:0,gzipCrcVerified:true,sourceHashVerified:true}}].map(v=>JSON.stringify(v)+'\n').join('');
 await run('wger-generation.py',['build',names[0]],wire);
 const manifest=JSON.parse(fs.readFileSync(path.join(roots[0],'current.json')));
 await run('wger-complement.py',['build','--base',names[0],'--workspace',names[1]],JSON.stringify({baseSha256:manifest.sha256,aliases:[{uid:p.id,label:'Riz cru',terms:'riz',expectedName:p.name}]}));
 const worker=new WgerCatalogWorker(names[0],{localV1:true,complement:names[1]});relay=createWgerRelay({worker,catalog:createWgerLocalCatalog(worker)});await relay.warm();
 routes=foodCatalogRoutes({relay,origin:'http://localhost:5173',limitAddress:()=> '127.0.0.1',json:(res,status,body,headers)=>{res.writeHead(status,{'Content-Type':'application/json',...headers});res.end(JSON.stringify(body));},onEvent:()=>{}});
 assert.deepEqual(await (await fetch(address+'/api/nutrition/catalog/capabilities')).json(),WGER_CAPABILITIES);
 const query='/api/nutrition/catalog/search?q=riz&local=1&lc=fr';
 const response=await fetch(address+query);assert.equal(response.status,200);const body=await response.json();assert.equal(body.products[0].id,p.id);assert.equal(body.products[0].name,'Riz cru');assert.equal(body.products[0].food.nutrients.protein,7.123);
 const selected=await (await fetch(address+'/api/nutrition/catalog/product?id='+p.id)).json();assert.deepEqual(selected.product.food,p.food);
 assert.equal((await fetch(address+'/api/nutrition/catalog/product?code=00012346')).status,404);
 assert.equal((await fetch(address+query,{headers:{Origin:'https://foreign.example'}})).status,403);
 assert.equal((await fetch(address+query+'&staging=1')).status,400);
 const simultaneous=await Promise.all(Array.from({length:4},()=>fetch(address+query)));assert.ok(simultaneous.every(r=>r.status===200));
 const child=worker.child;await new Promise(resolve=>{child.once('close',resolve);child.kill('SIGKILL');});
 assert.equal((await fetch(address+query)).status,200);
});
