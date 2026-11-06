import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import crypto from 'node:crypto';
import {betaDataPath,betaOrigin,BETA_MARKER} from '../../api/nutrition/catalog-beta.js';
export function initializeState(directory,origin,{personal=false}={}){
 betaDataPath(directory);betaOrigin(origin);
 if(!fs.existsSync(directory))fs.mkdirSync(directory,{mode:0o700});
 const s=fs.lstatSync(directory);
 if(!s.isDirectory()||s.isSymbolicLink()||fs.realpathSync(directory)!==directory||(s.mode&0o077)||fs.readdirSync(directory).length)throw Error('beta-state-must-be-empty-private-directory');
 const write=(name,value)=>{const fd=fs.openSync(path.join(directory,name),fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);try{fs.writeFileSync(fd,value);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}};
 if(personal){
  // 128-bit invite, within the existing registration field's 40-char limit.
  const code=crypto.randomBytes(16).toString('hex').toUpperCase();
  write('db.json',JSON.stringify({users:[],creds:[],subs:[],invites:[{code,note:'single-owner bootstrap',createdBy:'local-bootstrap',created:new Date().toISOString()}],personalOwner:null}));
  write('bootstrap-invite.txt',code+'\n');
 }
 // Publish last: an interrupted seed cannot be adopted by the beta process.
 write(BETA_MARKER,JSON.stringify({format:'opengym-private-beta-state',version:personal?2:1,origin,...(personal?{personal:true}:{})}));
 const parent=fs.openSync(directory,'r');try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 try{if(![4,5].includes(process.argv.length)||process.argv[4]&&process.argv[4]!=='--personal')throw Error('Usage: node init-state.mjs EMPTY_BETA_DATA_DIR https://gym.example.com [--personal]');initializeState(process.argv[2],process.argv[3],{personal:process.argv[4]==='--personal'});console.log('Isolated beta state initialized; no account/password created. Personal bootstrap invite stays in the private state directory.');}
 catch(error){console.error(error.message);process.exitCode=1;}
}
