import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildEnvironment,
  verifyApkEvidence,
  readPublicVersionName,
  formatReleaseTag,
  createUpdateManifest,
  APPLICATION_ID,
} from './build.mjs'
const fixture={OPENGYM_PUBLIC_ANDROID_KEYSTORE:'/private/synthetic-public.keystore',OPENGYM_PUBLIC_ANDROID_VERSION_CODE:'42'}
test('generic build uses a separate fixed identity and requires an explicit retained key/version',()=>{
  const env=buildEnvironment({...fixture,VITE_OPENGYM_PERSONAL_BETA:'1',VITE_NUTRITION_CATALOG_ORIGIN:'https://unwanted.example'})
  assert.equal(env.OPENGYM_PUBLIC_ANDROID,'1');assert.equal(env.VITE_OPENGYM_PERSONAL_BETA,'0');assert.equal(env.VITE_OPENGYM_PUBLIC_ANDROID,'1');assert.equal(env.VITE_NUTRITION_CATALOG_ORIGIN,'')
  assert.notEqual(APPLICATION_ID,'ch.duartesantos.opengym.test')
  for(const value of [{},{...fixture,OPENGYM_ANDROID_DEBUG_KEYSTORE:'/never-read-personal-key'},{...fixture,OPENGYM_PUBLIC_ANDROID_KEYSTORE:'relative'},{...fixture,OPENGYM_PUBLIC_ANDROID_VERSION_CODE:'0'},{...fixture,OPENGYM_PUBLIC_ANDROID_VERSION_CODE:'1;command'}])assert.throws(()=>buildEnvironment(value))
})
test('APK attestations reject different/multiple signers, personal identity and wrong version',()=>{
  const certificate=Buffer.from('synthetic-public-certificate'),digest=createHash('sha256').update(certificate).digest('hex')
  const valid={certificate,signerText:`Signer #1 certificate SHA-256 digest: ${digest}`,badging:`package: name='${APPLICATION_ID}' versionCode='42' versionName='1.4.2'`,versionCode:'42',versionName:'1.4.2'}
  assert.equal(verifyApkEvidence(valid),digest)
  // Backward compatibility when versionName is omitted
  assert.equal(verifyApkEvidence({certificate,signerText:valid.signerText,badging:`package: name='${APPLICATION_ID}' versionCode='42'`,versionCode:'42'}),digest)
  assert.throws(()=>verifyApkEvidence({...valid,signerText:valid.signerText+'\n'+valid.signerText}))
  assert.throws(()=>verifyApkEvidence({...valid,certificate:Buffer.from('other')}))
  assert.throws(()=>verifyApkEvidence({...valid,badging:"package: name='ch.duartesantos.opengym.test' versionCode='42' versionName='1.4.2'"}))
  assert.throws(()=>verifyApkEvidence({...valid,versionCode:'43'}))
  assert.throws(()=>verifyApkEvidence({...valid,versionName:'1.4.1'}))
  assert.throws(()=>verifyApkEvidence({...valid,versionName:'1.4.2-beta'}))
})
test('versionName reader, release tag formatter, and update-manifest schema match self-hosted updater contract',(t)=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'opengym-build-test-'))
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}))
  fs.mkdirSync(path.join(root,'frontend'),{recursive:true})
  fs.writeFileSync(path.join(root,'frontend/package.json'),JSON.stringify({name:'opengym-frontend',version:'1.4.2'})+'\n')
  assert.equal(readPublicVersionName(root),'1.4.2')
  assert.equal(formatReleaseTag('1.4.2','42'),'android-selfhosted-v1.4.2-b42')

  const apkSha256='a'.repeat(64)
  const signerSha256='b'.repeat(64)
  assert.deepEqual(createUpdateManifest({versionName:'1.4.2',versionCode:'42',apkSha256,signerSha256}),{
    schemaVersion:1,
    channel:'selfhosted',
    applicationId:APPLICATION_ID,
    version:'1.4.2',
    versionCode:42,
    apkAsset:'opengym-selfhosted-debug.apk',
    sha256Asset:'opengym-selfhosted-debug.apk.sha256',
    apkSha256,
    signerSha256,
  })

  fs.writeFileSync(path.join(root,'frontend/package.json'),JSON.stringify({name:'opengym-frontend',version:'1.4.2-rc1'})+'\n')
  assert.throws(()=>readPublicVersionName(root))
  assert.throws(()=>formatReleaseTag('v1.4.2',42))
  assert.throws(()=>createUpdateManifest({versionName:'1.4',versionCode:42,apkSha256,signerSha256}))
})
test('Android public profile is explicit and leaves private/default resources selected otherwise',()=>{
  const gradle=fs.readFileSync(new URL('../../frontend/android/app/build.gradle',import.meta.url),'utf8')
  assert.match(gradle,/publicAndroid \? "fr\.solhren\.opengym\.selfhosted" : "ch\.duartesantos\.opengym"/)
  assert.match(gradle,/applicationIdSuffix publicAndroid \? "\.debug" : "\.test"/)
  for(const resource of ['network_security_config','backup_rules','data_extraction_rules'])assert.ok(gradle.includes(`'@xml/${resource}_public' : '@xml/${resource}'`))
  const rules=fs.readFileSync(new URL('../../frontend/android/app/src/main/res/xml/data_extraction_rules_public.xml',import.meta.url),'utf8')
  assert.equal((rules.match(/WSSecureStorageSharedPreferences\.xml/g)||[]).length,2)
})
test('self-hosted workflow stays workflow_dispatch-only and publishes SemVer-tagged release with update-manifest.json',()=>{
  const workflow=fs.readFileSync(new URL('../../.github/workflows/android-selfhosted.yml',import.meta.url),'utf8')
  assert.match(workflow,/^on:\n  workflow_dispatch:/m)
  assert.doesNotMatch(workflow,/^\s*(push|pull_request|schedule):/m)
  assert.match(workflow,/bump:\n/)
  assert.match(workflow,/prerelease:\n/)
  assert.match(workflow,/node scripts\/android-public\/bump-version\.mjs "\$BUMP" --version-code "\$VERSION_CODE"/)
  assert.match(workflow,/update-manifest\.json/)
  assert.match(workflow,/android-selfhosted-v\$\{VERSION_NAME\}-b\$\{VERSION_CODE\}/)
})
