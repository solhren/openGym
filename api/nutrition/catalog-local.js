// The historical source-checkout experiment and an independent opt-in public profile.
// User storage/authentication does not enter the public reader or provider relay.
import path from 'node:path';
import fs from 'node:fs';
import { createValidatedProductCache } from './catalog-product-cache.js';
import { fileURLToPath } from 'node:url';
import { validateFood } from './core/validate.js';
import { CatalogHttpError, catalogProviderQuery, inspectCatalogValue, createCatalogRelay } from './food-catalog.js';
import {privateBetaConfig} from './catalog-beta.js';

const scriptURL = new URL('../../scripts/nutrition-local-catalog/worker-client.mjs', import.meta.url);
const wgerWorkerURL = new URL('../../scripts/nutrition-local-catalog/wger-worker-client.mjs', import.meta.url);
const wgerAdapterURL = new URL('../../scripts/nutrition-local-catalog/wger-api-adapter.mjs', import.meta.url);
const allowedWarnings = ['estimated-values', 'reference-required', 'serving-only', 'missing-values', 'export-qualifiers-unavailable', 'source-quality-warning', 'nutrition-rejected'];
const check = (ok, code = 'catalog-local-invalid-response') => { if (!ok) throw new CatalogHttpError(503, code, undefined, 'local-sqlite'); };
const text = v => typeof v === 'string' && v.length <= 300 && !/[\u0000-\u001f\u007f]/.test(v);
const canonicalCode = code => { const digits = code.replace(/^0+/, ''); return digits.padStart(digits.length <= 8 ? 8 : digits.length <= 13 ? 13 : 14, '0'); };

/** The public profile never borrows beta privileges, catalogue workspaces or external relay.
 * Account files and the public read-only catalogue must be separate trees. */
export function selfHostedCatalogConfig({ environment = process.env, dataDir = environment.DATA_DIR } = {}) {
  if (environment.OPENGYM_SELF_HOSTED_CATALOG !== '1') return null;
  const validPath = value => typeof value === 'string' && path.isAbsolute(value) && path.resolve(value) === value && value !== '/';
  const registry = environment.OPENGYM_CATALOG_REGISTRY;
  const directory = registry ? path.dirname(registry) : environment.OPENGYM_CATALOG_DIR;
  const listenHost = environment.OPENGYM_CATALOG_LISTEN_HOST ?? '127.0.0.1';
  if (environment.NODE_ENV !== 'production' || environment.NUTRITION_LOCAL_CATALOG !== '1' ||
      environment.NUTRITION_LOCAL_CATALOG_KIND !== (registry ? 'public-registry' : 'ciqual-local') ||
      ['OPENGYM_PRIVATE_BETA', 'OPENGYM_PERSONAL_BETA', 'OPENGYM_BETA_DOCKER'].some(key => environment[key] === '1') ||
      !validPath(dataDir) || environment.DATA_DIR !== dataDir || !validPath(directory) ||
      (registry && !validPath(registry)) ||
      !['127.0.0.1', '0.0.0.0'].includes(listenHost) ||
      directory === dataDir || directory.startsWith(dataDir + path.sep) || dataDir.startsWith(directory + path.sep)) {
    throw new Error('invalid-self-hosted-catalogue-configuration');
  }
  return Object.freeze({ ...(registry ? { registry } : { directory }), listenHost });
}

function publicRegistry(file) {
  const fail = ok => { if (!ok) throw new Error('invalid-public-catalogue-registry'); };
  fail(fs.realpathSync(file) === file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let value;
  try {
    const stat = fs.fstatSync(fd); fail(stat.isFile() && stat.nlink === 1 && stat.size <= 16384);
    const bytes = Buffer.alloc(16385); let size = 0, read;
    while (size < bytes.length && (read = fs.readSync(fd, bytes, size, bytes.length - size, null))) size += read;
    fail(size <= 16384);
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)));
  } finally { fs.closeSync(fd); }
  const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === keys.slice().sort().join(',');
  fail(exact(value, ['format', 'version', 'catalogues']) && value.format === 'opengym-public-catalogue-registry' && value.version === 1 && Array.isArray(value.catalogues) && value.catalogues.length <= 8);
  const names = new Set(), directories = new Set(), revisions = new Set();
  for (const entry of value.catalogues) {
    fail(exact(entry, ['id', 'kind', 'directory', 'enabled', 'catalogueSha256']));
    fail(['id', 'directory'].every(key => typeof entry[key] === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(entry[key])) &&
      !names.has(entry.id) && !directories.has(entry.directory) && entry.kind === 'ciqual-local' && typeof entry.enabled === 'boolean' && /^[a-f0-9]{64}$/.test(entry.catalogueSha256));
    names.add(entry.id); directories.add(entry.directory);
    if (entry.enabled) revisions.add(entry.catalogueSha256);
  }
  // One source version per provider: different Ciqual generations share lookup IDs and cannot
  // be selected silently. Exact generation aliases are verified individually, then deduplicated.
  fail(revisions.size <= 1);
  return value.catalogues.filter(entry => entry.enabled);
}

