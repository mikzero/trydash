import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readAsset } from '../src/assets.js';

test('readAsset reads project files from disk and refuses escapes', () => {
  assert.match(readAsset('public/index.html').toString(), /<title>trydash<\/title>/);
  for (const bad of ['public/nope.txt', '../package.json', '/etc/passwd', 'public/../server.js', 'public/js']) {
    assert.equal(readAsset(bad), null, bad);
  }
});

test('readAsset reads only from the embedded map when present', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trydash-assets-'));
  const file = path.join(dir, 'x.txt');
  fs.writeFileSync(file, 'ciao');
  globalThis.__TRYDASH_ASSETS__ = { 'public/x.txt': file };
  try {
    assert.equal(readAsset('public/x.txt').toString(), 'ciao');
    assert.equal(readAsset('public/index.html'), null);
  } finally {
    delete globalThis.__TRYDASH_ASSETS__;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
