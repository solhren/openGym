import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { createGunzip } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { normalizeRecord, projectTsv } from './normalize.mjs'

const MAX_INPUT = 256 * 1024 * 1024, MAX_LINE = 1024 * 1024, MAX_ROWS = 100000
const directory = fileURLToPath(new URL('.', import.meta.url))
const fail = (valid, code) => { if (!valid) throw Error(code) }

/** Decode only complete bounded UTF-8 lines. readline's implicit unbounded buffer
 * is intentionally avoided for untrusted dumps, including compressed inputs.
 */
export async function* jsonLines(stream) {
  let parts = [], size = 0
  for await (const chunk of stream) {
    let start = 0
    for (let i = 0; i < chunk.length; i++) if (chunk[i] === 10) {
      const part = chunk.subarray(start, i); size += part.length
      fail(size <= MAX_LINE, 'oversized-input-line'); parts.push(part)
      const line = Buffer.concat(parts, size); parts = []; size = 0; start = i + 1
      fail(line.length > 0, 'empty-input-line')
      yield new TextDecoder('utf-8', { fatal: true }).decode(line)
    }
    if (start < chunk.length) { const tail = chunk.subarray(start); size += tail.length; fail(size <= MAX_LINE, 'oversized-input-line'); parts.push(tail) }
  }
  fail(size === 0, 'truncated-input-line')
}

function argumentsFor(argv) {
  const options = { workspace: 'trial', source: 'fixture', version: 'synthetic-v1', format: 'jsonl' }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--skip-invalid') options.skipInvalid = true
    else { fail(['--input', '--workspace', '--source', '--version', '--format', '--country', '--expected-input-sha256'].includes(arg) && i + 1 < argv.length, 'invalid-arguments'); options[arg.slice(2)] = argv[++i] }
  }
  fail(options.input && /^[a-zA-Z0-9_-]{1,40}$/.test(options.workspace), 'invalid-arguments')
  fail(['fixture', 'off-jsonl', 'off-tsv'].includes(options.source) && ['jsonl', 'tsv'].includes(options.format), 'invalid-source')
  fail(options.source === 'fixture' || options.source === `off-${options.format}`, 'source-format-mismatch')
  fail(typeof options.version === 'string' && options.version.length > 0 && options.version.length <= 120 && !/[\u0000-\u001f\u007f]/.test(options.version), 'invalid-source-version')
  fail(!options.country || /^[a-z]{2}:[a-z0-9-]{1,60}$/.test(options.country), 'invalid-country')
  fail(!options['expected-input-sha256'] || /^[a-f0-9]{64}$/.test(options['expected-input-sha256']), 'invalid-expected-input-hash')
  return options
}

export async function build(options) {
  const start = performance.now(), before = process.cpuUsage()
  // Limit compressed bytes independently: no multi-GB source is accepted here.
  const stat = fs.statSync(options.input)
  fail(stat.isFile() && stat.size <= MAX_INPUT, 'input-too-large')
  const input = fs.createReadStream(options.input, { highWaterMark: 65536 })
  let inputBytes = 0, normalizedBytes = 0, count = 0, scanned = 0, filtered = 0, rejected = 0, normalizeMs = 0
  const sourceHash = createHash('sha256'), wireHash = createHash('sha256'), reasons = {}
  const limit = new Transform({ transform(chunk, _, callback) {
    inputBytes += chunk.length
    if (inputBytes > MAX_INPUT) return callback(Error('decompressed-input-too-large'))
    sourceHash.update(chunk); callback(null, chunk)
  } })
  const writer = spawn('python3', [directory + 'catalog.py', '--workspace', options.workspace, 'build'], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, SQLITE_TMPDIR: fileURLToPath(new URL(`./artifacts/${options.workspace}/`, import.meta.url)) } })
  writer.stdin.on('error', () => {}) // Rejected writes are handled below, not uncaught.
  let output = ''
  writer.stdout.on('data', b => { output += b; if (output.length > 32768) writer.kill() })
  const writerExit = new Promise((resolve, reject) => { writer.on('error', reject); writer.on('close', (code, signal) => code === 0 ? resolve() : reject(Error(`builder-failed:${code ?? signal}`))) })
  writerExit.catch(() => {})
  let converter, converterExit
  const inputPipeline = pipeline(...(options.input.endsWith('.gz') ? [input, createGunzip(), limit] : [input, limit]))
  inputPipeline.catch(() => {})
  let rows = limit
  if (options.format === 'tsv') {
    converter = spawn('python3', [directory + 'tsv.py'], { stdio: ['pipe', 'pipe', 'inherit'] })
    converter.stdin.on('error', () => {})
    converterExit = new Promise((resolve, reject) => { converter.on('error', reject); converter.on('close', code => code === 0 ? resolve() : reject(Error('tsv-converter-failed'))) })
    converterExit.catch(() => {})
    const bridge = pipeline(limit, converter.stdin); bridge.catch(() => {})
    rows = converter.stdout
    converterExit = Promise.all([converterExit, bridge]); converterExit.catch(() => {})
  }
  const send = async line => { if (!writer.stdin.write(line)) await Promise.race([once(writer.stdin, 'drain'), writerExit.then(() => { throw Error('builder-closed') })]) }
  try {
    for await (const line of jsonLines(rows)) {
      fail(++scanned <= MAX_ROWS, 'too-many-input-products')
      let raw
      try { raw = JSON.parse(line) } // Always fatal, including --skip-invalid.
      catch { throw Error('invalid-json-line') } // No payload fragment in logs.
      let record
      const tick = performance.now()
      try {
        const projected = options.format === 'tsv' ? projectTsv(raw) : { raw }
        record = await normalizeRecord(projected.raw, projected)
      } catch (error) {
        if (!options.skipInvalid || !error.code) throw error
        rejected++; reasons[error.code] = (reasons[error.code] ?? 0) + 1; continue
      } finally { normalizeMs += performance.now() - tick }
      if (options.country && !record.countries.includes(options.country)) { filtered++; continue }
      const message = JSON.stringify({ record }) + '\n'
      fail(Buffer.byteLength(message) <= 16384, 'normalized-record-too-large')
      wireHash.update(message); normalizedBytes += Buffer.byteLength(message); count++
      await send(message)
    }
    await inputPipeline
    if (converterExit) await converterExit
    const inputSha256 = sourceHash.digest('hex')
    fail(!options['expected-input-sha256'] || options['expected-input-sha256'] === inputSha256, 'input-checksum-mismatch')
    await send(JSON.stringify({ seal: { count, digest: wireHash.digest('hex'), source: { kind: options.source, version: options.version, inputSha256, scanned, rejected, filtered } } }) + '\n')
    writer.stdin.end()
    await writerExit
    const cpu = process.cpuUsage(before)
    return { ...JSON.parse(output), totalSeconds: (performance.now() - start) / 1000, nodePeakRssKiB: process.resourceUsage().maxRSS, nodeCpuSeconds: (cpu.user + cpu.system) / 1e6, inputBytes, normalizedBytes, normalizeMs, scanned, rejected, filtered, reasons }
  } finally {
    input.destroy(); limit.destroy(); converter?.kill(); writer.stdin.destroy()
    if (writer.exitCode === null) writer.kill()
    await writerExit.catch(() => {})
    if (converterExit) await converterExit.catch(() => {})
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await build(argumentsFor(process.argv.slice(2))), null, 2)) }
  catch (error) { console.error(JSON.stringify({ error: error.code || error.message })); process.exitCode = 1 }
}
