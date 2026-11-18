#!/usr/bin/env node
// Bumps synchronized project SemVer and Android versionCode locally or in CI workspace.
// Never commits, pushes, or publishes releases automatically.
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

export const SEMVER_RE=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const VERSION_CODE_INPUT_RE=/^[1-9][0-9]{0,8}$/
const RELEASE_TAG_VERSION_CODE_RE=/^android-selfhosted-v(?:\d+\.\d+\.\d+-b)?([1-9][0-9]{0,8})$/

const GRADLE_VERSION_CODE_DIRECT_RE=/^([ \t]*versionCode(?:[ \t]*=[ \t]*|[ \t]+))(\d+)([ \t]*(?:\/\/[^\r\n]*)?)$/m
const GRADLE_VERSION_CODE_TERNARY_RE=/^([ \t]*versionCode\b[^\r\n]*?:[ \t]*)(\d+)([ \t]*(?:\/\/[^\r\n]*)?)$/m
const GRADLE_VERSION_NAME_DIRECT_RE=/^([ \t]*versionName(?:[ \t]*=[ \t]*|[ \t]+)")([^"\r\n]+)("[ \t]*(?:\/\/[^\r\n]*)?)$/m
const GRADLE_VERSION_NAME_TERNARY_RE=/^([ \t]*versionName\b[^\r\n]*?:[ \t]*")([^"\r\n]+)("[ \t]*(?:\/\/[^\r\n]*)?)$/m

export function parseSemver(value) {
  if(typeof value!=='string')throw Error(`Invalid SemVer version: ${String(value)}`)
  const match=value.match(SEMVER_RE)
  if(!match)throw Error(`Invalid SemVer version: ${value} (expected X.Y.Z)`)
  return {major:Number(match[1]),minor:Number(match[2]),patch:Number(match[3])}
}

export function compareSemver(a,b) {
  const left=parseSemver(a),right=parseSemver(b)
  if(left.major!==right.major)return left.major>right.major?1:-1
  if(left.minor!==right.minor)return left.minor>right.minor?1:-1
  if(left.patch!==right.patch)return left.patch>right.patch?1:-1
  return 0
}

export function computeNextVersion(currentVersion,target,{allowSame=false}={}) {
  const current=parseSemver(currentVersion)
  if(typeof target!=='string'||!target)throw Error('Specify a bump target: patch, minor, major, or X.Y.Z')
  if(target==='patch')return `${current.major}.${current.minor}.${current.patch+1}`
  if(target==='minor')return `${current.major}.${current.minor+1}.0`
  if(target==='major')return `${current.major+1}.0.0`
  parseSemver(target)
  const cmp=compareSemver(target,currentVersion)
  if(cmp<0)throw Error(`Target version ${target} must not downgrade current version ${currentVersion}`)
  if(cmp===0&&!allowSame)throw Error(`Target version ${target} must be greater than current version ${currentVersion}`)
  return target
}

export function computeNextVersionCode(currentVersionCode,explicitVersionCode) {
  if(!Number.isInteger(currentVersionCode)||currentVersionCode<1||currentVersionCode>999999999) {
    throw Error(`Invalid current versionCode: ${String(currentVersionCode)}`)
  }
  if(explicitVersionCode===undefined||explicitVersionCode===null) {
    const incremented=currentVersionCode+1
    if(incremented>999999999)throw Error('versionCode exceeds maximum allowed limit')
    return incremented
  }
  const raw=String(explicitVersionCode)
  if(!VERSION_CODE_INPUT_RE.test(raw))throw Error(`Invalid --version-code ${raw} (expected positive integer)`)
  const next=Number(raw)
  if(next<=currentVersionCode) {
    throw Error(`Target versionCode ${next} must be greater than current versionCode ${currentVersionCode}`)
  }
  return next
}

export function formatPublicReleaseTag(version,versionCode) {
  parseSemver(version)
  if(!Number.isInteger(versionCode)||versionCode<1||versionCode>999999999) {
    throw Error(`Invalid versionCode: ${String(versionCode)}`)
  }
  return `android-selfhosted-v${version}-b${versionCode}`
}

export function extractPublicVersionCodeFromTag(tag) {
  if(typeof tag!=='string')return null
  const match=tag.trim().match(RELEASE_TAG_VERSION_CODE_RE)
  return match?Number(match[1]):null
}

export function parseGradleVersions(gradleSource) {
  const codeMatch=gradleSource.match(GRADLE_VERSION_CODE_DIRECT_RE)||gradleSource.match(GRADLE_VERSION_CODE_TERNARY_RE)
  if(!codeMatch)throw Error('Could not find versionCode in frontend/android/app/build.gradle')
  const nameMatch=gradleSource.match(GRADLE_VERSION_NAME_DIRECT_RE)||gradleSource.match(GRADLE_VERSION_NAME_TERNARY_RE)
  if(!nameMatch)throw Error('Could not find versionName in frontend/android/app/build.gradle')
  const versionCode=Number(codeMatch[2])
  if(!Number.isInteger(versionCode)||versionCode<1||versionCode>999999999) {
    throw Error(`Invalid versionCode in frontend/android/app/build.gradle: ${codeMatch[2]}`)
  }
  return {versionCode,versionName:nameMatch[2]}
}

export function updateGradleVersions(gradleSource,{version,versionCode}) {
  parseSemver(version)
  if(!Number.isInteger(versionCode)||versionCode<1||versionCode>999999999) {
    throw Error(`Invalid versionCode: ${String(versionCode)}`)
  }
  const codeRegex=GRADLE_VERSION_CODE_DIRECT_RE.test(gradleSource)?GRADLE_VERSION_CODE_DIRECT_RE:GRADLE_VERSION_CODE_TERNARY_RE
  if(!codeRegex.test(gradleSource))throw Error('Could not find versionCode in frontend/android/app/build.gradle')
  const nameRegex=GRADLE_VERSION_NAME_DIRECT_RE.test(gradleSource)?GRADLE_VERSION_NAME_DIRECT_RE:GRADLE_VERSION_NAME_TERNARY_RE
  if(!nameRegex.test(gradleSource))throw Error('Could not find versionName in frontend/android/app/build.gradle')
  let updated=gradleSource.replace(codeRegex,(_,prefix,_current,suffix)=>`${prefix}${versionCode}${suffix}`)
  updated=updated.replace(nameRegex,(_,prefix,_current,suffix)=>`${prefix}${version}${suffix}`)
  return updated
}

function readJsonFile(filePath) {
  const raw=fs.readFileSync(filePath,'utf8')
  const parsed=JSON.parse(raw)
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error(`Expected JSON object in ${filePath}`)
  return {raw,parsed}
}

function writeJsonPreservingFormat(filePath,raw,mutator) {
  const eol=raw.includes('\r\n')?'\r\n':'\n'
  const hasTrailingNewline=raw.endsWith('\n')
  const indentMatch=raw.match(/^(?:\r?\n)*\{\r?\n([ \t]+)"/)
  const indent=indentMatch?indentMatch[1]:'  '
  const data=JSON.parse(raw)
  mutator(data)
  let serialized=JSON.stringify(data,null,indent)
  if(eol==='\r\n')serialized=serialized.replace(/\n/g,'\r\n')
  if(hasTrailingNewline)serialized+=eol
  fs.writeFileSync(filePath,serialized,'utf8')
}

function updateLockfileIfPresent(lockPath,nextVersion) {
  if(!fs.existsSync(lockPath))return false
  const {raw}=readJsonFile(lockPath)
  writeJsonPreservingFormat(lockPath,raw,(lock)=>{
    lock.version=nextVersion
    if(lock.packages&&typeof lock.packages==='object'&&lock.packages['']&&typeof lock.packages['']==='object') {
      lock.packages[''].version=nextVersion
    }
  })
  return true
}

export function readWorkspaceVersions(root) {
  const frontendPkgPath=path.join(root,'frontend/package.json')
  const apiPkgPath=path.join(root,'api/package.json')
  const gradlePath=path.join(root,'frontend/android/app/build.gradle')
  const {parsed:frontendPkg}=readJsonFile(frontendPkgPath)
  const {parsed:apiPkg}=readJsonFile(apiPkgPath)
  const gradleSource=fs.readFileSync(gradlePath,'utf8')
  parseSemver(frontendPkg.version)
  if(typeof apiPkg.version!=='string'||!apiPkg.version.trim()) {
    throw Error('Missing version in api/package.json')
  }
  const {versionCode,versionName}=parseGradleVersions(gradleSource)
  return {
    version:frontendPkg.version,
    apiVersion:apiPkg.version,
    gradleVersionName:versionName,
    versionCode,
  }
}

export function bumpVersion({root,target,versionCode,dryRun=false,allowSame=false}) {
  if(!root)throw Error('Workspace root path is required')
  const frontendPkgPath=path.join(root,'frontend/package.json')
  const frontendLockPath=path.join(root,'frontend/package-lock.json')
  const apiPkgPath=path.join(root,'api/package.json')
  const apiLockPath=path.join(root,'api/package-lock.json')
  const gradlePath=path.join(root,'frontend/android/app/build.gradle')

  const {raw:frontendRaw,parsed:frontendPkg}=readJsonFile(frontendPkgPath)
  const {raw:apiRaw,parsed:apiPkg}=readJsonFile(apiPkgPath)
  const gradleSource=fs.readFileSync(gradlePath,'utf8')

  parseSemver(frontendPkg.version)
  if(typeof apiPkg.version!=='string'||!apiPkg.version.trim()) {
    throw Error('Missing version in api/package.json')
  }
  const {versionCode:previousVersionCode}=parseGradleVersions(gradleSource)
  const previousVersion=frontendPkg.version
  const nextVersion=computeNextVersion(previousVersion,target,{allowSame})
  const nextVersionCode=computeNextVersionCode(previousVersionCode,versionCode)
  const releaseTag=formatPublicReleaseTag(nextVersion,nextVersionCode)
  const nextGradle=updateGradleVersions(gradleSource,{version:nextVersion,versionCode:nextVersionCode})

  if(!dryRun) {
    writeJsonPreservingFormat(frontendPkgPath,frontendRaw,(pkg)=>{pkg.version=nextVersion})
    updateLockfileIfPresent(frontendLockPath,nextVersion)
    writeJsonPreservingFormat(apiPkgPath,apiRaw,(pkg)=>{pkg.version=nextVersion})
    updateLockfileIfPresent(apiLockPath,nextVersion)
    fs.writeFileSync(gradlePath,nextGradle,'utf8')
  }

  return {
    previousVersion,
    version:nextVersion,
    previousVersionCode,
    versionCode:nextVersionCode,
    releaseTag,
  }
}

export function parseCliArgs(argv,defaultRoot) {
  let target=null
  let versionCode
  let dryRun=false
  let allowSame=false
  let jsonOnly=false
  let root=defaultRoot
  let help=false

  for(let i=0;i<argv.length;i+=1) {
    const arg=argv[i]
    if(arg==='-h'||arg==='--help') {
      help=true
    } else if(arg==='--dry-run') {
      dryRun=true
    } else if(arg==='--allow-same') {
      allowSame=true
    } else if(arg==='--json') {
      jsonOnly=true
    } else if(arg==='--version-code') {
      if(i+1>=argv.length)throw Error('Missing value for --version-code')
      versionCode=argv[++i]
    } else if(arg.startsWith('--version-code=')) {
      versionCode=arg.slice('--version-code='.length)
    } else if(arg==='--root') {
      if(i+1>=argv.length)throw Error('Missing value for --root')
      root=path.resolve(argv[++i])
    } else if(arg.startsWith('--root=')) {
      root=path.resolve(arg.slice('--root='.length))
    } else if(arg.startsWith('-')) {
      throw Error(`Unknown option: ${arg}`)
    } else if(target===null) {
      target=arg
    } else {
      throw Error(`Unexpected extra argument: ${arg}`)
    }
  }

  if(!help&&!target) {
    throw Error('Usage: node scripts/android-public/bump-version.mjs <patch|minor|major|X.Y.Z> [--version-code N] [--dry-run] [--allow-same] [--json] [--root <dir>]')
  }

  return {target,versionCode,dryRun,allowSame,jsonOnly,root,help}
}

function formatNextInstructions(summary,{dryRun=false}={}) {
  const files=[
    'frontend/package.json',
    'frontend/package-lock.json',
    'api/package.json',
    'api/package-lock.json',
    'frontend/android/app/build.gradle',
  ].join(' ')
  const prefix=dryRun?'[dry-run] No files were modified.\n\n':''
  return (
    `\n${prefix}Next manual steps (never executed automatically):\n`+
    `  git add ${files}\n`+
    `  git commit -m "chore(release): v${summary.version} (android b${summary.versionCode})"\n`+
    `  git push origin main\n`+
    `  gh workflow run android-selfhosted.yml -f version_code=${summary.versionCode} -f publish=true\n`
  )
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const defaultRoot=fileURLToPath(new URL('../../',import.meta.url))
    const options=parseCliArgs(process.argv.slice(2),defaultRoot)
    if(options.help) {
      console.log('Usage: node scripts/android-public/bump-version.mjs <patch|minor|major|X.Y.Z> [--version-code N] [--dry-run] [--allow-same] [--json] [--root <dir>]')
    } else {
      const summary=bumpVersion(options)
      console.log(JSON.stringify(summary,null,2))
      if(!options.jsonOnly) {
        process.stdout.write(formatNextInstructions(summary,{dryRun:options.dryRun}))
      }
    }
  } catch(error) {
    console.error(error.message)
    process.exitCode=1
  }
}
