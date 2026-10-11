import { createWindow } from '../rate-limit.js';
import { MAX_DOCUMENT_BYTES } from './core/persistence-contract.js';
import { MAX_PUBLICATION_BYTES, NutritionHttpError, digest, httpError, readNutritionBody, validateServerScope } from './protocol.js';
import { nutritionExecutor, nutritionLimits } from './executor.js';

export function nutritionRoutes({ json, sessionOf, dataDir, origin, executor = nutritionExecutor({ dataDir, limits: nutritionLimits() }) }) {
  const burst = createWindow({ max: 300, windowMs: 60000 }), writes = createWindow({ max: 600, windowMs: 3600000 });
  const publications = createWindow({ max: 120, windowMs: 3600000 });
  const handle = (action, limit = 0) => async (req, res) => {
    const session = sessionOf(req);
    if (!session) { req.resume(); return json(res, 401, { error: 'not signed in', code: 'nutrition-not-signed-in' }); }
    try {
      const wait = burst.take(session.user.id) || (limit ? writes.take(session.user.id) : 0) ||
        (action === 'publish' ? publications.take(session.user.id) : 0);
      if (wait) throw new NutritionHttpError(429, 'nutrition-rate-limited', { retryAfter: wait });
      const url = new URL(req.url, 'http://x'), params = url.searchParams;
      const allowed = action === 'partition' ? ['generation', 'manifest'] : ['generation'];
      if ([...params.keys()].some(key => !allowed.includes(key)) || params.getAll('generation').length !== 1 ||
        (action === 'partition' && params.getAll('manifest').length !== 1)) throw new NutritionHttpError(400, 'nutrition-invalid-query');
      const scope = { namespace: { serverOrigin: new URL(origin).origin, profileId: session.user.id }, generation: params.get('generation') };
      validateServerScope(scope);
      const hash = req.nutritionDigest;
      if (action === 'partition' || action === 'upload' || action === 'manifest') digest(hash);
      const manifestDigest = action === 'partition' ? digest(params.get('manifest')) : null;
      await executor.perform(async execute => {
        const body = limit ? await readNutritionBody(req, limit) : null;
        // Body upload may outlive a logout/admin revocation; use the existing session again.
        const live = sessionOf(req);
        if (!live || live.user !== session.user || live.exp !== session.exp) throw new NutritionHttpError(401, 'nutrition-not-signed-in');
        const response = await execute({ action, scope, digest: hash, manifestDigest, body,
          authorization: { sv: session.user.sv || 0, exp: session.exp } });
        json(res, response.status, response.body, response.body.retryAfter ? { 'Retry-After': String(response.body.retryAfter) } : undefined);
      });
    } catch (error) {
      if (error?.clientGone) throw error;
      req.resume();
      const e = httpError(error);
      json(res, e.status, { error: e.code, code: e.code, ...e.extra },
        e.status === 503 || e.status === 429 ? { 'Retry-After': String(e.extra.retryAfter || 2) } : undefined);
    }
  };
  return {
    'GET /api/nutrition/head': handle('head'),
    'GET /api/nutrition/manifests/{digest}': handle('manifest'),
    'GET /api/nutrition/partitions/{digest}': handle('partition'),
    'PUT /api/nutrition/partitions/{digest}': handle('upload', MAX_DOCUMENT_BYTES),
    'POST /api/nutrition/publications': handle('publish', MAX_PUBLICATION_BYTES),
  };
}
