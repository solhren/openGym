import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {
  bumpVersion,
  compareSemver,
  computeNextVersion,
  computeNextVersionCode,
  extractPublicVersionCodeFromTag,
  parseGradleVersions,
  parseSemver,
  readWorkspaceVersions,
  updateGradleVersions,
} from './bump-version.mjs'

const SCRIPT_PATH=fileURLToPath(new URL('./bump-version.mjs',import.meta.url))

function createFixtureWorkspace(t,{
  version='1.4.1',
  apiVersion=version,
  versionCode=1,
  gradleVersionName=version,
  ternaryGradle=false,
  includeApiLock=true,
  indent='  ',
}={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'opengym-bump-version-'))
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}))

  fs.mkdirSync(path.join(root,'frontend/android/app'),{recursive:true})
  fs.mkdirSync(path.join(root,'api'),{recursive:true})

  const frontendPkg={name:'opengym-frontend',private:true,version,type:'module'}
  const frontendLock={
    name:'opengym-frontend',
    version,
    lockfileVersion:3,
    requires:true,
    packages:{
      '':{name:'opengym-frontend',version,dependencies:{react:'^19.0.0'}},
      'node_modules/react':{version:'19.0.0'},
    },
  }
  const apiPkg={name:'opengym-api',private:true,version:apiVersion}
  const apiLock={
    name:'opengym-api',
    version:apiVersion,
    lockfileVersion:3,
    requires:true,
    packages:{
      '':{name:'opengym-api',version:apiVersion},
      'node_modules/express':{version:'4.21.0'},
    },
  }

  fs.writeFileSync(path.join(root,'frontend/package.json'),JSON.stringify(frontendPkg,null,indent)+'\n')
  fs.writeFileSync(path.join(root,'frontend/package-lock.json'),JSON.stringify(frontendLock,null,indent)+'\n')
  fs.writeFileSync(path.join(root,'api/package.json'),JSON.stringify(apiPkg,null,indent)+'\n')
  if(includeApiLock) {
    fs.writeFileSync(path.join(root,'api/package-lock.json'),JSON.stringify(apiLock,null,indent)+'\n')
  }

  const versionCodeLine=ternaryGradle
    ?`        versionCode publicAndroid ? Integer.parseInt(System.getenv("OPENGYM_PUBLIC_ANDROID_VERSION_CODE") ?: "${versionCode}") : ${versionCode}`
    :`        versionCode ${versionCode}`
  const gradle=`apply plugin: 'com.android.application'

android {
    namespace "ch.duartesantos.opengym"
    defaultConfig {
        applicationId publicAndroid ? "fr.solhren.opengym.selfhosted" : "ch.duartesantos.opengym"
${versionCodeLine}
        versionName "${gradleVersionName}"
    }
}
`
  fs.writeFileSync(path.join(root,'frontend/android/app/build.gradle'),gradle)
  return root
}

test('patch, minor, major, and explicit SemVer bumps update manifests, lockfiles, and build.gradle',(t)=>{
  const rootPatch=createFixtureWorkspace(t,{version:'1.4.1',versionCode:1})
  const patchSummary=bumpVersion({root:rootPatch,target:'patch'})
  assert.deepEqual(patchSummary,{
    previousVersion:'1.4.1',
    version:'1.4.2',
    previousVersionCode:1,
    versionCode:2,
    releaseTag:'android-selfhosted-v1.4.2-b2',
  })
  assert.deepEqual(readWorkspaceVersions(rootPatch),{
    version:'1.4.2',
    apiVersion:'1.4.2',
    gradleVersionName:'1.4.2',
    versionCode:2,
  })

  const rootMinor=createFixtureWorkspace(t,{version:'1.4.1',versionCode:4})
  assert.deepEqual(bumpVersion({root:rootMinor,target:'minor'}),{
    previousVersion:'1.4.1',
    version:'1.5.0',
    previousVersionCode:4,
    versionCode:5,
    releaseTag:'android-selfhosted-v1.5.0-b5',
  })

  const rootMajor=createFixtureWorkspace(t,{version:'1.4.1',versionCode:9})
  assert.deepEqual(bumpVersion({root:rootMajor,target:'major'}),{
    previousVersion:'1.4.1',
    version:'2.0.0',
    previousVersionCode:9,
    versionCode:10,
    releaseTag:'android-selfhosted-v2.0.0-b10',
  })

  const rootExplicit=createFixtureWorkspace(t,{version:'1.4.1',versionCode:3})
  assert.deepEqual(bumpVersion({root:rootExplicit,target:'1.6.3',versionCode:12}),{
    previousVersion:'1.4.1',
    version:'1.6.3',
    previousVersionCode:3,
    versionCode:12,
    releaseTag:'android-selfhosted-v1.6.3-b12',
  })
})

test('refuses SemVer downgrades, malformed versions, same version without --allow-same, and non-increasing versionCode',(t)=>{
  const root=createFixtureWorkspace(t,{version:'1.4.2',versionCode:5})

  for(const badVersion of ['1.4.1','1.3.9','0.9.9','1.4.2','v1.4.3','1.4','1.4.3-beta.1','01.4.3','invalid']) {
    assert.throws(()=>bumpVersion({root,target:badVersion}))
  }
  // Downgrade must still fail even when allowSame is enabled
  assert.throws(()=>bumpVersion({root,target:'1.4.1',allowSame:true}))

  for(const badCode of [5,4,0,-1,'0','5','abc','7;echo']) {
    assert.throws(()=>bumpVersion({root,target:'patch',versionCode:badCode}))
  }

  // Same SemVer succeeds only when allowSame=true and still requires increasing versionCode
  const sameSummary=bumpVersion({root,target:'1.4.2',allowSame:true})
  assert.deepEqual(sameSummary,{
    previousVersion:'1.4.2',
    version:'1.4.2',
    previousVersionCode:5,
    versionCode:6,
    releaseTag:'android-selfhosted-v1.4.2-b6',
  })
})

