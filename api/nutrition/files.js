import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { MAX_DOCUMENT_BYTES } from './core/persistence-contract.js';
import { NutritionHttpError } from './protocol.js';

export const userDirectory = (dataDir, uid) => path.join(path.resolve(dataDir), 'nutrition',
  crypto.createHash('sha256').update(uid).digest('hex'));

function descriptor(fd, work) {
  let value, failure;
  try { value = work(fd); } catch (error) { failure = error; }
  try { fs.closeSync(fd); } catch (error) { failure ??= error; }
  if (failure) throw failure;
  return value;
}
export function forceDirectory(dir) { descriptor(fs.openSync(dir, 'r'), fd => fs.fsyncSync(fd)); }
export function privateDirectory(dir) {
  try { fs.mkdirSync(dir, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (!fs.lstatSync(dir).isDirectory()) throw new NutritionHttpError(503, 'nutrition-unsafe-path');
  forceDirectory(path.dirname(dir));
}
export function prepareOwner(dataDir, uid) {
  const owner = userDirectory(dataDir, uid);
  privateDirectory(path.dirname(owner)); privateDirectory(owner);
  const lock = path.join(owner, '.lock');
  descriptor(fs.openSync(lock, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600), fd => fs.fsyncSync(fd));
  forceDirectory(owner);
  return { owner, lock };
}
export function privateFiles({ fault = () => {} } = {}) {
  return {
    force(file) {
      descriptor(fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW), fd => fs.fsyncSync(fd));
      forceDirectory(path.dirname(file));
    },
    read(file) {
      let fd;
      try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      return descriptor(fd, fd => {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > MAX_DOCUMENT_BYTES) throw new NutritionHttpError(503, 'nutrition-storage-corrupt');
        const bytes = fs.readFileSync(fd);
        if (bytes.length > MAX_DOCUMENT_BYTES) throw new NutritionHttpError(503, 'nutrition-storage-corrupt');
        try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
        catch { throw new NutritionHttpError(503, 'nutrition-storage-corrupt'); }
      });
    },
    write(file, text, phase) {
      const bytes = Buffer.from(text, 'utf8');
      if (bytes.length > MAX_DOCUMENT_BYTES) throw new NutritionHttpError(413, 'nutrition-document-too-large');
      const temporary = path.join(path.dirname(file), crypto.randomUUID() + '.tmp');
      descriptor(fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600), fd => {
        fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fault(`${phase}:file-sync`);
      });
      fault(`${phase}:close`);
      fs.renameSync(temporary, file); fault(`${phase}:rename`);
      forceDirectory(path.dirname(file)); fault(`${phase}:dir-sync`);
    },
  };
}

// Count every file, including abandoned staging/temporary files. No unproved deletion to
// regain quota. Called under the same account-wide OS lock as all writes across generations.
export function capacity(owner, limits, extraBytes, extraFiles) {
  let bytes = 0, files = 0, generations = 0;
  const walk = dir => {
    for (const row of fs.readdirSync(dir, { withFileTypes: true })) {
      const name = path.join(dir, row.name), stat = fs.lstatSync(name);
      if (stat.isDirectory()) { generations++; walk(name); }
      else if (stat.isFile()) { bytes += stat.size; files++; }
      else throw new NutritionHttpError(503, 'nutrition-unsafe-path');
      if (bytes + extraBytes > limits.maxBytes || files + extraFiles > limits.maxFiles) throw new NutritionHttpError(507, 'nutrition-capacity');
    }
  };
  walk(owner);
  if (bytes + extraBytes > limits.maxBytes || files + extraFiles > limits.maxFiles) throw new NutritionHttpError(507, 'nutrition-capacity');
  const available = fs.statfsSync(owner, { bigint: true });
  if (available.bavail * available.bsize < BigInt(extraBytes + limits.reserveBytes)) throw new NutritionHttpError(507, 'nutrition-capacity');
  return { bytes, files, generations };
}