async function registryCatalogRelay({ registry, createPublicCatalog, onEvent }) {
  const entries = publicRegistry(registry), opened = [];
  try {
    const unique = new Map();
    for (const entry of entries) {
      const catalog = await createPublicCatalog({ directory: path.join(path.dirname(registry), entry.directory) });
      opened.push(catalog);
      const manifest = await catalog.inspect();
      if (manifest.sha256 !== entry.catalogueSha256) throw new Error('catalogue-registry-digest-mismatch');
      const relay = createPublicCatalogRelay({ catalog, onEvent }); await relay.warm();
      const identity = entry.kind + ':' + manifest.sha256;
      if (unique.has(identity)) { opened.pop(); await catalog.close(); }
      else unique.set(identity, relay);
    }
    if (unique.size) return unique.values().next().value;
    // Removing the last source keeps the authenticated local boundary. No constructor for an
    // external provider is reached and personal Nutrition storage remains available.
    return { localSearch: true, available: false, capabilities: CIQUAL_CAPABILITIES,
      async read() { throw new CatalogHttpError(503, 'catalog-local-unavailable', undefined, 'local-ciqual'); }, async close() {} };
  } catch (error) { await Promise.allSettled(opened.map(catalog => catalog.close())); throw error; }
}

export const CIQUAL_CAPABILITIES = Object.freeze({ schemaVersion: 2, textSearch: 'local', provider: 'ciqual', selection: 'local-only', productIds: true });
export function createPublicCatalogRelay({ catalog, onEvent = () => {} }) {
  let closed = false;
  const fail = (ok, status = 400, code = 'catalog-invalid-query') => { if (!ok) throw new CatalogHttpError(status, code, undefined, 'local-ciqual'); };
  return {
    localSearch: true, capabilities: CIQUAL_CAPABILITIES,
    async warm() {
      const value = await catalog.inspect();
      fail(value?.format === 'opengym-public-food-catalog' && value.schemaVersion === 1 && value.provider === 'ciqual' &&
        /^[a-f0-9]{64}$/.test(value.sha256) && Number.isSafeInteger(value.rows) && value.rows > 0 && value.rows <= 100000 && value.literalOnly === true,
      503, 'catalog-local-unavailable');
    },
    async read(kind, input, { signal } = {}) {
      fail(!closed && !signal?.aborted, 409, 'catalog-request-cancelled');
      fail(typeof input === 'string' && input.length <= 2048 && ['search', 'product'].includes(kind));
      const params = new URL(input, 'http://local').searchParams;
      const allowed = kind === 'search' ? ['q', 'page', 'lc', 'staging'] : ['id', 'code', 'lc', 'staging'];
      fail([...params.keys()].every(key => allowed.includes(key) && params.getAll(key).length === 1));
      const lc = params.get('lc') ?? 'fr';
      fail(/^[a-z]{2}$/.test(lc) && ['0', null].includes(params.get('staging')));
      let args;
      if (kind === 'search') {
        const q = (params.get('q') ?? '').normalize('NFC').trim().replace(/\s+/g, ' '), page = params.get('page') ?? '1';
        fail(q.length >= 2 && q.length <= 120 && !/[\u0000-\u001f\u007f]/.test(q) && /^[1-9]\d?$/.test(page) && Number(page) <= 20);
        const tokens = q.match(/[\p{L}\p{N}]+/gu) ?? [];
        fail(tokens.length >= 1 && tokens.length <= 8 && tokens.every(token => token.length <= 40));
        args = { q, page: Number(page), lc };
      } else fail(params.has('id') !== params.has('code') && (params.has('id') ? /^ciqual:[0-9]{1,8}$/.test(params.get('id')) : /^(?:\d{8}|\d{12,14})$/.test(params.get('code'))));
      try {
        let body;
        if (kind === 'search') body = await catalog.search(args, { signal });
        else {
          // This source has no GTINs. A printed barcode is never treated as an alim_code.
          const product = params.has('code') ? null : await catalog.product(params.get('id'), { lc, signal });
          fail(product !== null, 404, 'catalog-not-found');
          body = { product };
        }
        fail(!closed && !signal?.aborted, 409, 'catalog-request-cancelled');
        inspectCatalogValue(body);
        return { status: 200, body: { format: 'opengym-local-food-catalog', schemaVersion: 1, ...body },
          headers: { 'Cache-Control': 'no-store', 'X-openGym-Catalog-Source': 'local-ciqual' } };
      } catch (error) {
        if (error instanceof CatalogHttpError) throw error;
        const cancelled = closed || signal?.aborted;
        try { onEvent({ event: 'reader-error', source: 'local-ciqual', category: cancelled ? 'cancelled' : error.code === 'worker-busy' ? 'overload' : 'unavailable' }); } catch {}
        throw new CatalogHttpError(cancelled ? 409 : error.code === 'worker-busy' ? 429 : 503,
          cancelled ? 'catalog-request-cancelled' : error.code === 'worker-busy' ? 'catalog-client-rate-limited' : 'catalog-local-unavailable', undefined, 'local-ciqual');
      }
    },
    async close() { closed = true; await catalog.close(); }
  };
}

