import path from 'node:path';
import { createPublicCatalog as create } from '../../scripts/nutrition-local-catalog/public-catalog-client.mjs';
import { fixtureCatalogSpawn } from './public-catalog-fixtures.mjs';
export const createPublicCatalog = options => create({ ...options,
  spawnProcess: fixtureCatalogSpawn(path.resolve(options.directory, '../../fixture-specs.json')) });
