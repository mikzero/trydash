import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The one place project files are read at runtime: from disk during development,
// from the files embedded in a compiled binary (see scripts/build.js) otherwise.
export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function isSafe(rel) {
  if (typeof rel !== 'string' || !rel || rel.startsWith('/') || rel.includes('\\')) return false;
  return !rel.split('/').some((segment) => segment === '..' || segment === '');
}

export function readAsset(rel) {
  if (!isSafe(rel)) return null;
  const embedded = globalThis.__TRYDASH_ASSETS__;
  const file = embedded ? embedded[rel] : path.join(projectRoot, rel);
  if (!file) return null;
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}