async function unavailableWgerRelay(onEvent) {
  const {createWgerRelay} = await import('./catalog-wger.js');
  const unavailable = async () => { throw Object.assign(new Error('local-runtime-unavailable'),{code:'worker-unavailable'}); };
  const worker = {request:unavailable,async close(){}};
  return createWgerRelay({worker,catalog:{search:unavailable,product:unavailable,barcode:unavailable,close:()=>worker.close()},onEvent});
}

/** Convert a verified public descriptor to the existing OFF-shaped response.
 * No user-persistence record and no second calculation engine. Unknown values
 * are omitted from the table; an unknown/rejected reference cannot become Food.
 */
export function localProduct(record, version) {
  inspectCatalogValue(record);
  check(record && !Array.isArray(record) && Object.keys(record).sort().join(',') === 'brand,code,countries,modifiedAt,name,nameFr,nutrients,portions,reference,warnings');
  check(typeof record.code === 'string' && /^(?:\d{8}|\d{12,14})$/.test(record.code) && text(record.name) && record.name.trim() && text(record.nameFr) && text(record.brand));
  check(Array.isArray(record.warnings) && record.warnings.length <= 7 && record.warnings.every(w => allowedWarnings.includes(w)) && new Set(record.warnings).size === record.warnings.length);
  check(Array.isArray(record.countries) && record.countries.length <= 100 && record.countries.every(c => typeof c === 'string' && /^[a-z]{2}:[a-z0-9-]{1,60}$/.test(c)));
  check(record.modifiedAt === null || (Number.isSafeInteger(record.modifiedAt) && record.modifiedAt >= 0 && record.modifiedAt <= 1e12));
  check(typeof version === 'string' && /^[a-f0-9]{64}$/.test(version));
  check(record.reference === null || (record.reference && typeof record.reference === 'object' && Object.keys(record.reference).sort().join(',') === 'amount,unit' && record.reference.amount === 100 && ['g','ml'].includes(record.reference.unit)));
  check(record.nutrients && Object.keys(record.nutrients).sort().join(',') === 'carbs,fat,kcal,protein' && Object.entries(record.nutrients).every(([k,v]) => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= (k === 'kcal' ? 2000 : 100))));
  check(Array.isArray(record.portions) && record.portions.length <= 1);
  check(!record.warnings.includes('nutrition-rejected') || (record.reference === null && Object.values(record.nutrients).every(v => v === null) && !record.portions.length));
  if (record.reference) {
    check(validateFood({ schemaVersion: 1, kind: 'food', id: 'catalog-validation', name: record.name, brand: record.brand, reference: record.reference, nutrients: record.nutrients, portions: record.portions, source: {kind:'custom'} }).length === 0);
  } else check(Object.values(record.nutrients).every(v => v === null) && record.portions.length === 0);
  const raw = { code: record.code, product_name: record.name, product_name_fr: record.nameFr, brands: record.brand,
    opengym_catalog: { version, warnings: record.warnings }, nutriments: {} };
  if (record.reference) {
    const names = { kcal:'energy-kcal', protein:'proteins', carbs:'carbohydrates', fat:'fat' };
    raw.nutrition = { aggregated_set: { per: record.reference.unit === 'ml' ? '100ml' : '100g', preparation:'as_sold', nutrients: Object.fromEntries(Object.entries(record.nutrients).filter(([,v]) => v !== null).map(([k,v]) => [names[k],{value:v}])) } };
    if (record.portions[0]) {
      const p = record.portions[0]; check(p.unit === record.reference.unit && p.id === 'off-serving' && typeof p.label === 'string' && p.label.length <= 200);
      raw.serving_size = p.label; raw.serving_quantity = p.amount; raw.serving_quantity_unit = p.unit;
    }
  }
  return raw;
}