test('--dry-run computes next summary while leaving every file untouched on disk',(t)=>{
  const root=createFixtureWorkspace(t,{version:'1.4.1',versionCode:2})
  const tracked=[
    'frontend/package.json',
    'frontend/package-lock.json',
    'api/package.json',
    'api/package-lock.json',
    'frontend/android/app/build.gradle',
  ]
  const before=Object.fromEntries(tracked.map((rel)=>[rel,fs.readFileSync(path.join(root,rel),'utf8')]))

  const summary=bumpVersion({root,target:'minor',versionCode:8,dryRun:true})
  assert.deepEqual(summary,{
    previousVersion:'1.4.1',
    version:'1.5.0',
    previousVersionCode:2,
    versionCode:8,
    releaseTag:'android-selfhosted-v1.5.0-b8',
  })

  for(const rel of tracked) {
    assert.equal(fs.readFileSync(path.join(root,rel),'utf8'),before[rel],`${rel} must not change during --dry-run`)
  }
})

test('preserves lockfile formatting and nested dependency versions, and handles ternary build.gradle',(t)=>{
  const root=createFixtureWorkspace(t,{version:'1.4.1',versionCode:7,ternaryGradle:true,indent:'    '})
  bumpVersion({root,target:'patch',versionCode:11})

  const frontendLockRaw=fs.readFileSync(path.join(root,'frontend/package-lock.json'),'utf8')
  assert.match(frontendLockRaw,/^\{\n {4}"name": "opengym-frontend"/)
  assert.ok(frontendLockRaw.endsWith('\n'))
  const frontendLock=JSON.parse(frontendLockRaw)
  assert.equal(frontendLock.version,'1.4.2')
  assert.equal(frontendLock.packages[''].version,'1.4.2')
  assert.equal(frontendLock.packages['node_modules/react'].version,'19.0.0')

  const apiLock=JSON.parse(fs.readFileSync(path.join(root,'api/package-lock.json'),'utf8'))
  assert.equal(apiLock.version,'1.4.2')
  assert.equal(apiLock.packages[''].version,'1.4.2')
  assert.equal(apiLock.packages['node_modules/express'].version,'4.21.0')

  const gradle=fs.readFileSync(path.join(root,'frontend/android/app/build.gradle'),'utf8')
  assert.match(gradle,/publicAndroid \? Integer\.parseInt\(.*\) : 11/)
  assert.match(gradle,/versionName "1\.4\.2"/)
  assert.deepEqual(parseGradleVersions(gradle),{versionCode:11,versionName:'1.4.2'})
})

test('CLI outputs JSON summary and manual git/workflow instructions without executing git',(t)=>{
  const root=createFixtureWorkspace(t,{version:'1.4.1',versionCode:1})

  const runDefault=spawnSync(process.execPath,[SCRIPT_PATH,'patch','--root',root],{encoding:'utf8'})
  assert.equal(runDefault.status,0,runDefault.stderr)
  assert.match(runDefault.stdout,/"releaseTag": "android-selfhosted-v1\.4\.2-b2"/)
  assert.match(runDefault.stdout,/git commit -m "chore\(release\): v1\.4\.2 \(android b2\)"/)
  assert.match(runDefault.stdout,/gh workflow run android-selfhosted\.yml -f version_code=2 -f publish=true/)

  const runJson=spawnSync(process.execPath,[SCRIPT_PATH,'1.5.0','--version-code=9','--dry-run','--json','--root',root],{encoding:'utf8'})
  assert.equal(runJson.status,0,runJson.stderr)
  assert.deepEqual(JSON.parse(runJson.stdout),{
    previousVersion:'1.4.2',
    version:'1.5.0',
    previousVersionCode:2,
    versionCode:9,
    releaseTag:'android-selfhosted-v1.5.0-b9',
  })

  const runFail=spawnSync(process.execPath,[SCRIPT_PATH,'1.0.0','--root',root],{encoding:'utf8'})
  assert.notEqual(runFail.status,0)
})

test('helper functions parse SemVer and extract public release tag versionCode accurately',()=>{
  assert.deepEqual(parseSemver('0.12.34'),{major:0,minor:12,patch:34})
  assert.equal(compareSemver('1.4.2','1.4.1'),1)
  assert.equal(compareSemver('1.4.1','1.4.1'),0)
  assert.equal(compareSemver('1.4.1','2.0.0'),-1)
  assert.equal(computeNextVersion('1.4.1','patch'),'1.4.2')
  assert.equal(computeNextVersionCode(1,undefined),2)
  assert.equal(extractPublicVersionCodeFromTag('android-selfhosted-v1'),1)
  assert.equal(extractPublicVersionCodeFromTag('android-selfhosted-v1.4.2-b2'),2)
  assert.equal(extractPublicVersionCodeFromTag('android-selfhosted-v2.10.0-b105'),105)
  assert.equal(extractPublicVersionCodeFromTag('v1.4.2'),null)
  assert.equal(extractPublicVersionCodeFromTag('android-selfhosted-v0'),null)
  assert.match(
    updateGradleVersions('    versionCode 1\n    versionName "1.4.1"\n',{version:'1.4.2',versionCode:2}),
    /versionCode 2\n    versionName "1\.4\.2"/
  )
})
