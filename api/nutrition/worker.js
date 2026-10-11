import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createNutritionServerStore } from './store.js';
import { NutritionHttpError, httpError } from './protocol.js';

// No provider/user executable is ever launched. This trusted worker runs the shared codec
// outside the HTTP event loop, under flock --no-fork, with a fixed heap ceiling.
export function runWorker({ fault } = {}) {
  process.once('message', async job => {
    let response;
    try {
      const authorize = () => {
        const users = JSON.parse(fs.readFileSync(path.join(job.dataDir, 'db.json'), 'utf8')).users;
        const user = users?.find(user => user.id === job.scope.namespace.profileId);
        if (!user || user.disabled || (user.sv || 0) !== job.authorization.sv || Date.now() >= job.authorization.exp) {
          throw new NutritionHttpError(401, 'nutrition-not-signed-in');
        }
      };
      authorize();
      const store = await createNutritionServerStore({ ...job, authorize, fault });
      const value = job.action === 'head' ? await store.head() :
        job.action === 'manifest' ? await store.manifest(job.digest) :
        job.action === 'partition' ? await store.partition(job.digest, job.manifestDigest) :
        job.action === 'upload' ? await store.upload(job.digest, job.body) :
        job.action === 'publish' ? await store.publish(job.body) : (() => { throw new Error('unknown action'); })();
      authorize();
      response = { status: 200, body: value };
    } catch (error) {
      const e = httpError(error);
      response = { status: e.status, body: { error: e.code, code: e.code, ...e.extra } };
    }
    process.send(response, () => process.disconnect());
  });
  process.send?.({ ready: true });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runWorker();