export function createLocalCatalogRelay({ worker, onEvent = () => {}, remote = createCatalogRelay({onEvent}), productCache }) {
  let closed = false;
  const emit = event => { try { onEvent({ component:'nutrition-local-catalog', ...event }); } catch {} };
  const read = async (kind, input, options = {}) => {
    const url = catalogProviderQuery(kind, input); // same query allowlist as remote mode
    if (closed || options.signal?.aborted) throw new CatalogHttpError(409, 'catalog-request-cancelled');
    const delegate = async () => {
      const result = await (kind === 'product' && productCache ? productCache : remote).read(kind, input, options);
      if (closed || options.signal?.aborted) throw new CatalogHttpError(409, 'catalog-request-cancelled');
      return result;
    };
    // Staging is a different dataset; never pretend the local production corpus is it.
    if (url.origin.endsWith('.net')) return delegate();
    // Selection always consults v3/cache: TSV remains a search identity index.
    if (kind === 'product' && productCache) return delegate();
    let value;
    try {
      value = await worker.request(kind === 'search' ? 'search' : 'barcode', kind === 'search' ? {query:url.searchParams.get('search_terms'),page:Number(url.searchParams.get('page')),pageSize:20,language:url.searchParams.get('lc')} : {code:url.pathname.split('/').at(-1)}, {signal:options.signal});
    } catch (error) {
      emit({event:'reader-error', kind, category: error.code === 'worker-busy' ? 'overload' : ['invalid-query','invalid-query-tokens'].includes(error.code) ? 'query' : 'unavailable'});
      if (options.signal?.aborted || closed) throw new CatalogHttpError(409, 'catalog-request-cancelled');
      if (kind === 'product') return delegate(); // explicit barcode lookup still works on local failure
      throw new CatalogHttpError(error.code === 'worker-busy' ? 429 : ['invalid-query','invalid-query-tokens'].includes(error.code) ? 400 : 503,
        error.code === 'worker-busy' ? 'catalog-client-rate-limited' : ['invalid-query','invalid-query-tokens'].includes(error.code) ? 'catalog-invalid-query' : 'catalog-local-unavailable', undefined, 'local-sqlite');
    }
    if (options.signal?.aborted || closed) throw new CatalogHttpError(409, 'catalog-request-cancelled');
    if (kind === 'product' && value === null) return delegate();
    if (kind === 'search') {
      inspectCatalogValue(value);
      check(value && Array.isArray(value.products) && value.products.length <= 20 && Number.isSafeInteger(value.count) && value.count >= value.products.length && value.count <= 100000 && value.page === Number(url.searchParams.get('page')) && value.pageSize === 20 && value.fixture === false);
      const products = value.products.map(r => localProduct(r, value.catalogueVersion));
      check(new Set(products.map(p=>p.code)).size === products.length);
      return {status:200, body:{count:value.count,products},headers:{'X-openGym-Catalog-Source':'local-sqlite','X-openGym-Catalog-Version':value.catalogueVersion}};
    }
    // Barcode response includes its generation in the same read, no second
    // inspect request that could race a publication between record and version.
    check(value && value.fixture === false && canonicalCode(value.product?.code || '') === canonicalCode(url.pathname.split('/').at(-1)));
    const product = localProduct(value.product, value.catalogueVersion);
    return {status:200,body:{status:'success',product},headers:{'X-openGym-Catalog-Source':'local-sqlite','X-openGym-Catalog-Version':value.catalogueVersion}};
  };
  return {localSearch:true,read,async close(){ closed=true; await worker.close(); }};
}

/** The explicit public profile uses its own verified, read-only source. Without that opt-in,
 * the historical experiment keeps its development/beta gates and existing behavior.
 */
