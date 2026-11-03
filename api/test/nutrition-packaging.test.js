import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('Nutrition runtime is independently packageable in the API Docker context', () => {
  const api = fileURLToPath(new URL('../', import.meta.url)), queue = ['nutrition/routes.js', 'nutrition/worker.js', 'nutrition/food-catalog.js', 'nutrition/catalog-local.js'], seen = new Set();
  while (queue.length) {
    const name = queue.shift(); if (seen.has(name)) continue; seen.add(name);
    const source = fs.readFileSync(path.join(api, name), 'utf8');
    for (const [, specifier] of source.matchAll(/(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g)) {
      if (specifier.startsWith('node:')) continue;
      assert.ok(specifier.startsWith('.'), `unexpected runtime package ${specifier}`);
      const target = path.relative(api, path.resolve(api, path.dirname(name), specifier));
      assert.ok(!target.startsWith('..') && !path.isAbsolute(target), `dependency escapes API context: ${target}`);
      queue.push(target);
    }
  }
  assert.ok(seen.has('shared/sha256.js') && seen.has('nutrition/core/history.js'));
  const docker = fs.readFileSync(path.join(api, 'Dockerfile'), 'utf8');
  assert.match(docker, /^COPY nutrition \.\/nutrition$/m); assert.match(docker, /^COPY shared \.\/shared$/m);
  assert.match(docker, /^RUN apk add --no-cache flock$/m);
});
test('web Docker packaging includes the same portable source as the API', () => {
  const source = fs.readFileSync(new URL('../../web/Dockerfile', import.meta.url), 'utf8');
  assert.match(source, /^COPY api\/nutrition\/core\/ \/app\/api\/nutrition\/core\/$/m);
  assert.match(source, /^COPY api\/shared\/ \/app\/api\/shared\/$/m);
});

test('isolated V1 API lab packages Python and portable validators without altering production Docker',()=>{
 const docker=fs.readFileSync(new URL('../../scripts/nutrition-local-catalog/Dockerfile.api-lab',import.meta.url),'utf8');
 assert.match(docker,/apk add --no-cache python3 flock/);assert.match(docker,/USER 65534:65534/);assert.match(docker,/npm ci --omit=optional --ignore-scripts/);assert.match(docker,/ENV NODE_ENV=development/);
 const ignore=fs.readFileSync(new URL('../../scripts/nutrition-local-catalog/Dockerfile.api-lab.dockerignore',import.meta.url),'utf8');assert.equal(ignore.split('\n')[0],'**');assert.ok(!ignore.includes('!scripts/nutrition-local-catalog/artifacts'));assert.ok(!ignore.includes('!.env'));assert.ok(!ignore.includes('!api/data'));
});
