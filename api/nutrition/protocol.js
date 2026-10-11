import { NutritionValidationError } from './core/contracts.js';
import { HASH_PATTERN, MAX_DOCUMENT_BYTES, check, validateScope } from './core/persistence-contract.js';

export const MAX_PUBLICATION_BYTES = 3 * MAX_DOCUMENT_BYTES;
export const RECEIPT_FORMAT = 'opengym-nutrition-server-receipt';
export const REQUEST_FORMAT = 'opengym-nutrition-server-request';
export class NutritionHttpError extends Error {
  constructor(status, code, extra = {}) { super(code); this.status = status; this.code = code; this.extra = extra; }
}
export function httpError(error) {
  if (error instanceof NutritionHttpError) return error;
  if (error instanceof NutritionValidationError) {
    const oversized = error.issues.some(i => i.code === 'document_too_large');
    return new NutritionHttpError(oversized ? 413 : 400, 'nutrition-invalid', { issues: error.issues.slice(0, 32) });
  }
  return new NutritionHttpError(error?.code === 'ENOSPC' || error?.code === 'EDQUOT' ? 507 : 503,
    error?.code === 'ENOSPC' || error?.code === 'EDQUOT' ? 'nutrition-capacity' : 'nutrition-storage-unavailable');
}
export function validateServerScope(scope) {
  validateScope({ ...scope, domainVersion: 1 });
  for (const [key, value] of [['generation', scope.generation], ['profileId', scope.namespace.profileId]]) {
    check(Buffer.byteLength(value, 'utf8') <= 256, key, 'identifier_too_long');
  }
}
export function digest(value) { check(typeof value === 'string' && HASH_PATTERN.test(value), 'digest', 'invalid_digest'); return value; }

// Before the recursive shared validators: cap depth, reject duplicate object keys and invalid
// UTF-8. The scanner ignores quoted delimiters; JSON.parse handles all remaining JSON syntax.
export function parseJson(bytes, limit) {
  if (bytes.length > limit) throw new NutritionHttpError(413, 'nutrition-body-too-large');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new NutritionHttpError(400, 'nutrition-invalid-utf8'); }
  const stack = [];
  try {
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '"') {
        const start = i++;
        while (i < text.length && text[i] !== '"') { if (text[i] === '\\') i++; i++; }
        let next = i + 1; while (/\s/.test(text[next] ?? '') && next < text.length) next++;
        if (text[next] === ':' && stack.at(-1) instanceof Set) {
          const key = JSON.parse(text.slice(start, i + 1)), keys = stack.at(-1);
          if (keys.has(key)) throw new NutritionHttpError(400, 'nutrition-duplicate-key');
          keys.add(key);
        }
      } else if (c === '{' || c === '[') {
        stack.push(c === '{' ? new Set() : null);
        if (stack.length > 64) throw new NutritionHttpError(400, 'nutrition-json-too-deep');
      } else if (c === '}' || c === ']') stack.pop();
    }
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required');
    return value;
  } catch (error) {
    if (error instanceof NutritionHttpError) throw error;
    throw new NutritionHttpError(400, 'nutrition-invalid-json');
  }
}

export function readNutritionBody(req, limit, { idleMs = 30000, totalMs = 120000 } = {}) {
  const type = String(req.headers['content-type'] || '').toLowerCase();
  if (!/^application\/json(?:\s*;.*)?$/.test(type) || req.headers['content-encoding']) {
    req.resume();
    return Promise.reject(new NutritionHttpError(415, 'nutrition-json-required'));
  }
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0, over = false;
    let idle;
    const clear = () => { clearTimeout(idle); clearTimeout(total); };
    const timeout = () => {
      over = true; chunks.length = 0; clear(); req.resume();
      reject(new NutritionHttpError(408, 'nutrition-body-timeout'));
    };
    const resetIdle = () => { clearTimeout(idle); idle = setTimeout(timeout, idleMs); };
    const total = setTimeout(timeout, totalMs); resetIdle();
    req.on('data', chunk => {
      size += chunk.length;
      if (over) { if (size > 2 * limit) req.destroy(); return; }
      resetIdle();
      if (size > limit) { over = true; chunks.length = 0; clear(); reject(new NutritionHttpError(413, 'nutrition-body-too-large')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      clear();
      if (over) return;
      try { resolve(parseJson(Buffer.concat(chunks), limit)); } catch (error) { reject(error); }
    });
    req.on('error', error => { clear(); reject(Object.assign(error, { clientGone: true })); });
    req.on('aborted', () => { clear(); reject(Object.assign(new Error('client aborted'), { clientGone: true })); });
  });
}
