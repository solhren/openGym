// Browser-only build; no API, personal deployment flags, telemetry, or exercise media.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('VITE_')))
env.VITE_DEMO = '1'
const result = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', 'dist-demo'], {
  cwd: fileURLToPath(new URL('../', import.meta.url)), env, stdio: 'inherit',
})
if (result.error) throw result.error
process.exitCode = result.status ?? 1
