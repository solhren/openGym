import assert from 'node:assert/strict'
import { test } from 'vitest'
import { contentHash, sealDocument } from './persistence-contract.js'
import { prepareCommit } from './persistence-commit.js'
import { encodePartition } from './serialization.js'
import { preserveAcknowledgedValues, publicationRequest, RECEIPT_FORMAT, resolveDelivery, validateConflictArchives, validateNutritionReceipt } from './sync-contract.js'
import { hasCode } from './persistence.test-util.js'
import { markedDomain, marker, entry, scope } from './sync.test-util.js'

async function deliveryFixture() {
  const part = await encodePartition(markedDomain())
  const plan = await prepareCommit({ ...scope, commitId: 'server-publication', baseManifest: null, partitions: [part], pendingOperations: [] })
  const operation = { id: 'checkpoint', stamp: { counter: 2, deviceId: 'a' }, partitions: plan.manifest.partitions, removedPartitionIds: [] }
  const delivery = { operationId: operation.id, operationDigest: await contentHash(operation), expectedHead: null,
    head: plan.head, requestDigest: await contentHash(publicationRequest(plan)), uploads: [part.integrity.digest] }
  const receipt = await sealDocument({ format: RECEIPT_FORMAT, storageVersion: 1, domainVersion: 1, ...scope,
    commitId: plan.head.commitId, requestDigest: delivery.requestDigest, head: plan.head })
  return { plan, operation, delivery, response: { head: plan.head, receipt, repeated: false } }
}

test('Nutrition delivery reconstructs exactly the request bound to its frozen operation and receipt', async () => {
  const f = await deliveryFixture()
  const resolved = await resolveDelivery(f.delivery, scope, f.plan.manifest, f.plan.writes, f.operation)
  assert.deepEqual(resolved.request, publicationRequest(f.plan))
  assert.deepEqual(await validateNutritionReceipt(f.response, f.delivery, scope), f.response.receipt)
})
for (const defect of ['operation', 'request', 'uploads', 'missing-partition', 'scope']) {
  test(`Nutrition delivery refuses ${defect} corruption before network or acknowledgement`, async () => {
    const f = await deliveryFixture(), delivery = structuredClone(f.delivery)
    let partitions = f.plan.writes, expectedScope = scope, expected = 'delivery_operation_mismatch'
    if (defect === 'operation') delivery.operationDigest = '0'.repeat(64)
    if (defect === 'request') { delivery.requestDigest = '0'.repeat(64); expected = 'delivery_request_mismatch' }
    if (defect === 'uploads') { delivery.uploads = ['0'.repeat(64)]; expected = 'missing_partition' }
    if (defect === 'missing-partition') { partitions = []; expected = 'no_complete_commit' }
    if (defect === 'scope') { expectedScope = { ...scope, generation: 'other' }; expected = 'scope_mismatch' }
    await assert.rejects(resolveDelivery(delivery, expectedScope, f.plan.manifest, partitions, f.operation), hasCode(expected))
  })
}
for (const defect of ['request-digest', 'scope', 'head', 'version', 'checksum']) {
  test(`Nutrition validly checksummed ${defect} receipt cannot acknowledge a different publication`, async () => {
    const f = await deliveryFixture(), response = structuredClone(f.response), { integrity: ignored, ...payload } = response.receipt
    let expected = 'receipt_mismatch'
    if (defect === 'request-digest') payload.requestDigest = '0'.repeat(64)
    if (defect === 'scope') { payload.namespace.profileId = 'bob'; expected = 'scope_mismatch' }
    if (defect === 'head') response.head = { ...response.head, commitId: 'wrong' }
    if (defect === 'version') { payload.domainVersion = 2; expected = 'unsupported_domain_version' }
    response.receipt = await sealDocument(payload)
    if (defect === 'checksum') { response.receipt.requestDigest = '0'.repeat(64); expected = 'checksum_mismatch' }
    if (defect === 'head') {
      const { integrity: omitted, ...head } = response.head
      response.head = await sealDocument(head)
    }
    await assert.rejects(validateNutritionReceipt(response, f.delivery, scope), hasCode(expected))
  })
}

test('Nutrition a clean local copy rejects different values carrying unchanged server clocks', () => {
  const before = markedDomain(), after = markedDomain({ records: { foodEntries: [entry({ meal: 'dinner' })] } })
  assert.throws(() => preserveAcknowledgedValues([before], [after]), hasCode('server_untracked_modification'))
  after.sync.edits = [marker('entry-a', 2, 'b')]
  preserveAcknowledgedValues([before], [after])
})

for (const defect of ['checksum', 'version', 'record', 'marker']) test(`Nutrition archived ${defect} corruption cannot hide in an otherwise valid partition`, async () => {
  const variant = { collection: 'foodEntries', id: 'entry-a', record: entry(), marker: marker() }
  let version = 1, code
  if (defect === 'version') { version = 2; code = 'unsupported_conflict_archive' }
  if (defect === 'record') { variant.record.quantity.amount = -1; code = 'positive_number_required' }
  if (defect === 'marker') { variant.marker.id = 'wrong-entry'; code = 'edit_without_record' }
  const hash = defect === 'checksum' ? '0'.repeat(64) : await contentHash(variant)
  const part = markedDomain({ extensions: { nutritionSyncConflicts: { version, records: { [hash]: variant } } } })
  if (defect === 'checksum') code = 'conflict_archive_checksum_mismatch'
  // The portable core intentionally accepts opaque JSON extensions; the dedicated client
  // protocol must validate the reserved archive rather than weakening business validators.
  await encodePartition(part)
  await assert.rejects(validateConflictArchives([part]), hasCode(code))
})
