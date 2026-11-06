#!/usr/bin/env node
// Uses a preinstalled SDK and a separately retained signing key. Never generates a
// key, publishes an artifact, or reads personal-beta signing configuration.
import fs from 'node:fs'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {GENERIC_ENV,prepareAndroid} from './prepare.mjs'

export const APPLICATION_ID='fr.solhren.opengym.selfhosted.debug'
export function buildEnvironment(env) {
  if(env.OPENGYM_ANDROID_DEBUG_KEYSTORE)throw Error('Personal beta signing environment must not be used')
  if(!env.OPENGYM_PUBLIC_ANDROID_KEYSTORE||!path.isAbsolute(env.OPENGYM_PUBLIC_ANDROID_KEYSTORE))throw Error('Set the separate retained OPENGYM_PUBLIC_ANDROID_KEYSTORE absolute path')
  if(!/^[1-9][0-9]{0,8}$/.test(env.OPENGYM_PUBLIC_ANDROID_VERSION_CODE||''))throw Error('Set an increasing OPENGYM_PUBLIC_ANDROID_VERSION_CODE')
  return {...env,...GENERIC_ENV,OPENGYM_PUBLIC_ANDROID:'1'}
}
export function verifyApkEvidence({certificate,signerText,badging,versionCode}) {
  const sha256=createHash('sha256').update(certificate).digest('hex')
  const signers=[...signerText.matchAll(/Signer #\d+ certificate SHA-256 digest:\s*([a-f\d]{64})/gi)]
  if(signers.length!==1||signers[0][1].toLowerCase()!==sha256)throw Error('APK signer does not match the retained public key')
  if(!badging.includes(`package: name='${APPLICATION_ID}'`)||!badging.includes(`versionCode='${versionCode}'`))throw Error('Unexpected APK package or version code')
  return sha256
}

function run(bin,args,cwd,env,{capture=false}={}) {
  const result=spawnSync(bin,args,{cwd,env,...(capture?{encoding:null,stdio:['ignore','pipe','pipe'],maxBuffer:2*1024*1024}:{stdio:'inherit'})})
  if(result.error||result.status!==0)throw Error(`${path.basename(bin)} failed; no APK attested`)
  return result.stdout
}
function availableRam(){const line=fs.readFileSync('/proc/meminfo','utf8').match(/^MemAvailable:\s+(\d+)\s+kB$/m);if(!line)throw Error('Cannot determine available RAM');return Number(line[1])*1024}

export function build(root,env=process.env) {
  const configured=buildEnvironment(env)
  prepareAndroid({root,...(process.platform==='linux'?{availableMemory:availableRam}:{})})
  const java=spawnSync('java',['-version'],{encoding:'utf8'})
  if(java.error||java.status!==0||!/version "21(?:[.\"])/.test(java.stderr+java.stdout))throw Error('JDK 21 is required; no tools were downloaded')
  const sdk=env.ANDROID_HOME||env.ANDROID_SDK_ROOT
  if(!sdk||!fs.existsSync(path.join(sdk,'platforms/android-35/android.jar')))throw Error('Installed Android SDK platform 35 is required')
  const buildTools=path.join(sdk,'build-tools/35.0.0')
  for(const executable of ['apksigner','aapt'])if(!fs.existsSync(path.join(buildTools,executable)))throw Error('Installed Android build-tools 35.0.0 are required')
  const key=fs.lstatSync(configured.OPENGYM_PUBLIC_ANDROID_KEYSTORE)
  if(!key.isFile()||key.isSymbolicLink()||key.size>65536||key.size===0)throw Error('Invalid retained public signing key file')
  // Certificate bytes are public, but not printed; the private keystore never enters output.
  const certificate=run('keytool',['-exportcert','-keystore',configured.OPENGYM_PUBLIC_ANDROID_KEYSTORE,'-storepass','android','-alias','androiddebugkey'],root,configured,{capture:true})
  run('npm',['run','build:mobile'],path.join(root,'frontend'),configured)
  prepareAndroid({root,...(process.platform==='linux'?{availableMemory:availableRam}:{})})
  run('./gradlew',['--no-daemon','--max-workers=1','-Dorg.gradle.jvmargs=-Xmx512m','assembleDebug'],path.join(root,'frontend/android'),configured)
  const apk=path.join(root,'frontend/android/app/build/outputs/apk/debug/app-debug.apk')
  const signerText=run(path.join(buildTools,'apksigner'),['verify','--print-certs',apk],root,configured,{capture:true}).toString('utf8')
  const badging=run(path.join(buildTools,'aapt'),['dump','badging',apk],root,configured,{capture:true}).toString('utf8')
  const permissions=run(path.join(buildTools,'aapt'),['dump','permissions',apk],root,configured,{capture:true}).toString('utf8')
  const signerSha256=verifyApkEvidence({certificate,signerText,badging,versionCode:configured.OPENGYM_PUBLIC_ANDROID_VERSION_CODE})
  const outputRoot=path.join(root,'scripts/nutrition-local-catalog/artifacts')
  fs.mkdirSync(outputRoot,{recursive:true,mode:0o700})
  if(fs.lstatSync(outputRoot).isSymbolicLink())throw Error('Unsafe output directory')
  const output=fs.mkdtempSync(path.join(outputRoot,'selfhosted-apk-'))
  fs.copyFileSync(apk,path.join(output,'opengym-selfhosted-debug.apk'),fs.constants.COPYFILE_EXCL)
  const hash=createHash('sha256');const fd=fs.openSync(apk,'r');const buffer=Buffer.alloc(1024*1024)
  try{let read;while((read=fs.readSync(fd,buffer,0,buffer.length,null))>0)hash.update(buffer.subarray(0,read))}finally{fs.closeSync(fd)}
  const apkSha256=hash.digest('hex')
  const permissionsPath=path.join(output,'permissions.txt')
  fs.writeFileSync(permissionsPath,permissions,{flag:'wx',mode:0o600})
  const inspection=JSON.parse(run('python3',[path.join(root,'scripts/android-public/inspect-apk.py'),apk,permissionsPath],root,configured,{capture:true}).toString('utf8'))
  fs.writeFileSync(path.join(output,'opengym-selfhosted-debug.apk.sha256'),`${apkSha256}  opengym-selfhosted-debug.apk\n`,{flag:'wx',mode:0o600})
  fs.writeFileSync(path.join(output,'build.json'),JSON.stringify({applicationId:APPLICATION_ID,versionCode:Number(configured.OPENGYM_PUBLIC_ANDROID_VERSION_CODE),profile:'selfhosted',variant:'debug',server:null,localFoodOnly:true,signerSha256,apkSha256,physicalDeviceTested:false,inspection},null,2)+'\n',{flag:'wx',mode:0o600})
  return output
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try{if(process.argv.length!==2)throw Error('Usage: node scripts/android-public/build.mjs');console.log('Verified self-hosted debug APK: '+build(fileURLToPath(new URL('../../',import.meta.url))))}
  catch(error){console.error(error.message);process.exitCode=1}
}
