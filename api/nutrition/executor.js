import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareOwner } from './files.js';
import { NutritionHttpError, MAX_PUBLICATION_BYTES } from './protocol.js';

export const DEFAULT_LIMITS = Object.freeze({ maxBytes: 512 * 1024 * 1024, maxFiles: 100000, maxGenerations: 32,
  reserveBytes: 32 * 1024 * 1024 });
export function nutritionLimits(env = process.env) {
  const value = Number(env.NUTRITION_MAX_BYTES ?? DEFAULT_LIMITS.maxBytes);
  if (!Number.isSafeInteger(value) || value < 1024 * 1024) throw new Error('NUTRITION_MAX_BYTES must be an integer of at least 1048576');
  return { ...DEFAULT_LIMITS, maxBytes: value };
}

export function nutritionExecutor({ dataDir, limits = DEFAULT_LIMITS, maxJobs = 2, timeoutMs = 300000,
  workerPath = fileURLToPath(new URL('./worker.js', import.meta.url)) } = {}) {
  let active = 0;
  const execute = job => new Promise((resolve, reject) => {
    let response, failed, child, sent = false;
    try {
      const { lock } = prepareOwner(dataDir, job.scope.namespace.profileId);
      child = spawn('flock', ['--exclusive', '--nonblock', '--conflict-exit-code', '75', '--no-fork', lock,
        process.execPath, '--max-old-space-size=128', workerPath], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    } catch (error) { reject(error); return; }
    const timer = setTimeout(() => { failed = new NutritionHttpError(503, 'nutrition-worker-interrupted'); child.kill('SIGKILL'); }, timeoutMs);
    child.on('message', message => {
      // Only Node running *under the acquired lock* can announce readiness. Sending on
      // spawn races flock's immediate conflict exit and can turn an EPIPE into a false 503.
      if (!sent && message?.ready === true && Object.keys(message).length === 1) {
        sent = true;
        child.send({ ...job, dataDir, limits }, error => { if (error) { failed = error; child.kill('SIGKILL'); } });
        return;
      }
      if (response || !Number.isInteger(message?.status) || Buffer.byteLength(JSON.stringify(message)) > MAX_PUBLICATION_BYTES + 8192) {
        failed = new NutritionHttpError(503, 'nutrition-worker-invalid'); child.kill('SIGKILL'); return;
      }
      response = message;
    });
    child.on('error', error => { failed = error; });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      // The lock is released before success is exposed. Death/timeout has an unknown outcome;
      // retry the same publication identity, never assume a pending operation was saved.
      if (code === 75) reject(new NutritionHttpError(job.action === 'publish' ? 409 : 503, 'nutrition-busy'));
      else if (failed) reject(failed);
      else if (code !== 0 || signal || !response) reject(new NutritionHttpError(503, 'nutrition-worker-interrupted'));
      else resolve(response);
    });
  });
  return {
    // Reserve BEFORE accumulating a request body. No unbounded queue of JSON buffers/workers.
    async perform(work) {
      if (active >= maxJobs) throw new NutritionHttpError(503, 'nutrition-server-busy');
      active++;
      try { return await work(execute); } finally { active--; }
    },
  };
}
