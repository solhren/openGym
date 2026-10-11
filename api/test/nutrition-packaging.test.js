import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('Nutrition runtime is independently packageable in the API Docker context', () => {
  const api = fileURLToPath(new URL('../', import.meta.url)), queue = ['nutrition/routes.js', 'nutrition/worker.js'], seen = new Set();
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
