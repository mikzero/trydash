import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { parseArgs, envValue, parseDuration, browserCommand, openBrowser, announceUrl } from '../src/cli.js';
import { dashboardRoot } from '../src/load-dashboard.js';

test('arguments: a port, a URL or a folder opens a tunnel; options follow cloudflared', () => {
  assert.deepEqual(parseArgs([]), { port: null, open: null, save: null, help: false, version: false, target: null });
  assert.equal(parseArgs(['--no-save']).save, false);
  assert.deepEqual(parseArgs(['3000']).target, { origin: '3000', options: {} });
  assert.deepEqual(parseArgs(['./dist', '--mail', '*@x.it']).target, { origin: '', options: { allowedMail: '*@x.it', mode: 'folder', folder: './dist' } });
  assert.deepEqual(parseArgs(['--hello']).target, { origin: '', options: { mode: 'hello' } });
  const full = parseArgs(['https://localhost:8443', '--no-tls-verify', '--host-header=app.local', '--no-inspect', '-p', '9000', '--no-open', '--expires', '2h']);
  assert.equal(full.port, 9000);
  assert.equal(full.open, false);
  assert.deepEqual(full.target, { origin: 'https://localhost:8443', options: { noTlsVerify: true, hostHeader: 'app.local', inspect: false, expiresIn: 120 } });
  assert.equal(parseArgs(['--port=0']).port, 0);
  assert.deepEqual(parseArgs(['8080', '--rewrite', '--block', '/wp-admin,/wp-login.php', '--badge', '--index']).target,
    { origin: '8080', options: { rewrite: true, blocked: '/wp-admin,/wp-login.php', badge: true, noindex: false } });
  assert.equal(parseArgs(['-v']).version, true);
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['--open']).open, true);

  assert.throws(() => parseArgs(['--nope']), /unknown option --nope/);
  assert.throws(() => parseArgs(['3000', '4000']), /only one/);
  assert.throws(() => parseArgs(['--port', 'abc']), /port must be a number/);
  assert.throws(() => parseArgs(['--port']), /--port needs a value/);
  assert.throws(() => parseArgs(['--mail', 'a@b.it']), /need a port, URL or folder/);
  assert.throws(() => parseArgs(['--hello', '3000']), /--hello takes no/);
  assert.throws(() => parseArgs(['3000', '--expires', 'soon']), /--expires takes/);

  assert.equal(parseDuration('30m'), 30);
  assert.equal(parseDuration('45'), 45);
  assert.equal(parseDuration('2H'), 120);
  assert.equal(parseDuration('1d'), 1440);
  assert.equal(parseDuration('0m'), null);
  assert.equal(parseDuration('-1h'), null);
});

test('environment: TRYDASH_* first, then the 1.x names with a warning', () => {
  const warnings = [];
  const warn = (text) => warnings.push(text);
  assert.equal(envValue({ TRYDASH_SEED: '1', DASHBOARD_SEED: '0' }, 'TRYDASH_SEED', warn), '1');
  assert.equal(envValue({ DASHBOARD_PROBE: 'present' }, 'TRYDASH_PROBE', warn), 'present');
  assert.equal(envValue({ DASHBOARD_PROBE: 'present' }, 'TRYDASH_PROBE', warn), 'present');
  assert.deepEqual(warnings, ['trydash: DASHBOARD_PROBE is deprecated, use TRYDASH_PROBE']);
  assert.equal(envValue({ PORT: '9999' }, 'TRYDASH_PORT', warn), '9999');
  assert.equal(warnings.length, 1);
  assert.equal(envValue({}, 'TRYDASH_PORT', warn), undefined);
});

test('the browser opens without a shell', () => {
  const url = 'http://127.0.0.1:8787/?token=a&b';
  assert.deepEqual(browserCommand('darwin', url), ['open', [url]]);
  assert.deepEqual(browserCommand('win32', url), ['rundll32', ['url.dll,FileProtocolHandler', url]]);
  assert.deepEqual(browserCommand('linux', url), ['xdg-open', [url]]);
  const calls = [];
  const child = new EventEmitter();
  child.unref = () => calls.push('unref');
  openBrowser(url, { platform: 'linux', spawnImpl: (bin, args, opts) => { calls.push([bin, args, opts.stdio, opts.detached]); return child; } });
  assert.deepEqual(calls, [['xdg-open', [url], 'ignore', true], 'unref']);
  assert.doesNotThrow(() => child.emit('error', new Error('no xdg-open')));
  assert.equal(openBrowser(url, { spawnImpl: () => { throw new Error('ENOENT'); } }), null);
});

test('the tunnel URL is printed once cloudflared has it', async () => {
  const session = { active: true, url: null, status: 'starting' };
  const store = { get: () => session };
  const lines = [];
  const done = announceUrl(store, 's1', { log: (l) => lines.push(l), everyMs: 5 });
  setTimeout(() => { session.url = 'https://a-b.trycloudflare.com'; }, 20);
  assert.equal(await done, '→ https://a-b.trycloudflare.com');
  const dead = { active: false, url: null, status: 'exited' };
  assert.match(await announceUrl({ get: () => dead }, 's1', { log: () => {}, everyMs: 5 }), /stopped before getting a URL \(exited\)/);
});

test('`trydash 3000` starts the dashboard and prints the tunnel URL', { skip: process.platform === 'win32', timeout: 20000 }, async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'trydash-fake-cf-'));
  fs.writeFileSync(path.join(bin, 'cloudflared'), '#!/bin/sh\necho \'{"level":"info","message":"|  https://cli-test-fox.trycloudflare.com |"}\'\nexec sleep 30\n', { mode: 0o755 });
  const bun = process.execPath.includes('bun') ? process.execPath : 'bun';
  // The saved tunnels go to a temporary file, never to the real ~/.config.
  const config = path.join(bin, 'tunnels.json');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TRYDASH_PROBE: 'present', TRYDASH_TOKEN: 'cli-token', TRYDASH_CONFIG: config };
  const proc = spawn(bun, ['server.js', '3000', '--port', '0', '--no-open'], { cwd: dashboardRoot, env });
  let out = '';
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no URL in: ${out}`)), 15000);
      proc.stdout.on('data', (chunk) => {
        out += chunk;
        if (out.includes('→ https://cli-test-fox.trycloudflare.com')) { clearTimeout(timer); resolve(); }
      });
      proc.stderr.on('data', (chunk) => { out += chunk; });
    });
    const dashboard = /http:\/\/127\.0\.0\.1:\d+/.exec(out)[0];
    assert.match(out, new RegExp(`${dashboard.replace(/\./g, '\\.')}/\\?token=cli-token`));
    const state = await (await fetch(`${dashboard}/api/state`, { headers: { Authorization: 'Bearer cli-token' } })).json();
    assert.equal(state.sessions.length, 1);
    assert.equal(state.sessions[0].origin, 'http://127.0.0.1:3000');
    const saved = JSON.parse(fs.readFileSync(config, 'utf8'));
    assert.equal(saved.tunnels.length, 1);
    assert.equal(saved.tunnels[0].origin, 'http://127.0.0.1:3000');
  } finally {
    proc.kill('SIGTERM');
    fs.rmSync(bin, { recursive: true, force: true });
  }

  const help = spawnSync(bun, ['server.js', '--help'], { cwd: dashboardRoot, env });
  assert.equal(help.status, 0);
  assert.match(help.stdout.toString(), /^Usage: trydash \[port \| url \| folder\]/);
  const bad = spawnSync(bun, ['server.js', '--nope'], { cwd: dashboardRoot, env });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr.toString(), /unknown option --nope/);
});
