import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {privateBetaConfig} from '../../api/nutrition/catalog-beta.js';

/** Three private, bounded log files. Never rotates account/catalogue files. */
export function boundedLog(directory,limitBytes=2*1024**2){
 if(!fs.existsSync(directory))fs.mkdirSync(directory,{mode:0o700});
 const dir=fs.lstatSync(directory);if(!dir.isDirectory()||dir.isSymbolicLink()||(dir.mode&0o077))throw Error('unsafe-beta-log-directory');
 const names=['current.log','previous.log','older.log'].map(n=>path.join(directory,n));
 const safe=file=>{if(fs.existsSync(file)){const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||(s.mode&0o077)||s.size>limitBytes)throw Error('unsafe-beta-log');}};
 let fd,bytes=0,window=0,lines=0;
 const open=()=>{safe(names[0]);fd=fs.openSync(names[0],fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_APPEND|fs.constants.O_NOFOLLOW,0o600);bytes=fs.fstatSync(fd).size;};open();
 return {write(channel,chunk){
  const second=Math.floor(Date.now()/1000);if(second!==window){window=second;lines=0;}
  for(const line of chunk.toString('utf8').split('\n')){
   if(!line||++lines>20)continue;
   const text=Buffer.from(`[${channel}] ${line.slice(0,1800)}\n`);
   if(bytes+text.length>limitBytes){fs.closeSync(fd);fd=undefined;for(const n of names)safe(n);if(fs.existsSync(names[1]))fs.renameSync(names[1],names[2]);fs.renameSync(names[0],names[1]);open();}
   fs.writeSync(fd,text);bytes+=text.length;
  }
 },close(){if(fd!==undefined){fs.closeSync(fd);fd=undefined;}}};
}
function resources(data,start=false){
 const s=fs.statfsSync(data),m=Number(fs.readFileSync('/proc/meminfo','utf8').match(/^MemAvailable:\s+(\d+)/m)[1])*1024;
 if(s.bavail*s.bsize<(start?21:20.25)*1024**3||m<(start?3:2.25)*1024**3)throw Error('private-beta-resource-reserve');
}
export async function run({environment=process.env,spawnProcess=spawn}={}){
 const config=privateBetaConfig({environment});if(!config)throw Error('explicit-private-beta-profile-required');resources(config.dataDir,true);
 const log=boundedLog(path.join(config.dataDir,'logs'));
 // Own process group: a stop during pre-listen integrity hashing must also
 // terminate its read-only Python child, never leave an orphan behind.
 const child=spawnProcess(process.execPath,[fileURLToPath(new URL('./entry.mjs',import.meta.url))],{detached:true,stdio:['ignore','pipe','pipe'],env:environment});
 let stopping=false,failed=false,killTimer;
 const signalGroup=signal=>{try{process.kill(-child.pid,signal);}catch(error){if(error.code!=='ESRCH')throw error;}};
 const stop=()=>{if(stopping)return;stopping=true;signalGroup('SIGTERM');killTimer=setTimeout(()=>signalGroup('SIGKILL'),15000);killTimer.unref();};
 const write=channel=>chunk=>{try{log.write(channel,chunk);}catch{failed=true;console.error('private-beta-log-failed');stop();}};
 child.stdout.on('data',write('stdout'));child.stderr.on('data',write('stderr'));
 const timer=setInterval(()=>{try{resources(config.dataDir);}catch{failed=true;console.error('private-beta-resource-reserve');stop();}},5000);timer.unref();
 process.once('SIGTERM',stop);process.once('SIGINT',stop);
 const code=await new Promise(resolve=>{child.once('error',()=>resolve(1));child.once('close',(code)=>resolve(code??1));});
 clearInterval(timer);clearTimeout(killTimer);process.off('SIGTERM',stop);process.off('SIGINT',stop);log.close();process.exitCode=stopping&&!failed?0:failed?1:code;
}
if(process.argv[1]===fileURLToPath(import.meta.url))run().catch(()=>{console.error('private-beta-start-refused');process.exitCode=1;});
