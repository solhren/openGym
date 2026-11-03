// Explicit private-beta profile only. No effect on ordinary production/dev runs.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const runtime=fileURLToPath(new URL('../../scripts/nutrition-local-catalog/runtime/',import.meta.url));
export const BETA_MARKER='.opengym-private-beta.json';
const requireBeta=ok=>{if(!ok)throw new Error('invalid-private-beta-configuration');};
export function betaOrigin(value){
 requireBeta(typeof value==='string');
 let u;try{u=new URL(value);}catch{requireBeta(false);}
 requireBeta(typeof value==='string'&&u.origin===value&&u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(u.hostname)&&!/(?:^|\.)(?:localhost|local|invalid|test|example)$/.test(u.hostname));
 return u;
}
export function betaDataPath(value){
 requireBeta(typeof value==='string'&&path.isAbsolute(value)&&path.resolve(value)===value&&(value==='/var/lib/opengym-beta'||value.startsWith(runtime+'private-beta-')));
 return value;
}
/** Validate before the API opens any account files. An origin-bound marker may
 * only be initialized in an empty beta directory, never in an existing profile.
 */
export function privateBetaConfig({environment=process.env,dataDir=environment.DATA_DIR}={}){
 if(environment.OPENGYM_BETA_DOCKER==='1')requireBeta(environment.OPENGYM_PRIVATE_BETA==='1'&&environment.OPENGYM_PERSONAL_BETA==='1');
 if(environment.OPENGYM_PRIVATE_BETA!=='1')return null;
 const u=betaOrigin(environment.ORIGIN),data=betaDataPath(dataDir);
 const personal=environment.OPENGYM_PERSONAL_BETA==='1';
 if(personal)requireBeta(environment.ALLOW_GUEST==='0'&&environment.INVITE_ONLY==='1'&&environment.BETA_MAX_USERS==='1');
 requireBeta(environment.NODE_ENV==='production'&&environment.RP_ID===u.hostname&&environment.NUTRITION_LOCAL_CATALOG==='1'&&environment.NUTRITION_LOCAL_CATALOG_KIND==='wger-v1');
 const names=['WORKSPACE','COMPLEMENT','REFERENCE','REFERENCE_INDEX'];
 requireBeta(names.every(k=>typeof environment['NUTRITION_LOCAL_CATALOG_'+k]==='string'&&/^[A-Za-z0-9_-]{1,40}$/.test(environment['NUTRITION_LOCAL_CATALOG_'+k])));
 const dir=fs.lstatSync(data);requireBeta(dir.isDirectory()&&!dir.isSymbolicLink()&&fs.realpathSync(data)===data&&(dir.mode&0o077)===0);
 const marker=path.join(data,BETA_MARKER),stat=fs.lstatSync(marker);
 requireBeta(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size<=1024&&(stat.mode&0o077)===0);
 const m=JSON.parse(fs.readFileSync(marker,'utf8'));
 requireBeta(m.format==='opengym-private-beta-state'&&m.origin===u.origin);
 requireBeta(personal?Object.keys(m).sort().join(',')==='format,origin,personal,version'&&m.version===2&&m.personal===true:Object.keys(m).sort().join(',')==='format,origin,version'&&m.version===1);
 if(personal){const db=fs.lstatSync(path.join(data,'db.json'));requireBeta(db.isFile()&&!db.isSymbolicLink()&&db.size>0&&(db.mode&0o077)===0);}
 return Object.freeze({origin:u.origin,host:u.hostname,dataDir:data,personal,listenHost:environment.OPENGYM_BETA_DOCKER==='1'?'0.0.0.0':'127.0.0.1'});
}
