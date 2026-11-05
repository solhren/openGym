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
  for (const field of ["github.actor == 'solhren'", "github.ref == 'refs/heads/feature/nutrition'"]) {
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
