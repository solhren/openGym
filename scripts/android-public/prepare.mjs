#!/usr/bin/env node
// Public, read-only preflight. Does not run npm, Gradle, signing or networking.
import { readFileSync, statfsSync } from 'node:fs'
import { freemem } from 'node:os'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const GiB = 1024 ** 3
export const GENERIC_ENV = Object.freeze({
  VITE_MOBILE: '1', VITE_NUTRITION_LOCAL_V1: '1',
  VITE_OPENGYM_PERSONAL_BETA: '0', VITE_NUTRITION_CATALOG_ORIGIN: '',
  VITE_UMAMI_SRC: '', VITE_UMAMI_ID: '',
  APP_MEDIA_DIR: '', VITE_CLIP_EXT: 'mp4',
})

export function prepareAndroid({ root, read = readFileSync, disk = statfsSync,
  availableMemory = freemem, nodeVersion = process.versions.node } = {}) {
  if (Number(nodeVersion.split('.')[0]) !== 22) throw Error('Node 22 is required for this preparation')
  const space = disk(root)
  if (Number(space.bavail) * Number(space.bsize) < 20 * GiB) throw Error('Keep at least 20 GiB of free disk space')
  if (availableMemory() < 2 * GiB) throw Error('Keep at least 2 GiB of available RAM')
  const pkg = JSON.parse(read(resolve(root, 'frontend/package.json'), 'utf8'))
  const capacitor = JSON.parse(read(resolve(root, 'frontend/capacitor.config.json'), 'utf8'))
  if (!pkg.scripts?.['build:mobile'] || !capacitor.appId || capacitor.server?.url) throw Error('Expected a local Capacitor shell and the existing build:mobile command')
  return {
    profile: 'generic-paired-local-catalogue',
    build: { cwd: 'frontend', command: ['npm', 'run', 'build:mobile'], env: { ...GENERIC_ENV } },
    appId: capacitor.appId,
    pairing: 'Enter your own HTTPS server in the app; no account or token is embedded and no server address is configured.',
    signing: 'Choose and retain your own signing identity outside this preflight; existing Android package and signing settings are untouched.',
    apkBuilt: false,
  }
}

function availableRam() {
  if (process.platform !== 'linux') return freemem()
  const line = readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+)\s+kB$/m)
  if (!line) throw Error('Cannot determine available RAM')
  return Number(line[1]) * 1024
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw Error('Usage: node scripts/android-public/prepare.mjs (no domain or signing input)')
    const root = fileURLToPath(new URL('../../', import.meta.url))
    console.log(JSON.stringify(prepareAndroid({ root, availableMemory: availableRam }), null, 2))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
