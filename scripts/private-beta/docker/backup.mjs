// Offline whole-instance backup. Refuse uninitialized/wrong-profile volumes;
// stdout contains only the archive, never a success banner or account metadata.
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {privateBetaConfig} from '../../../api/nutrition/catalog-beta.js';
try{
 const config=privateBetaConfig();if(!config?.personal)throw Error('personal-state-required');
 if(process.argv[2]==='--estimate'){
  let total=1024*1024,entries=0;
  const visit=(dir,depth)=>{if(depth>64)throw Error('backup-depth');const stream=fs.opendirSync(dir);try{let item;while((item=stream.readSync())){if(++entries>1000000)throw Error('backup-entry-limit');const file=path.join(dir,item.name),s=fs.lstatSync(file);total+=2048;if(s.isDirectory())visit(file,depth+1);else if(s.isFile())total+=s.size;else throw Error('backup-special-file');}}finally{stream.closeSync();}};
  visit(config.dataDir,0);console.log(Math.ceil(total*1.05));
 }else{
  const child=spawn('tar',['-C',config.dataDir,'-czf','-','.'],{stdio:['ignore','inherit','inherit']});
  child.once('error',()=>{process.exitCode=1;});child.once('close',code=>{process.exitCode=code??1;});
 }
}catch{console.error('Refused backup: valid initialized personal state required');process.exitCode=1;}
