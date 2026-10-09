import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { projectRoot } from '../src/assets.js';
import { renderEntry, listAssets, build, hostTarget } from '../scripts/build.js';

test('renderEntry embeds every file and starts the server', () => {
  const text = renderEntry(['public/a.js', 'public/b c.png', "public/it's.svg"], '1.2.3');
  assert.equal(text.split("with { type: 'file' }").length - 1, 3);
  for (const key of ['"public/a.js"', '"public/b c.png"', '"public/it\'s.svg"', '"1.2.3"', 'main().catch(']) assert.ok(text.includes(key), key);
  const imports = new Bun.Transpiler({ loader: 'js' }).scanImports(text);
  assert.equal(imports.length, 4);
});

test('listAssets covers public/ and the seed fixture with forward slashes', () => {
  const files = listAssets(projectRoot);
  for (const f of ['public/index.html', 'public/js/parse.js', 'public/favicon.png', 'test/fixtures/quick-tunnel.log']) assert.ok(files.includes(f), f);
  assert.equal(files.some((f) => f.includes('\\')), false);
});

function waitForUrl(proc) {
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`no start line: ${out}`)), 10000);
    proc.stdout.on('data', (chunk) => {
      out += chunk;
      const match = /http:\/\/127\.0\.0\.1:\d+/.exec(out);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
  });
}

test('the compiled binary runs from another folder', { timeout: 120000 }, async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'trydash-build-'));
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'trydash-cwd-'));
  let proc;
  try {
    const [binary] = await build({ targets: [hostTarget()], version: '9.9.9-test', out });
    const version = spawnSync(binary, ['--version'], { cwd: elsewhere });
    assert.equal(version.stdout.toString(), 'trydash 9.9.9-test\n');

    proc = spawn(binary, [], { cwd: elsewhere, env: { ...process.env, PORT: '0', DASHBOARD_PROBE: 'present' } });
    const url = await waitForUrl(proc);
    assert.match(await (await fetch(`${url}/`)).text(), /<title>trydash<\/title>/);
    assert.equal((await fetch(`${url}/js/parse.js`)).status, 200);
    assert.equal((await fetch(`${url}/api/state`)).status, 200);

    // A second copy on the same port must fail and exit, not hang.
    const busy = spawnSync(binary, [], { cwd: elsewhere, timeout: 8000, env: { ...process.env, PORT: new URL(url).port, DASHBOARD_PROBE: 'present' } });
    assert.equal(busy.error, undefined, 'the binary hung on a busy port');
    assert.notEqual(busy.status, 0);

    const sums = spawnSync('sha256sum', ['-c', 'SHA256SUMS'], { cwd: out });
    assert.equal(sums.status, 0, sums.stdout.toString() + sums.stderr.toString());
  } finally {
    if (proc) proc.kill('SIGTERM');
    fs.rmSync(out, { recursive: true, force: true });
    fs.rmSync(elsewhere, { recursive: true, force: true });
  }
});
