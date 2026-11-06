import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { load } from 'js-yaml'
import { checkWorkflow, checkRepository } from './check.mjs'

const workflow = name => load(fs.readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8'))
const rejects = (name, change, message) => {
  const data = workflow(name)
  change(data)
  assert.ok(checkWorkflow(name, data).some(x => x.includes(message)))
}

test('repository workflows and contributor forms satisfy publication policy', () => {
  assert.deepEqual(checkRepository().errors, [])
})
test('a release on a fork cannot implicitly enable the inherited image publisher', () => {
  rejects('docker-publish.yml', w => { delete w.jobs.build.if }, 'guard')
})
test('OR cannot bypass an otherwise present publication guard', () => {
  rejects('pages.yml', w => { w.jobs.deploy.if += ' || true' }, 'guard')
})
test('personal APK publication requires the owner and original personal branch', () => {
  for (const field of ["github.actor == github.repository_owner", "github.ref == 'refs/heads/feature/nutrition'"]) {
    rejects('android-personal-release.yml', w => { w.jobs.publish.if = w.jobs.publish.if.replace(field, 'true') }, 'guard')
  }
})
test('mutable actions and persisted checkout credentials are rejected', () => {
  rejects('catalogue.yml', w => { w.jobs.validate.steps[0].uses = 'actions/checkout@v7' }, 'full commit SHA')
  rejects('catalogue.yml', w => { delete w.jobs.validate.steps[0].with }, 'persist credentials')
})
test('unreviewed write jobs and globally elevated permissions are rejected', () => {
  rejects('test.yml', w => { w.jobs.api.permissions = { contents: 'write' } }, 'write permissions')
  rejects('test.yml', w => { w.permissions['id-token'] = 'write' }, 'default permissions')
})
test('privileged PR execution and broad secret inheritance are rejected', () => {
  rejects('test.yml', w => { w.on.pull_request_target = {} }, 'privileged event')
  rejects('test.yml', w => { w.jobs['android-personal-beta'].secrets = 'inherit' }, 'named secrets')
})
test('untrusted issue or PR text cannot be interpolated into shell commands', () => {
  rejects('test.yml', w => { w.jobs.api.steps.push({ run: 'echo "${{ github.event.pull_request.title }}"' }) }, 'untrusted event')
})
test('duplicate YAML keys fail parsing rather than hiding a guard or permission', () => {
  assert.throws(() => load('permissions:\n  contents: read\npermissions:\n  contents: write\n'), /duplicated mapping key/)
})

test('browser demo requires owner, reviewed branch and explicit publication opt-in', () => {
  const demo = workflow('demo-preview.yml')
  assert.deepEqual(Object.keys(demo.on), ['workflow_dispatch'])
  assert.equal(demo.on.workflow_dispatch.inputs.publish.default, false)
  for (const term of ["github.actor == github.repository_owner", "github.ref == 'refs/heads/review/public-readiness'", 'inputs.publish == true']) {
    rejects('demo-preview.yml', w => { w.jobs.deploy.if = w.jobs.deploy.if.replace(term, 'true') }, 'guard')
  }
  assert.ok(!JSON.stringify(demo).includes('stage-media'))
})

test('Pages timeout leaves runner headroom for diagnostics without extending the provider deadline', () => {
  const demo = workflow('demo-preview.yml')
  const deploy = demo.jobs.deploy
  const action = deploy.steps.find(step => step.id === 'deploy')
  assert.equal(Number(action.with.timeout), 600000)
  assert.equal(action.with.artifact_name, 'github-pages')
  assert.equal(deploy['timeout-minutes'], 12)
  assert.ok(deploy['timeout-minutes'] * 60000 >= Number(action.with.timeout) + 120000)
  for (const job of [demo.jobs.build, deploy]) assert.equal(job['runs-on'], 'ubuntu-24.04')
})

test('personal Android workflows require the same explicit origin through build and publication',()=>{
 for(const name of ['android-personal-beta.yml','android-personal-release.yml']){const w=workflow(name);assert.equal(w.on.workflow_call.inputs.origin.required,true);assert.equal(w.on.workflow_call.inputs.origin.default,undefined);assert.equal(Object.values(w.jobs)[0].env.OPENGYM_ORIGIN,'${{ inputs.origin }}')}
 const w=workflow('test.yml');for(const name of ['android-personal-beta','android-personal-release'])assert.equal(w.jobs[name].with.origin,'${{ inputs.android_origin }}');
});
