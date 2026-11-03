// Uses an already installed toolchain. No SDK/JDK installation or deployment.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {betaOrigin} from '../../api/nutrition/catalog-beta.js';
const root=fileURLToPath(new URL('../../',import.meta.url));
function command(bin,args,cwd,env=process.env){const r=spawnSync(bin,args,{cwd,env,stdio:'inherit'});if(r.error||r.status!==0)throw Error(`${bin} failed; no beta APK attested`);}
try{
 if(process.argv.length!==3)throw Error('Usage: node scripts/private-beta/build-android.mjs https://APPROVED-BETA-DOMAIN');
 const target=betaOrigin(process.argv[2]),origin=target.origin;
 if(/(?:^|\.)example\.(?:org|com|net)$/.test(target.hostname))throw Error('A real approved beta domain is required; example fixture domains cannot be packaged');
 if(Number(process.versions.node.split('.')[0])!==22)throw Error('Node 22 required');
 const java=spawnSync('java',['-version'],{encoding:'utf8'});if(java.error||java.status!==0||!/version "21(?:[.\"])/.test(java.stderr+java.stdout))throw Error('JDK 21 must be installed and on PATH; nothing was downloaded');
 const sdk=process.env.ANDROID_HOME||process.env.ANDROID_SDK_ROOT;if(!sdk||!fs.existsSync(path.join(sdk,'platforms/android-35/android.jar')))throw Error('Set ANDROID_HOME to an installed Android SDK including platform 35');
 const signing=process.env.OPENGYM_ANDROID_DEBUG_KEYSTORE;
 if(!signing||!path.isAbsolute(signing)||!fs.lstatSync(signing).isFile()||fs.lstatSync(signing).isSymbolicLink())throw Error('Set OPENGYM_ANDROID_DEBUG_KEYSTORE to the retained private debug keystore; no automatic key is allowed');
 command('npm',['run','build:mobile'],path.join(root,'frontend'),{...process.env,VITE_OPENGYM_PERSONAL_BETA:'1',VITE_NUTRITION_LOCAL_V1:'1',VITE_NUTRITION_CATALOG_ORIGIN:origin});
 command('./gradlew',['--no-daemon','--max-workers=2','assembleDebug'],path.join(root,'frontend/android'));
 const source=path.join(root,'frontend/android/app/build/outputs/apk/debug/app-debug.apk');if(!fs.existsSync(source))throw Error('Gradle returned without APK');
 // Source archives intentionally omit artifacts; create only the output parent
 // when building on a clean workstation, then a fresh private result directory.
 const artifacts=path.join(root,'scripts/nutrition-local-catalog/artifacts');fs.mkdirSync(artifacts,{recursive:true,mode:0o700});
 if(fs.lstatSync(artifacts).isSymbolicLink())throw Error('Unsafe APK artifacts directory');
 const output=path.join(artifacts,'private-beta-apk-'+Date.now());fs.mkdirSync(output,{mode:0o700});
 fs.copyFileSync(source,path.join(output,'opengym-beta-debug.apk'),fs.constants.COPYFILE_EXCL);
 fs.writeFileSync(path.join(output,'build.json'),JSON.stringify({origin,localOnly:true,personalAccountRequired:true,applicationId:'ch.duartesantos.opengym.test',variant:'debug',physicalDeviceTested:false},null,2),{mode:0o600,flag:'wx'});
 console.log('Compiled private beta APK: '+path.join(output,'opengym-beta-debug.apk'));
}catch(error){console.error(error.message);process.exitCode=1;}
