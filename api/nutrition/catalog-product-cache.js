// Public, reconstructible OFF cache. No account IDs, receipts, recipes or tokens.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { CatalogHttpError, catalogProviderQuery, inspectCatalogValue } from './food-catalog.js';
const MAX_BYTES = 65536, MAX_FILES = 10000, MAX_FLIGHTS = 16, TTL = 7 * 86400000;
const fields = ['code','product_name','product_name_fr','product_name_en','generic_name','brands','nutriments','nutrition','nutrition_data_per','serving_size','serving_quantity','serving_quantity_unit','product_quantity_unit','image_front_small_url','data_quality_errors_tags','no_nutrition_data'];
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = ok => { if (!ok) throw new CatalogHttpError(502,'catalog-invalid-response',undefined,'validation'); };
const cancelled = options => { if (options.signal?.aborted) throw new CatalogHttpError(409,'catalog-request-cancelled'); };
/** One API process owns this dedicated directory. Entries are atomic fsync+rename
 * snapshots; an interrupted write cannot publish half JSON. Temporary files are
 * ignored, never swept automatically. Quota exhaustion is explicit. */
export function createValidatedProductCache({ root, normalizeProduct, remote, now = Date.now }) {
  if (!path.isAbsolute(root) || typeof normalizeProduct !== 'function') throw Error('invalid-public-cache-options');
  const flights = new Map();
  async function directory() {
    await fs.mkdir(root,{recursive:true,mode:0o700});
    if ((await fs.lstat(root)).isSymbolicLink() || !(await fs.stat(root)).isDirectory()) throw Error('unsafe-cache-directory');
  }
  async function validate(product, code, language) {
    inspectCatalogValue(product); fail(product && !Array.isArray(product));
    const selectedFields=[...new Set([...fields,`product_name_${language}`])];
    const raw = Object.fromEntries(selectedFields.filter(k=>Object.hasOwn(product,k)).map(k=>[k,product[k]]));
    fail(Buffer.byteLength(JSON.stringify(raw)) <= MAX_BYTES / 2);
    let normalized;
    try { normalized = await normalizeProduct(raw,{expectedCode:code,language,requireExplicitReference:true,requireAggregatedReference:true}); }
    catch { throw new CatalogHttpError(502,'catalog-invalid-response',undefined,'validation'); }
    const status = normalized.food ? 'validated' : 'unusable';
    if (!normalized.image) delete raw.image_front_small_url;
    // Return a safe OFF-shaped identity even when its source has ambiguous data.
    // Both client and server then apply the same existing normalization rules.
    if (!normalized.food) {
      raw.nutrition = null; raw.nutriments = {}; raw.nutrition_data_per = null;
      raw.serving_size = ''; raw.serving_quantity = null; raw.serving_quantity_unit = null;
    }
    return { raw, status, reference:normalized.food?.reference ?? null, provenance:{kind:'open-food-facts',url:normalized.sourceUrl,license:'ODbL-1.0',contentLicense:'DbCL-1.0',attribution:'Open Food Facts contributors'} };
  }
  async function load(file, code, language) {
    let fd;
    try {
      fd = await fs.open(file,constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await fd.stat(); fail(stat.isFile() && stat.size <= MAX_BYTES);
      const buffer=Buffer.alloc(MAX_BYTES+1), {bytesRead}=await fd.read(buffer,0,buffer.length,0);fail(bytesRead<=MAX_BYTES);
      const entry = JSON.parse(buffer.subarray(0,bytesRead).toString('utf8')); inspectCatalogValue(entry);
      fail(entry && Object.keys(entry).sort().join(',') === 'data,format,sha256,version');
      fail(entry.format === 'opengym-off-product-cache' && entry.version === 1 && entry.sha256 === hash(entry.data));
      const d=entry.data;
      fail(Object.keys(d).sort().join(',') === 'apiVersion,capturedAt,code,language,provenance,raw,reference,status,validatorVersion');
      fail(d.code===code && d.language===language && d.apiVersion==='v3.5' && d.validatorVersion===2 && Number.isSafeInteger(d.capturedAt) && d.capturedAt >= 0 && d.capturedAt <= now());
      const checked = await validate(d.raw,code,language);
      fail(JSON.stringify(checked.reference)===JSON.stringify(d.reference) && checked.status===d.status && JSON.stringify(checked.provenance)===JSON.stringify(d.provenance));
      return d;
    } catch { return null; } // Corruption is a miss, never an unvalidated success.
    finally { await fd?.close(); }
  }
  async function save(file, data) {
    await directory();
    const space = await fs.statfs(root);
    if (space.bavail * space.bsize < 20 * 1024 ** 3 + MAX_BYTES) throw Error('cache-disk-reserve');
    const files = await fs.readdir(root);
    if (files.length >= MAX_FILES && !files.includes(path.basename(file))) throw Error('cache-capacity');
    const body = JSON.stringify({format:'opengym-off-product-cache',version:1,data,sha256:hash(data)});
    fail(Buffer.byteLength(body)<=MAX_BYTES);
    const temporary = path.join(root,`.${randomUUID()}.partial`); let owned=false;
    try {
      const fd=await fs.open(temporary,'wx',0o600); owned=true;
      try { await fd.writeFile(body); await fd.sync(); } finally { await fd.close(); }
      await fs.rename(temporary,file); owned=false;
      const dir=await fs.open(root,constants.O_RDONLY | constants.O_DIRECTORY); try { await dir.sync(); } finally { await dir.close(); }
    } finally { if(owned) await fs.unlink(temporary).catch(()=>{}); }
  }
  const response = (data, stale = false) => ({status:200,body:{status:'success',product:data.raw,opengym_cache:{schemaVersion:1,capturedAt:new Date(data.capturedAt).toISOString(),status:data.status,reference:data.reference,stale}},headers:{'X-openGym-Catalog-Source':'validated-v3-cache','X-openGym-Catalog-Validation':data.status,'X-openGym-Catalog-Captured-At':new Date(data.capturedAt).toISOString(),...(stale?{'Warning':'110 openGym "Stale validated public product"'}:{})}});
  async function fetchAndSave(input, options, code, language, file, previous) {
    let result;
    try { result=await remote.read('product',input,options); }
    catch (error) {
      // Only an already validated fiche can survive a transient provider failure.
      // A newer invalid response / explicit not-found never revives old nutrition.
      if (previous?.status==='validated' && [429,503,502,504].includes(error.status) && error.source!=='validation') return response(previous,true);
      throw error;
    }
    cancelled(options); fail(result.status===200 && ['success','success_with_warnings'].includes(result.body?.status));
    const checked=await validate(result.body.product,code,language); cancelled(options);
    const data={apiVersion:'v3.5',validatorVersion:2,code,language,capturedAt:now(),...checked};
    try { await save(file,data); } catch { throw new CatalogHttpError(503,'catalog-cache-unavailable',undefined,'public-cache'); }
    cancelled(options); return response(data);
  }
  return {async read(kind,input,options={}) {
    if(kind!=='product') return remote.read(kind,input,options);
    const url=catalogProviderQuery(kind,input); cancelled(options);
    if(url.origin.endsWith('.net')) return remote.read(kind,input,options);
    const code=url.pathname.split('/').at(-1), language=url.searchParams.get('lc'),key=`${code}-${language}`;
    const file=path.join(root,`${key}.json`),previous=await load(file,code,language); cancelled(options);
    if(previous && now()-previous.capturedAt<TTL) return response(previous);
    // Cancellation of one waiter must not abort another person's public lookup.
    if(!flights.has(key)) {
      if(flights.size>=MAX_FLIGHTS) throw new CatalogHttpError(429,'catalog-client-rate-limited',undefined,'public-cache');
      const work=fetchAndSave(input,{...options,signal:undefined},code,language,file,previous).finally(()=>flights.delete(key));
      flights.set(key,work); work.catch(()=>{});
    }
    const work=flights.get(key);
    if(!options.signal) return work;
    let listener;
    try { return await Promise.race([work,new Promise((_,reject)=>{listener=()=>reject(new CatalogHttpError(409,'catalog-request-cancelled'));options.signal.addEventListener('abort',listener,{once:true});if(options.signal.aborted)listener();})]); }
    finally { options.signal.removeEventListener('abort',listener); }
  }};
}
