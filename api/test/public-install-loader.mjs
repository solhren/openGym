// Test process only; excluded from public source bundles/images. The sole substitution is the
// synthetic source attestation, leaving the actual worker protocol, SQL, API and auth intact.
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, next) {
  const result = next(specifier, context);
  if (context.parentURL?.endsWith('/api/nutrition/catalog-local.js') && result.url.endsWith('/public-catalog-client.mjs')) {
    return { url: new URL('./public-catalog-fixture-client.mjs', import.meta.url).href, shortCircuit: true };
  }
  return result;
} });
