import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import fs from 'node:fs'
import {buildEnvironment,verifyApkEvidence,APPLICATION_ID} from './build.mjs'
const fixture={OPENGYM_PUBLIC_ANDROID_KEYSTORE:'/private/synthetic-public.keystore',OPENGYM_PUBLIC_ANDROID_VERSION_CODE:'42'}
test('generic build uses a separate fixed identity and requires an explicit retained key/version',()=>{
  const env=buildEnvironment({...fixture,VITE_OPENGYM_PERSONAL_BETA:'1',VITE_NUTRITION_CATALOG_ORIGIN:'https://unwanted.example'})
  assert.equal(env.OPENGYM_PUBLIC_ANDROID,'1');assert.equal(env.VITE_OPENGYM_PERSONAL_BETA,'0');assert.equal(env.VITE_OPENGYM_PUBLIC_ANDROID,'1');assert.equal(env.VITE_NUTRITION_CATALOG_ORIGIN,'')
  assert.notEqual(APPLICATION_ID,'ch.duartesantos.opengym.test')
  for(const value of [{},{...fixture,OPENGYM_ANDROID_DEBUG_KEYSTORE:'/never-read-personal-key'},{...fixture,OPENGYM_PUBLIC_ANDROID_KEYSTORE:'relative'},{...fixture,OPENGYM_PUBLIC_ANDROID_VERSION_CODE:'0'},{...fixture,OPENGYM_PUBLIC_ANDROID_VERSION_CODE:'1;command'}])assert.throws(()=>buildEnvironment(value))
})
test('APK attestations reject different/multiple signers, personal identity and wrong version',()=>{
  const certificate=Buffer.from('synthetic-public-certificate'),digest=createHash('sha256').update(certificate).digest('hex')
  const valid={certificate,signerText:`Signer #1 certificate SHA-256 digest: ${digest}`,badging:`package: name='${APPLICATION_ID}' versionCode='42'`,versionCode:'42'}
  assert.equal(verifyApkEvidence(valid),digest)
  assert.throws(()=>verifyApkEvidence({...valid,signerText:valid.signerText+'\n'+valid.signerText}))
  assert.throws(()=>verifyApkEvidence({...valid,certificate:Buffer.from('other')}))
  assert.throws(()=>verifyApkEvidence({...valid,badging:"package: name='ch.duartesantos.opengym.test' versionCode='42'"}))
  assert.throws(()=>verifyApkEvidence({...valid,versionCode:'43'}))
})
test('Android public profile is explicit and leaves private/default resources selected otherwise',()=>{
  const gradle=fs.readFileSync(new URL('../../frontend/android/app/build.gradle',import.meta.url),'utf8')
  assert.match(gradle,/publicAndroid \? "fr\.solhren\.opengym\.selfhosted" : "ch\.duartesantos\.opengym"/)
  assert.match(gradle,/applicationIdSuffix publicAndroid \? "\.debug" : "\.test"/)
  for(const resource of ['network_security_config','backup_rules','data_extraction_rules'])assert.ok(gradle.includes(`'@xml/${resource}_public' : '@xml/${resource}'`))
  const rules=fs.readFileSync(new URL('../../frontend/android/app/src/main/res/xml/data_extraction_rules_public.xml',import.meta.url),'utf8')
  assert.equal((rules.match(/WSSecureStorageSharedPreferences\.xml/g)||[]).length,2)
})
