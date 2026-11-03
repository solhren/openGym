// Exercises the installed socket bridge without systemd activation, Docker,
// privileged ports, real accounts or changes outside the project runtime.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const runtime=fileURLToPath(new URL('../nutrition-local-catalog/runtime/',import.meta.url));
const dir=fs.mkdtempSync(path.join(runtime,'private-beta-socket-'));
const socket=path.join(dir,'api.sock');
let bridge;
const server=http.createServer((req,res)=>{
 res.setHeader('Content-Type','application/json');
 res.end(JSON.stringify({path:req.url,origin:req.headers.origin,authorization:req.headers.authorization}));
});
try{
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const target='127.0.0.1:'+server.address().port;
 bridge=spawn('/usr/bin/systemd-socket-activate',['-l',socket,'/usr/lib/systemd/systemd-socket-proxyd','--connections-max=8',target],{detached:true,stdio:'ignore'});
 let failure;bridge.once('error',e=>{failure=e;});
 const deadline=Date.now()+5000;
 while(!fs.existsSync(socket)&&Date.now()<deadline&&!failure&&bridge.exitCode===null)await new Promise(r=>setTimeout(r,20));
 if(failure)throw failure;
 assert.ok(fs.existsSync(socket),'socket bridge must become ready');
 const result=await new Promise((resolve,reject)=>{
  const req=http.get({socketPath:socket,path:'/api/config',headers:{Origin:'https://gym.solhren.fr',Authorization:'Bearer synthetic-bridge-test'}},res=>{
   let text='';res.setEncoding('utf8');res.on('data',v=>text+=v);res.once('end',()=>{try{resolve(JSON.parse(text));}catch(e){reject(e);}});
  });req.once('error',reject);req.setTimeout(5000,()=>req.destroy(new Error('bridge verification timed out')));
 });
 assert.deepEqual(result,{path:'/api/config',origin:'https://gym.solhren.fr',authorization:'Bearer synthetic-bridge-test'});
 console.log(JSON.stringify({unixBridge:'passed',apiListen:'127.0.0.1',headersPreserved:true,systemdInstalled:false,dockerTested:false}));
}catch(e){console.error(e.message);process.exitCode=1;}
finally{
 if(bridge?.pid&&bridge.exitCode===null){const exit=new Promise(resolve=>bridge.once('exit',resolve));try{process.kill(-bridge.pid,'SIGTERM');}catch{}await exit;}
 server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
 // Only our freshly created fixture, never a service socket or existing file.
 fs.rmSync(dir,{recursive:true,force:true});
}
