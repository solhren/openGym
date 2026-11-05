#!/usr/bin/env node
// A small publication policy check, not a general GitHub Actions validator.
// Parse YAML rather than searching comments for guards or permission names.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'

const root = fileURLToPath(new URL('../../', import.meta.url))
const personalGuard = ["github.event_name == 'workflow_dispatch'", "github.repository == 'solhren/openGym'", "github.ref == 'refs/heads/feature/nutrition'", "github.actor == 'solhren'"]
const upstreamGuard = ["github.repository == 'DuarteSantos8/openGym'"]
const demoGuard = ["github.event_name == 'workflow_dispatch'", "github.repository == 'solhren/openGym'", "github.actor == 'solhren'", "github.ref == 'refs/heads/review/public-readiness'"]
const gatedJobs = {
  'demo-preview.yml': { build: demoGuard, deploy: [...demoGuard, 'inputs.publish == true'] },
  'docker-publish.yml': { build: upstreamGuard },
  'pages.yml': { build: upstreamGuard, deploy: upstreamGuard },
  'mirror.yml': { mirror: upstreamGuard },
  'android-personal-beta.yml': { apk: personalGuard },
  'android-personal-release.yml': { publish: personalGuard },
  'test.yml': { 'android-personal-beta': personalGuard, 'android-personal-release': personalGuard },
}

/** Check the intended trust boundaries; never execute workflow expressions. */
export function checkWorkflow(name, workflow) {
  const errors = []
  const fail = message => errors.push(`${name}: ${message}`)
  if (!workflow || typeof workflow !== 'object') return [`${name}: expected workflow mapping`]
  if (workflow.permissions?.contents !== 'read' || Object.values(workflow.permissions ?? {}).some(x => x === 'write')) fail('default permissions must be read-only with contents: read')
  const events = typeof workflow.on === 'string' ? [workflow.on] : Array.isArray(workflow.on) ? workflow.on : Object.keys(workflow.on ?? {})
  if (events.some(x => ['pull_request_target', 'workflow_run'].includes(x))) fail('privileged event needs a separate security review')
  if (!workflow.jobs || typeof workflow.jobs !== 'object') fail('missing jobs')
  for (const [id, terms] of Object.entries(gatedJobs[name] ?? {})) {
    const expression = workflow.jobs?.[id]?.if
    // Only conjunctions are allowed. An appended OR could bypass the owner guard.
    const actual = typeof expression === 'string' ? expression.split('&&').map(x => x.trim()) : []
    if (!terms.every(x => actual.includes(x)) || (typeof expression === 'string' && expression.includes('||'))) fail(`${id}: missing or bypassable publication/identity guard`)
  }
  const checkUse = (step, label) => {
    if (step.uses && !step.uses.startsWith('./') && !/^[\w-]+\/[\w/.-]+@[a-f0-9]{40}$/.test(step.uses)) fail(`${label}: external actions must be pinned to a full commit SHA`)
    if (step.uses?.startsWith('actions/checkout@') && step.with?.['persist-credentials'] !== false) fail(`${label}: checkout must not persist credentials`)
  }
  for (const [id, job] of Object.entries(workflow.jobs ?? {})) {
    if (job.secrets === 'inherit') fail(`${id}: pass only explicitly named secrets`)
    if ((job.permissions === 'write-all' || Object.values(job.permissions ?? {}).some(x => x === 'write')) && !gatedJobs[name]?.[id]) fail(`${id}: write permissions outside the reviewed publisher allowlist`)
    checkUse(job, id)
    for (const [i, step] of (job.steps ?? []).entries()) {
      checkUse(step, `${id}/${i}`)
      if (/\$\{\{\s*github\.event\.(?:issue|pull_request|comment|discussion)\./.test(step.run ?? '')) fail(`${id}/${i}: do not interpolate untrusted event text in shell code`)
    }
  }
  return errors
}

export function checkRepository(directory = root) {
  const errors = []
  let workflows = 0
  const workflowDir = path.join(directory, '.github/workflows')
  for (const name of fs.readdirSync(workflowDir).filter(x => /\.ya?ml$/.test(x)).sort()) {
    try { errors.push(...checkWorkflow(name, load(fs.readFileSync(path.join(workflowDir, name), 'utf8')))); workflows++ }
    catch (e) { errors.push(`${name}: ${e.message}`) }
  }
  for (const name of Object.keys(gatedJobs)) if (!fs.existsSync(path.join(workflowDir, name))) errors.push(`${name}: expected guarded workflow missing`)
  const templates = '.github/ISSUE_TEMPLATE'
  const forms = [...fs.readdirSync(path.join(directory, templates)).filter(x => x.endsWith('.yml') && x !== 'config.yml').map(x => `${templates}/${x}`), '.github/VULNERABILITY_REPORT.yml']
  for (const name of forms) {
    try {
      const form = load(fs.readFileSync(path.join(directory, name), 'utf8'))
      if (!form.name || !form.description || !Array.isArray(form.body)) throw new Error('missing form fields')
      const ids = form.body.map(x => x.id).filter(Boolean)
      if (new Set(ids).size !== ids.length) throw new Error('duplicate form IDs')
      if (!form.body.some(x => x.validations?.required)) throw new Error('missing required reproduction/description')
    } catch (e) { errors.push(`${name}: ${e.message}`) }
  }
  const config = load(fs.readFileSync(path.join(directory, templates, 'config.yml'), 'utf8'))
  if (!config.contact_links?.some(x => x.url === 'https://github.com/solhren/openGym/security/policy')) errors.push('missing security policy contact link')
  if (config.contact_links?.some(x => x.url?.startsWith('https://github.com/DuarteSantos8/'))) errors.push('fork support must not redirect to the upstream maintainer')
  if (!fs.existsSync(path.join(directory, '.github/pull_request_template.md'))) errors.push('missing pull request template')
  return { errors, workflows, forms: forms.length }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkRepository()
  if (result.errors.length) { console.error(result.errors.join('\n')); process.exitCode = 1 }
  else console.log(`Publication policy OK: ${result.workflows} workflows, ${result.forms} forms; no Actions jobs executed`)
}
