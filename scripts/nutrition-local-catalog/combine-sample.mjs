// Offline streaming-by-page conversion of a verified sample.py capture.
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { inspectExternal, CatalogError } from '../../frontend/src/lib/nutrition/catalog/normalize.js'
import { validateEnvelope, classifyHuggingFace } from './huggingface.mjs'
const fail = (ok, code) => { if (!ok) throw new CatalogError(code) }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = value => JSON.stringify((function sort(v) { return Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sort(v[k])])) : v })(value))

/** Bytes/checksums, schema and row uniqueness are checked again offline. It is
 * permissible to inspect an aborted capture, never to silently import it.
 */
export async function combine(manifestFile, output, { retainUnusableNutrition = false } = {}) {
  const artifacts = fs.realpathSync(fileURLToPath(new URL('./artifacts', import.meta.url)))
  const root = fs.realpathSync(path.dirname(path.resolve(manifestFile)))
  const outRoot = fs.realpathSync(path.dirname(path.resolve(output)))
  fail(root.startsWith(artifacts+path.sep) && outRoot === root, 'unsafe-sample-path')
  fail(fs.lstatSync(manifestFile).isFile() && fs.statSync(manifestFile).size <= 65536, 'invalid-sample-manifest')
  const bytes = fs.readFileSync(manifestFile), manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  inspectExternal(manifest)
  fail(manifest.format === 'opengym-hf-sample' && manifest.version === 1 && manifest.complete === true && manifest.source === 'https://huggingface.co/datasets/openfoodfacts/product-database' && manifest.license === 'ODbL-1.0' && manifest.contentLicense === 'DbCL-1.0', 'invalid-sample-manifest')
  fail(Array.isArray(manifest.pages) && manifest.pages.length >= 1 && manifest.pages.length <= 20 && Number.isSafeInteger(manifest.bytes) && manifest.bytes <= 32*1024*1024 && Number.isInteger(manifest.rows) && manifest.rows > 0 && manifest.rows <= 2000, 'invalid-sample-budget')
  const temporary = path.join(root, `.combined-${randomUUID()}.tmp`)
  let fd, inputBytes = 0, rows = 0, projected = 0
  const indices = new Set(), files = new Set(), rejects = [], recovered = [], digest = createHash('sha256')
  const classes = { complete: 0, partial: 0, unusable: 0 }
  try {
    fd = fs.openSync(temporary, 'wx', 0o600)
    for (const page of manifest.pages) {
      fail(typeof page.file === 'string' && /^page-\d{3}\.json$/.test(page.file) && !files.has(page.file) && Number.isInteger(page.bytes) && page.bytes > 0 && page.bytes <= 8*1024*1024, 'invalid-sample-page')
      files.add(page.file)
      const source = path.join(root, page.file)
      fail(fs.lstatSync(source).isFile() && fs.statSync(source).size === page.bytes, 'invalid-sample-page')
      const data = fs.readFileSync(source); inputBytes += data.length
      fail(hash(data) === page.sha256 && inputBytes <= 32*1024*1024, 'sample-checksum-mismatch')
      const envelope = validateEnvelope(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)))
      fail(hash(canonical(envelope.features)) === manifest.schemaSha256, 'sample-schema-mismatch')
      fail(envelope.num_rows_total === manifest.totalRowsReported && envelope.rows.length === page.rows, 'incomplete-sample-page')
      for (const item of envelope.rows) {
        fail(!indices.has(item.row_idx), 'duplicate-sample-row'); indices.add(item.row_idx); rows++
        try {
          const result = await classifyHuggingFace(item.row, { retainUnusableNutrition })
          const wire = JSON.stringify(result.raw)+'\n'; fs.writeFileSync(fd, wire); digest.update(wire); projected++; classes[result.status]++
          if (result.originalError) recovered.push({ rowIndex: item.row_idx, code: result.record.code, reason: result.originalError })
        } catch (error) {
          if (!(error instanceof CatalogError)) throw error
          rejects.push({ rowIndex: item.row_idx, reason: error.code })
        }
      }
    }
    fail(rows === manifest.rows && inputBytes === manifest.bytes && projected > 0, 'incomplete-sample')
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined
    fs.linkSync(temporary, output); fs.unlinkSync(temporary)
    const directory = fs.openSync(root, 'r'); try { fs.fsyncSync(directory) } finally { fs.closeSync(directory) }
    return { rows, projected, classes, rejected: rejects, recoveredNutrition: recovered, inputBytes, manifestSha256: hash(bytes), jsonlSha256: digest.digest('hex'), sourceVersion: 'hf-batch-v1-'+hash(bytes) }
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [source, output, mode] = process.argv.slice(2)
  try {
    fail(source && output && process.argv.length <= 5 && (!mode || mode === '--retain-unusable-nutrition'), 'invalid-sample-arguments')
    console.log(JSON.stringify(await combine(source, output, { retainUnusableNutrition: Boolean(mode) }), null, 2))
  } catch (error) { console.error(JSON.stringify({ error: error.code || 'sample-conversion-failed' })); process.exitCode = 1 }
}
