import { check, contentHash, exactKeys, HASH_PATTERN, isText, COLLECTIONS, validateStamp, jsonClone } from './persistence-contract.js'

export const BACKUP_METADATA = ['nutritionBackupRestores', 'nutritionBackupRestorePreparations', 'nutritionBackupTombstones']

/** These reserved maps carry reconstruction metadata, never authority to acknowledge an
 * operation or delete a target row. Union by key makes restores on several devices additive. */
export async function validateBackupMetadata(extensions = {}) {
  for (const name of BACKUP_METADATA) {
    if (!Object.hasOwn(extensions, name)) continue
    const value = extensions[name]
    exactKeys(value, ['version', 'records'], name)
    check(value.version === 1, name, 'unsupported_backup_metadata')
    check(value.records && typeof value.records === 'object' && !Array.isArray(value.records), name, 'invalid_backup_metadata')
    for (const [hash, row] of Object.entries(value.records)) {
      check(HASH_PATTERN.test(hash), name, 'invalid_backup_metadata')
      if (name !== 'nutritionBackupTombstones') {
        exactKeys(row, name === 'nutritionBackupRestorePreparations' ? ['requestDigest', 'baseDigest'] : ['requestDigest'], name)
        check(typeof row.requestDigest === 'string' && HASH_PATTERN.test(row.requestDigest), name, 'invalid_restore_receipt')
        if (name === 'nutritionBackupRestorePreparations') check(typeof row.baseDigest === 'string' && HASH_PATTERN.test(row.baseDigest), name, 'invalid_restore_receipt')
      } else {
        exactKeys(row, ['collection', 'id', 'stamp'], name)
        check(COLLECTIONS.includes(row.collection) && isText(row.id) && (row.collection !== 'nutritionSettings' || row.id === '$'), name, 'invalid_backup_metadata')
        validateStamp(row.stamp, name)
        check(await contentHash(row) === hash, name, 'backup_metadata_checksum_mismatch')
      }
    }
  }
}

export function unionBackupMetadata(previous, next, path) {
  const records = jsonClone(previous?.records ?? {})
  for (const [hash, value] of Object.entries(next.records)) {
    check(!Object.hasOwn(records, hash) || JSON.stringify(records[hash]) === JSON.stringify(jsonClone(value)), path, 'backup_metadata_collision')
    records[hash] = jsonClone(value)
  }
  return { version: 1, records }
}
