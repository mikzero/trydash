// Assembles the landing page for GitHub Pages.
//
//   bun scripts/build-site.js              into _site/
//   bun scripts/build-site.js --out dir
//
// site/** is copied as is; the logo, favicons and README screenshots are taken
// from where they already live, so they are never duplicated in the repository.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const SHARED = [
  'public/logo.svg',
  'public/favicon.svg',
  'public/favicon.png',
  'docs/images/screenshot-light.png',
  'docs/images/screenshot-dark.png',
];

export function buildSite(out, projectRoot = root) {
  fs.rmSync(out, { recursive: true, force: true });
  fs.cpSync(path.join(projectRoot, 'site'), out, { recursive: true });
  for (const rel of SHARED) fs.copyFileSync(path.join(projectRoot, rel), path.join(out, path.basename(rel)));
  return out;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--out');
  const out = path.resolve(i >= 0 ? args[i + 1] : path.join(root, '_site'));
  buildSite(out);
  console.log(`site → ${path.relative(process.cwd(), out) || '.'}`);
}
