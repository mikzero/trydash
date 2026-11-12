import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { loadDashboard } from '../src/load-dashboard.js';
import { createInspector } from '../src/inspector.js';
import { resolveFolder, contentType } from '../src/static.js';
import { createApp } from '../server.js';

const dash = loadDashboard();

function makeSite() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'trydash-static-'));
  const root = path.join(base, 'site');
  fs.mkdirSync(path.join(root, 'docs', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, 'index.html'), '<h1>Ciao</h1>');
  fs.writeFileSync(path.join(root, 'app.js'), 'console.log(1)');
  fs.writeFileSync(path.join(root, 'clip.mp4'), '0123456789');
  fs.writeFileSync(path.join(root, 'empty.txt'), '');
  fs.writeFileSync(path.join(root, 'a b & <c>.txt'), 'spazi');
  fs.writeFileSync(path.join(root, '.env'), 'SECRET=1');
  fs.writeFileSync(path.join(root, '.git', 'config'), '[core]');
  fs.writeFileSync(path.join(root, 'docs', 'guide.md'), '# Guida');
  fs.writeFileSync(path.join(base, 'outside.txt'), 'fuori');
  fs.symlinkSync(path.join(base, 'outside.txt'), path.join(root, 'link-out.txt'));
  fs.symlinkSync(path.join(root, 'app.js'), path.join(root, 'link-in.js'));
  return { base, root, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

function get(target, pathname, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(target);
    const req = http.request({ hostname: url.hostname, port: url.port, method, path: pathname, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('resolveFolder expands ~ and relative paths and refuses what is not a folder', () => {
  const site = makeSite();
  try {
    assert.equal(resolveFolder('site', site.base), fs.realpathSync(site.root));
    assert.equal(resolveFolder('./site/docs/', site.base), fs.realpathSync(path.join(site.root, 'docs')));
    assert.throws(() => resolveFolder('~'), (e) => e.key === 'folder.tooBroad');
    assert.throws(() => resolveFolder('/'), (e) => e.key === 'folder.tooBroad');
    assert.throws(() => resolveFolder('  '), (e) => e.key === 'folder.empty');
    assert.throws(() => resolveFolder('nope', site.base), (e) => e.key === 'folder.notFound' && e.params.path === path.join(site.base, 'nope'));
    assert.throws(() => resolveFolder('outside.txt', site.base), (e) => e.key === 'folder.notDirectory');
    assert.equal(contentType('a/B.HTML'), 'text/html; charset=utf-8');
    assert.equal(contentType('x.unknown'), 'application/octet-stream');
  } finally {
    site.cleanup();
  }
});

test('a folder tunnel serves files, lists folders and keeps hidden and outside files away', async () => {
  const site = makeSite();
  const store = dash.createSessionStore();
  const inspector = createInspector({ store });
  try {
    const session = store.create('', { mode: 'folder', folder: fs.realpathSync(site.root) });
    assert.equal(session.origin, null);
    const target = await inspector.open(session);
    assert.match(target, /^http:\/\/127\.0\.0\.1:\d+$/);

    const index = await get(target, '/');
    assert.equal(index.status, 200);
    assert.equal(index.body, '<h1>Ciao</h1>');
    assert.equal(index.headers['content-type'], 'text/html; charset=utf-8');

    const js = await get(target, '/app.js?v=2');
    assert.equal(js.body, 'console.log(1)');
    assert.equal(js.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal((await get(target, '/link-in.js')).body, 'console.log(1)');
    assert.equal((await get(target, '/a%20b%20%26%20%3Cc%3E.txt')).body, 'spazi');
    assert.equal((await get(target, '/empty.txt')).status, 200);

    const redirect = await get(target, '/docs?x=1');
    assert.equal(redirect.status, 301);
    assert.equal(redirect.headers.location, '/docs/?x=1');
    const list = await get(target, '/docs/');
    assert.equal(list.status, 200);
    assert.match(list.body, /href="guide\.md">guide\.md</);
    assert.match(list.body, /href="deep\/">deep\/</);
    assert.match(list.body, /href="\.\.\/"/);
    const rootList = await get(target, '/docs/deep/');
    assert.equal(rootList.status, 200);

    for (const blocked of ['/.env', '/.git/config', '/.git/', '/docs/../.env', '/%2e%2e/outside.txt', '/..%2foutside.txt', '/link-out.txt', '/nope', '/a%5Cb', '/%E0']) {
      const res = await get(target, blocked);
      assert.ok(res.status === 404 || res.status === 400, `${blocked} → ${res.status}`);
      assert.doesNotMatch(res.body, /SECRET|fuori|\[core\]/, blocked);
    }

    const post = await get(target, '/', { method: 'POST' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.allow, 'GET, HEAD');

    const head = await get(target, '/app.js', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers['content-length'], '14');
    assert.equal(head.body, '');

    const cached = await get(target, '/app.js', { headers: { 'If-None-Match': js.headers.etag } });
    assert.equal(cached.status, 304);

    const part = await get(target, '/clip.mp4', { headers: { Range: 'bytes=2-5' } });
    assert.equal(part.status, 206);
    assert.equal(part.body, '2345');
    assert.equal(part.headers['content-range'], 'bytes 2-5/10');
    assert.equal((await get(target, '/clip.mp4', { headers: { Range: 'bytes=-3' } })).body, '789');
    assert.equal((await get(target, '/clip.mp4', { headers: { Range: 'bytes=20-' } })).status, 416);

    const rows = inspector.list(session.id).requests;
    const first = rows.find((row) => row.path === '/' && row.method === 'GET');
    assert.equal(first.status, 200);
    assert.equal(first.contentType, 'text/html; charset=utf-8');
    assert.equal(inspector.get(session.id, first.seq).responseBody.text, '<h1>Ciao</h1>');
    const replayed = await inspector.replay(session.id, first.seq);
    assert.equal(replayed.status, 200);
  } finally {
    await inspector.closeAll();
    site.cleanup();
  }
});

function quietProcess() {
  const proc = new EventEmitter();
  proc.stdout = Readable.from([]);
  proc.stderr = Readable.from([]);
  proc.pid = 0;
  proc.kill = () => {};
  return proc;
}

test('HTTP API: a folder tunnel needs an existing folder and points cloudflared at trydash', async () => {
  const site = makeSite();
  const spawned = [];
  const app = createApp({
    probe: async () => ({ present: true, version: 'test' }),
    spawn(bin, args) {
      spawned.push(args);
      return quietProcess();
    },
  });
  await app.listen(0, '127.0.0.1');
  const post = (body) => fetch(`${app.url}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept-Language': 'en' },
    body: JSON.stringify(body),
  });
  try {
    const missing = await post({ options: { mode: 'folder', folder: path.join(site.base, 'missing') } });
    assert.equal(missing.status, 400);
    const missingBody = await missing.json();
    assert.equal(missingBody.key, 'folder.notFound');
    assert.match(missingBody.error, /^Folder not found: /);
    assert.equal((await (await post({ options: { mode: 'folder', folder: '' } })).json()).key, 'folder.empty');
    assert.equal(spawned.length, 0);

    const created = await post({ origin: 'ignored', options: { mode: 'folder', folder: site.root, noTlsVerify: true, inspect: false } });
    assert.equal(created.status, 201);
    const { session } = await created.json();
    assert.equal(session.mode, 'folder');
    assert.equal(session.origin, null);
    assert.equal(session.options.folder, fs.realpathSync(site.root));
    assert.equal(session.options.noTlsVerify, false);
    assert.equal(session.inspect.enabled, true);
    const target = spawned[0][spawned[0].indexOf('--url') + 1];
    assert.equal(target, session.inspect.target);
    assert.equal(session.equivalent, `cloudflared tunnel --url ${target}`);
    assert.equal((await get(target, '/')).body, '<h1>Ciao</h1>');

    await fetch(`${app.url}/api/sessions/${session.id}/stop`, { method: 'POST' });
    await fetch(`${app.url}/api/sessions/${session.id}/restart`, { method: 'POST' });
    assert.equal(spawned[1][spawned[1].indexOf('--url') + 1], target);
  } finally {
    await app.close();
    site.cleanup();
  }
});

function rawPath(target, requestPath) {
  return new Promise((resolve, reject) => {
    const url = new URL(target);
    const socket = net.connect(Number(url.port), url.hostname, () => {
      socket.write(`GET ${requestPath} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    const chunks = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.on('error', reject);
  });
}

test('index.html cannot point outside the folder or at a hidden file', async () => {
  const site = makeSite();
  const store = dash.createSessionStore();
  const inspector = createInspector({ store });
  try {
    fs.unlinkSync(path.join(site.root, 'index.html'));
    fs.symlinkSync(path.join(site.base, 'outside.txt'), path.join(site.root, 'index.html'));
    const session = store.create('', { mode: 'folder', folder: fs.realpathSync(site.root) });
    const target = await inspector.open(session);
    const outside = await get(target, '/');
    assert.equal(outside.status, 404);
    assert.doesNotMatch(outside.body, /fuori/);

    fs.unlinkSync(path.join(site.root, 'index.html'));
    fs.symlinkSync(path.join(site.root, '.env'), path.join(site.root, 'index.html'));
    const hidden = await get(target, '/');
    assert.equal(hidden.status, 404);
    assert.doesNotMatch(hidden.body, /SECRET/);

    fs.unlinkSync(path.join(site.root, 'index.html'));
    fs.symlinkSync(path.join(site.root, 'app.js'), path.join(site.root, 'index.html'));
    const inside = await get(target, '/');
    assert.equal(inside.status, 200);
    assert.equal(inside.body, 'console.log(1)');

    fs.mkdirSync(path.join(site.root, 'evil.example'));
    const redirect = await rawPath(target, '//evil.example');
    assert.match(redirect, /^HTTP\/1\.1 301/);
    assert.match(redirect, /Location: \/evil\.example\//);
    assert.doesNotMatch(redirect, /Location: \/\/evil\.example/);
  } finally {
    await inspector.closeAll();
    site.cleanup();
  }
});

test('a folder typed without ./ is a folder when it exists, a host name otherwise', async () => {
  const { bareFolder } = await import('../src/static.js');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'trydash-bare-'));
  fs.mkdirSync(path.join(base, 'site', 'dist'), { recursive: true });
  fs.mkdirSync(path.join(base, 'localhost'));
  fs.mkdirSync(path.join(base, '3000'));
  fs.writeFileSync(path.join(base, 'site', 'dist', 'index.html'), 'ok');
  fs.writeFileSync(path.join(base, 'notes.txt'), 'x');
  try {
    assert.equal(bareFolder('site', base), 'site');
    assert.equal(bareFolder(' site/dist ', base), 'site/dist');
    for (const value of ['nope', 'notes.txt', '3000', 'localhost', 'site:8080', 'http://site', '', null]) {
      assert.equal(bareFolder(value, base), null, String(value));
    }

    const spawned = [];
    const app = createApp({
      cwd: base,
      probe: async () => ({ present: true, version: 'test' }),
      spawn(bin, args) {
        spawned.push(args);
        const proc = new EventEmitter();
        proc.stdout = Readable.from([]);
        proc.stderr = Readable.from([]);
        proc.pid = 0;
        proc.kill = () => {};
        return proc;
      },
    });
    await app.listen(0, '127.0.0.1');
    const post = async (origin) => (await (await fetch(`${app.url}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin }),
    })).json()).session;
    try {
      const folder = await post('site/dist');
      assert.equal(folder.mode, 'folder');
      assert.equal(folder.origin, null);
      assert.equal(folder.options.folder, fs.realpathSync(path.join(base, 'site', 'dist')));
      assert.equal((await get(folder.inspect.target, '/')).body, 'ok');
      const host = await post('nope');
      assert.equal(host.mode, 'origin');
      assert.equal(host.origin, 'http://nope');
      assert.equal((await post('localhost')).origin, 'http://localhost');
      assert.equal((await post('3000')).origin, 'http://127.0.0.1:3000');
    } finally {
      await app.close();
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
