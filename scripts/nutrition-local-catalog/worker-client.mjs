import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { CatalogError, inspectExternal } from '../../frontend/src/lib/nutrition/catalog/normalize.js'

const fail = code => new CatalogError(code)
/** Prototype supervisor: one read-only process, bounded queue and protocol. A
 * timeout kills the reader; later requests restart only after its confirmed exit.
 * No retries of failed requests, no HTTP route, no writable operation.
 */
export class CatalogWorker {
  constructor(workspace, { timeoutMs = 10000, startupTimeoutMs = timeoutMs, spawnProcess = spawn } = {}) {
    if (typeof workspace !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(workspace) || !Number.isInteger(timeoutMs) || timeoutMs < 20 || timeoutMs > 30000) throw fail('invalid-worker-options')
    if (!Number.isInteger(startupTimeoutMs) || startupTimeoutMs < timeoutMs || startupTimeoutMs > 90000) throw fail('invalid-worker-options')
    this.workspace = workspace; this.timeoutMs = timeoutMs; this.startupTimeoutMs = startupTimeoutMs; this.ready = false; this.spawnProcess = spawnProcess
    this.queue = []; this.active = null; this.child = null; this.stopping = false; this.closed = false; this.sequence = 0; this.starts = []
  }
  request(op, args = {}, { signal } = {}) {
    if (this.closed) return Promise.reject(fail('worker-closed'))
    if (signal?.aborted) return Promise.reject(fail('worker-cancelled'))
    if (!['search', 'barcode', 'product', 'inspect'].includes(op) || !args || Object.getPrototypeOf(args) !== Object.prototype) return Promise.reject(fail('invalid-worker-request'))
    const id = ++this.sequence
    let wire
    try { inspectExternal(args); wire = JSON.stringify({ v: 1, id, op, args })+'\n' } catch { return Promise.reject(fail('invalid-worker-request')) }
    if (Buffer.byteLength(wire) > 4096) return Promise.reject(fail('worker-request-too-large'))
    if (this.queue.length >= 16) return Promise.reject(fail('worker-busy'))
    return new Promise((resolve, reject) => {
      const task = { id, wire, resolve: v => { signal?.removeEventListener('abort', task.abort); resolve(v) }, reject: e => { signal?.removeEventListener('abort', task.abort); reject(e) } }
      task.timer = setTimeout(() => {
        const index = this.queue.indexOf(task)
        if (index >= 0) { this.queue.splice(index,1); task.reject(fail('worker-timeout')); this.pump() }
        else if (this.active === task) this.stop('worker-timeout')
      }, this.ready ? this.timeoutMs : this.startupTimeoutMs) // Includes queue wait; only initial integrity verification gets a separate budget.
      task.abort = () => {
        const index = this.queue.indexOf(task)
        if (index >= 0) { this.queue.splice(index,1); clearTimeout(task.timer) }
        // Active read drains its response with the original deadline, preserving
        // framing and other callers. Promise is rejected immediately, no success.
        task.reject(fail('worker-cancelled')); this.pump()
      }
      this.queue.push(task); signal?.addEventListener('abort',task.abort,{once:true})
      if (signal?.aborted) task.abort()
      this.pump()
    })
  }
  pump() {
    if (this.closed || this.stopping || this.active || !this.queue.length) return
    if (!this.child) {
      const now = Date.now(); this.starts = this.starts.filter(t => now-t < 60000)
      if (this.starts.length >= 3) { for (const task of this.queue.splice(0)) { clearTimeout(task.timer); task.reject(fail('worker-restart-limited')) } return }
      this.starts.push(now)
      let child
      try { child = this.spawnProcess('python3', ['-u', fileURLToPath(new URL('./worker.py', import.meta.url)), this.workspace], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' } }) }
      catch { for (const task of this.queue.splice(0)) { clearTimeout(task.timer); task.reject(fail('worker-unavailable')) } return }
      this.child = child; this.ready = false
      let buffer = Buffer.alloc(0)
      child.stdout.on('data', chunk => {
        if (this.child !== child || this.stopping) return
        buffer = Buffer.concat([buffer, chunk])
        if (buffer.length > 256*1024) { this.stop('worker-invalid-response'); return }
        let newline
        while ((newline = buffer.indexOf(10)) !== -1) {
          const line = buffer.subarray(0, newline); buffer = buffer.subarray(newline+1)
          let value
          try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)); inspectExternal(value) } catch { this.stop('worker-invalid-response'); return }
          if (!this.active || !value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 4 || value.v !== 1 || value.id !== this.active.id || typeof value.ok !== 'boolean' || (value.ok ? !Object.hasOwn(value, 'result') : typeof value.error !== 'string' || !/^[a-z0-9-]{1,100}$/.test(value.error))) { this.stop('worker-invalid-response'); return }
          const task = this.active; this.active = null; clearTimeout(task.timer); this.ready = true
          if (value.ok) task.resolve(value.result); else task.reject(fail(value.error))
          // Do not send another request until all bytes in this chunk are checked.
        }
        if (buffer.length && !this.active) { this.stop('worker-invalid-response'); return }
        if (!buffer.length) this.pump()
      })
      // Consume stderr without storing raw output or allowing pipe backpressure.
      child.stderr.on('data', () => {})
      child.stdin.on('error', () => { if (this.child === child) this.stop('worker-unavailable') })
      child.on('error', () => { if (this.child === child) this.stop('worker-unavailable') })
      child.on('close', () => {
        if (this.child !== child) return
        if (this.active) { clearTimeout(this.active.timer); this.active.reject(fail('worker-interrupted')); this.active = null }
        this.child = null; this.ready = false; this.stopping = false; this.pump()
      })
    }
    const task = this.queue.shift(); this.active = task
    this.child.stdin.write(task.wire)
  }
  stop(code) {
    if (this.active) { clearTimeout(this.active.timer); this.active.reject(fail(code)); this.active = null }
    if (this.child) { this.stopping = true; this.child.kill('SIGKILL') }
  }
  async close() {
    this.closed = true
    for (const task of this.queue.splice(0)) { clearTimeout(task.timer); task.reject(fail('worker-closed')) }
    const child = this.child
    const ended = child ? new Promise(resolve => child.once('close', resolve)) : Promise.resolve()
    if (this.active) { clearTimeout(this.active.timer); this.active.reject(fail('worker-closed')); this.active = null }
    let timer
    if (child) {
      this.stopping = true
      child.stdin.end() // EOF permits closing SQLite before process exit.
      timer = setTimeout(() => child.kill('SIGKILL'), 500)
    }
    await ended
    clearTimeout(timer)
  }
}