export async function experimentalCatalogRelay({ environment = process.env, dataDir, remote, onEvent = () => {}, loadWorker, loadWger, loadPublic } = {}) {
  const publicConfig = selfHostedCatalogConfig({ environment, dataDir });
  if (publicConfig) {
    let catalog;
    try {
      const { createPublicCatalog } = loadPublic ? await loadPublic() : await import(new URL('../../scripts/nutrition-local-catalog/public-catalog-client.mjs', import.meta.url));
      if (publicConfig.registry) return await registryCatalogRelay({ registry: publicConfig.registry, createPublicCatalog, onEvent });
      catalog = await createPublicCatalog({ directory: publicConfig.directory });
      const relay = createPublicCatalogRelay({ catalog, onEvent });
      await relay.warm();
      return relay;
    } catch {
      await catalog?.close();
      throw new Error('self-hosted-catalogue-unavailable');
    }
  }
  const beta=privateBetaConfig({environment,dataDir});
  if (environment.NUTRITION_LOCAL_CATALOG !== '1') return null;
  const name = environment.NUTRITION_LOCAL_CATALOG_WORKSPACE;
  const base = fileURLToPath(new URL('../../scripts/nutrition-local-catalog/artifacts/', import.meta.url));
  const resolved = path.isAbsolute(dataDir || '') ? path.resolve(dataDir) : '';
  if ((!beta&&environment.NODE_ENV !== 'development') || !environment.DATA_DIR || !resolved || path.resolve(environment.DATA_DIR) !== resolved || resolved === '/data' || resolved.startsWith('/data/') || resolved.startsWith(base) || base.startsWith(resolved+path.sep) || typeof name !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(name)) {
    try { onEvent({event:'local-config-refused'}); } catch {}
    return environment.NODE_ENV === 'development' && environment.NUTRITION_LOCAL_CATALOG_KIND === 'wger-v1' ? unavailableWgerRelay(onEvent) : null;
  }
  if (environment.NUTRITION_LOCAL_CATALOG_KIND === 'wger-v1') {
    const complement = environment.NUTRITION_LOCAL_CATALOG_COMPLEMENT ?? null;
    if (typeof complement !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(complement)) {
      try { onEvent({event:'local-config-refused'}); } catch {} return unavailableWgerRelay(onEvent);
    }
    const {createWgerRelay} = await import('./catalog-wger.js');
    const reference=environment.NUTRITION_LOCAL_CATALOG_REFERENCE??null, referenceIndex=environment.NUTRITION_LOCAL_CATALOG_REFERENCE_INDEX??null;
    if ((reference===null)!==(referenceIndex===null)||[reference,referenceIndex].some(v=>v!==null&&(typeof v!=='string'||!/^[A-Za-z0-9_-]{1,40}$/.test(v)))) {
      try{onEvent({event:'local-config-refused'});}catch{}return unavailableWgerRelay(onEvent);
    }
    let worker,relay;
    try {
      const {WgerCatalogWorker,createWgerLocalCatalog} = loadWger ? await loadWger() : {...await import(wgerWorkerURL.href),...await import(wgerAdapterURL.href)};
      worker = new WgerCatalogWorker(name,{localV1:true,complement,reference,referenceIndex});
      relay = createWgerRelay({catalog:createWgerLocalCatalog(worker),worker,onEvent});
    } catch {
      await worker?.close();
      if(beta)throw new Error('private-beta-catalogue-unavailable');
      try { onEvent({event:'local-runtime-unavailable'}); } catch {}
      return unavailableWgerRelay(onEvent);
    }
    // Warm hashing (~14 s on the full base) once, before the first browser read.
    // Missing/corrupt data stays local-unavailable; never downgrade to OFF.
    try { await relay.warm(); } catch { if(beta){await relay.close();throw new Error('private-beta-catalogue-unavailable');}try { onEvent({event:'local-wger-unavailable'}); } catch {} }
    return relay;
  }
  let worker;
  try {
    const { CatalogWorker } = loadWorker ? await loadWorker() : await import(scriptURL.href);
    worker = new CatalogWorker(name);
  } catch {
    try { onEvent({event:'local-runtime-unavailable'}); } catch {}
    worker = {async request(){throw Object.assign(new Error(),{code:'worker-unavailable'});},async close(){}};
  }
  // Wrapper augments barcode protocol atomically; older prototype public clients
  // keep their existing plain-record barcode contract.
  const normalizeURL = new URL('../../frontend/src/lib/nutrition/catalog/normalize.js', import.meta.url);
  const { normalizeProduct } = await import(normalizeURL.href);
  // Share one real egress budget between cached product reads and staging.
  const provider = remote ?? createCatalogRelay({onEvent,productApiVersion:'3.5'});
  const productCache = createValidatedProductCache({root:path.join(base,'public-v3-cache',name),normalizeProduct,remote:provider});
  return createLocalCatalogRelay({ productCache, worker:{request(op,args,options){return worker.request(op==='barcode'?'product':op,args,options);},close(){return worker.close();}},remote:provider,onEvent });
}
