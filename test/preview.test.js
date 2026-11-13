import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { loadDashboard } from '../src/load-dashboard.js';
import { createInspector } from '../src/inspector.js';
import { createApp } from '../server.js';
import { createRewriter, blockedBy, pathForms, localHostOf, localLinkIn, hostCheckIn, injectBadge, publicCookie } from '../src/preview.js';

const dash = loadDashboard();
const PUBLIC = 'https://shy-fox-demo.trycloudflare.com';

function request(target, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(target);
    const req = http.request({ hostname: url.hostname, port: url.port, method, path: p, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw: Buffer.concat(chunks), body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

// A tiny WordPress: its address is http://localhost:PORT and it redirects anything else there.
async function startWordPress() {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const port = server.address().port;
      const home = `http://localhost:${port}`;
      seen.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      if (req.headers.host !== `localhost:${port}`) {
        res.writeHead(301, { Location: `${home}${req.url}` });
        return res.end();
      }
      if (req.url === '/style.css') {
        const css = Buffer.from(`body{background:url(${home}/bg.png)}`);
        res.writeHead(200, { 'Content-Type': 'text/css', 'Content-Encoding': 'gzip', ETag: '"css1"' });
        return res.end(zlib.gzipSync(css));
      }
      if (req.url === '/wp-json/') {
        res.writeHead(200, { 'Content-Type': 'application/json', Link: `<${home}/wp-json/>; rel="https://api.w.org/"` });
        return res.end(JSON.stringify({ home, url: `${home}/wp-json/` }));
      }
      if (req.url === '/logo.png') {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        return res.end(Buffer.from(`\x89PNG ${home}`, 'latin1'));
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=UTF-8',
        'Set-Cookie': 'wp_test=1; Domain=localhost; Path=/; HttpOnly',
      });
      res.end(`<!doctype html><html><head><link rel="stylesheet" href="${home}/style.css"></head>`
        + `<body><a href="${home}/about/">Chi siamo – è</a><form action="${home}/wp-login.php?redirect_to=${encodeURIComponent(`${home}/wp-admin/`)}"></form>`
        + `<script>var wp={"root":"${home.replace(/\//g, '\\/')}\\/wp-json\\/"};</script></body></html>`);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    seen,
    url: `http://127.0.0.1:${server.address().port}`,
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function tunnelTo(origin, options) {
  const store = dash.createSessionStore();
  const inspector = createInspector({ store });
  const session = store.create(origin, options);
  store.get(session.id).url = PUBLIC;
  const target = await inspector.open(session);
  return { store, inspector, session, target };
}

test('rewriter: local URLs become the public one, in text, JSON and query strings, and back', () => {
  const r = createRewriter({ originUrl: new URL('http://127.0.0.1:8080'), publicUrl: PUBLIC, siteHost: 'localhost:8080' });
  const host = new URL(PUBLIC).host;
  assert.equal(r.toPublic('<a href="http://localhost:8080/x">'), `<a href="${PUBLIC}/x">`);
  assert.equal(r.toPublic('src="//127.0.0.1:8080/a.js"'), `src="//${host}/a.js"`);
  assert.equal(r.toPublic('"http:\\/\\/localhost:8080\\/wp-json"'), `"https:\\/\\/${host}\\/wp-json"`);
  assert.equal(r.toPublic('to=http%3A%2F%2Flocalhost%3A8080%2Fwp-admin'), `to=https%3A%2F%2F${host}%2Fwp-admin`);
  assert.equal(r.toPublic('ws://[::1]:8080/hmr'), `wss://${host}/hmr`);
  // Other ports, longer names and other hosts stay as they are.
  for (const text of ['http://localhost:80801/', 'http://localhost:8080.evil.com/', 'http://localhost:3000/', 'http://localhost/', 'https://example.com/']) {
    assert.equal(r.toPublic(text), text);
  }
  assert.equal(r.toLocal(`${PUBLIC}/wp-admin?redirect_to=https%3A%2F%2F${host}%2Fx`), 'http://localhost:8080/wp-admin?redirect_to=http%3A%2F%2Flocalhost%3A8080%2Fx');
  assert.equal(r.toLocal(`${PUBLIC}.evil.com/`), `${PUBLIC}.evil.com/`);
  assert.equal(publicCookie('a=1; Domain=localhost; Path=/', r), 'a=1; Path=/');

  // A --host-header name counts on any port; an origin on port 80 also without one.
  const named = createRewriter({ originUrl: new URL('http://127.0.0.1'), hostHeader: 'shop.test', publicUrl: PUBLIC });
  assert.equal(named.localHost, 'shop.test');
  assert.equal(named.toPublic('http://shop.test/a http://shop.test:8000/b http://localhost/c'), `${PUBLIC}/a ${PUBLIC}/b ${PUBLIC}/c`);

  const originUrl = new URL('http://127.0.0.1:8080');
  assert.equal(localHostOf('http://localhost:8080/wp-admin/', originUrl), 'localhost:8080');
  assert.equal(localHostOf('https://example.com/', originUrl), null);
  assert.equal(localLinkIn('<link href="http://localhost:8080/s.css">', originUrl), 'http://localhost:8080');
  assert.equal(localLinkIn('<p>Open http://localhost:8080 in your browser</p>', originUrl), null);
  assert.ok(hostCheckIn('Blocked request. This host ("a.trycloudflare.com") is not allowed.'));
  assert.ok(hostCheckIn("Invalid HTTP_HOST header: 'a.trycloudflare.com'. You may need to add it to ALLOWED_HOSTS."));
  assert.ok(hostCheckIn('Blocked hosts: a.trycloudflare.com'));
  assert.equal(injectBadge('<p>x</p></BODY>', 'it-IT,it'), '<p>x</p><div id="trydash-preview" title="trydash" style="all:initial;position:fixed;z-index:2147483647;left:12px;bottom:12px;padding:4px 10px;border-radius:999px;background:#1f2937;color:#fff;font:600 12px/1.4 system-ui,sans-serif;letter-spacing:.03em;opacity:.85;pointer-events:none">Anteprima</div></BODY>');
  assert.match(injectBadge('plain', 'en'), /^plain<div[^>]+>Preview<\/div>$/);
});

test('blocked paths: case, dot segments, encodings and repeated slashes do not get around them', () => {
  const blocked = ['/wp-admin', '/wp-login.php'];
  for (const p of ['/wp-admin', '/WP-Admin/', '//wp-admin', '/x/../wp-admin', '/%2e%2e/wp-admin', '/wp%2Dadmin/x', '/wp-login.php.',
    '/wp-login.php;jsessionid=1', '/a/%2e%2e%2fwp-admin', '/wp-admin%2f..%2f', '/wp-admin?x=1', '/%2577p-admin', '/x\\..\\wp-admin']) {
    assert.ok(blockedBy(p, blocked), `${p} should be blocked`);
  }
  for (const p of ['/', '/wp-adminx', '/blog/wp-admin-tips', '/wp-content/a.css', '/?p=/wp-admin']) {
    assert.equal(blockedBy(p, blocked), null, `${p} should pass`);
  }
  assert.equal(blockedBy('/anything', []), null);
  assert.equal(pathForms('/a%00b'), null);
  assert.equal(blockedBy('/a%00b', blocked), '?');
});

test('a WordPress on localhost works through the tunnel with rewriting on', async () => {
  const wp = await startWordPress();
  const { store, inspector, session, target } = await tunnelTo(wp.url, { rewrite: true, badge: true });
  const host = new URL(PUBLIC).host;
  try {
    // The first request learns the site's own address from its redirect, which points to the public URL.
    const first = await request(target, { path: '/', headers: { host } });
    assert.equal(first.status, 301);
    assert.equal(first.headers.location, `${PUBLIC}/`);
    assert.equal(first.headers['x-robots-tag'], 'noindex, nofollow');
    assert.equal(first.headers['cache-control'], 'no-store', 'a browser must not keep this redirect');
    assert.equal(wp.seen[0].headers.host, new URL(wp.url).host);

    const page = await request(target, { path: '/', headers: { host, 'accept-language': 'it-IT', 'accept-encoding': 'gzip', 'if-none-match': '"old"' } });
    assert.equal(page.status, 200);
    assert.equal(wp.seen[1].headers.host, `localhost:${wp.port}`);
    assert.equal(wp.seen[1].headers['accept-encoding'], undefined);
    assert.equal(wp.seen[1].headers['if-none-match'], undefined);
    assert.doesNotMatch(page.body, /localhost/);
    assert.match(page.body, new RegExp(`href="${PUBLIC}/style.css"`));
    assert.match(page.body, new RegExp(`redirect_to=https%3A%2F%2F${host}%2Fwp-admin%2F`));
    assert.match(page.body, new RegExp(`"root":"https:\\\\/\\\\/${host}\\\\/wp-json\\\\/"`));
    assert.match(page.body, /Chi siamo – è/);
    assert.match(page.body, /<div id="trydash-preview"[^>]*>Anteprima<\/div><\/body>/);
    assert.equal(Number(page.headers['content-length']), page.raw.length);
    assert.equal(page.headers['set-cookie'][0], 'wp_test=1; Path=/; HttpOnly');

    const css = await request(target, { path: '/style.css', headers: { host } });
    assert.equal(css.headers['content-encoding'], undefined);
    assert.equal(css.headers.etag, undefined);
    assert.equal(css.body, `body{background:url(${PUBLIC}/bg.png)}`);

    const json = await request(target, { path: '/wp-json/', headers: { host } });
    assert.deepEqual(JSON.parse(json.body), { home: PUBLIC, url: `${PUBLIC}/wp-json/` });
    assert.equal(json.headers.link, `<${PUBLIC}/wp-json/>; rel="https://api.w.org/"`);

    // Images pass byte for byte.
    const logo = await request(target, { path: '/logo.png', headers: { host } });
    assert.equal(logo.raw.toString('latin1'), `\x89PNG http://localhost:${wp.port}`);

    // What visitors send goes back to the local address.
    const form = `log=a&redirect_to=${encodeURIComponent(`${PUBLIC}/wp-admin/`)}`;
    await request(target, {
      method: 'POST',
      path: `/wp-login.php?redirect_to=${encodeURIComponent(`${PUBLIC}/x`)}`,
      headers: { host, origin: PUBLIC, referer: `${PUBLIC}/wp-login.php`, 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(form) },
      body: form,
    });
    const post = wp.seen[wp.seen.length - 1];
    const home = `http://localhost:${wp.port}`;
    assert.equal(post.url, `/wp-login.php?redirect_to=${encodeURIComponent(`${home}/x`)}`);
    assert.equal(post.headers.origin, home);
    assert.equal(post.headers.referer, `${home}/wp-login.php`);
    assert.equal(post.body, `log=a&redirect_to=${encodeURIComponent(`${home}/wp-admin/`)}`);

    // The inspector still shows what the origin really sent.
    const recorded = inspector.get(session.id, 2);
    assert.match(recorded.responseBody.text, /localhost/);
    assert.equal(store.get(session.id).localRedirect, null);
  } finally {
    await inspector.closeAll();
    await wp.close();
  }
});

test('without rewriting, a redirect to localhost is noticed; blocked paths get a 403; options change live', async () => {
  const wp = await startWordPress();
  const { store, inspector, session, target } = await tunnelTo(wp.url, {});
  const host = new URL(PUBLIC).host;
  try {
    assert.equal(store.get(session.id).options.noindex, true);
    const res = await request(target, { path: '/about/', headers: { host } });
    assert.equal(res.headers.location, `http://localhost:${wp.port}/about/`);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['x-robots-tag'], 'noindex, nofollow');
    assert.deepEqual({ ...store.get(session.id).localRedirect, at: 0 }, { at: 0, location: `http://localhost:${wp.port}/about/`, kind: 'redirect' });

    store.updatePreview(session.id, { rewrite: true, blocked: '/wp-admin, /wp-login.php', noindex: false });
    assert.equal(store.get(session.id).localRedirect, null);
    const before = wp.seen.length;
    for (const p of ['/wp-admin/', '/WP-LOGIN.php', '/x/..%2fwp-admin']) {
      const blocked = await request(target, { path: p, headers: { host, 'accept-language': 'en' } });
      assert.equal(blocked.status, 403, p);
      assert.match(blocked.body, /Not available in this preview/);
    }
    assert.equal(wp.seen.length, before, 'blocked requests never reach the origin');
    const list = inspector.list(session.id).requests;
    assert.equal(list[0].blocked, '/wp-admin');
    assert.equal(list[0].status, 403);
    // A replay from the dashboard still goes through.
    const replay = await inspector.replay(session.id, list[0].seq);
    assert.equal(replay.blocked, null);
    assert.equal(wp.seen.length, before + 1);

    // The replay was redirected to localhost: the address is learned, so pages now load.
    assert.equal(inspector.get(session.id, replay.seq).status, 301);
    const page = await request(target, { path: '/about/', headers: { host } });
    assert.equal(page.headers['x-robots-tag'], undefined);
    assert.equal(page.status, 200);
    assert.equal(wp.seen[wp.seen.length - 1].headers.host, `localhost:${wp.port}`);
  } finally {
    await inspector.closeAll();
    await wp.close();
  }
});

test('a dev server that refuses the public Host, or links to localhost, is noticed too', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/vite') {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      return res.end(`Blocked request. This host ("${req.headers.host}") is not allowed.`);
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<img src="http://localhost:${server.address().port}/a.png">`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const [p, kind] of [['/vite', 'host'], ['/', 'links']]) {
      const { store, inspector, session, target } = await tunnelTo(origin, {});
      try {
        await request(target, { path: p, headers: { host: new URL(PUBLIC).host } });
        const seen = await (async () => {
          for (let i = 0; i < 50 && !store.get(session.id).localRedirect; i += 1) await new Promise((r) => setTimeout(r, 10));
          return store.get(session.id).localRedirect;
        })();
        assert.equal(seen && seen.kind, kind);
      } finally {
        await inspector.closeAll();
      }
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a folder tunnel gets the label, noindex and blocked paths', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trydash-preview-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<html><body><h1>Ciao</h1></body></html>');
  fs.mkdirSync(path.join(dir, 'private'));
  fs.writeFileSync(path.join(dir, 'private', 'a.txt'), 'secret');
  const store = dash.createSessionStore();
  const inspector = createInspector({ store });
  const session = store.create('', { mode: 'folder', folder: dir, badge: true, blocked: '/private' });
  const target = await inspector.open(session);
  try {
    const page = await request(target, { path: '/', headers: { 'if-none-match': 'W/"x"' } });
    assert.equal(page.status, 200);
    assert.equal(page.body, '<html><body><h1>Ciao</h1><div id="trydash-preview" title="trydash" style="all:initial;position:fixed;z-index:2147483647;left:12px;bottom:12px;padding:4px 10px;border-radius:999px;background:#1f2937;color:#fff;font:600 12px/1.4 system-ui,sans-serif;letter-spacing:.03em;opacity:.85;pointer-events:none">Preview</div></body></html>');
    assert.equal(page.headers.etag, undefined);
    assert.equal(page.headers['x-robots-tag'], 'noindex, nofollow');
    assert.equal((await request(target, { path: '/private/a.txt' })).status, 403);
    assert.equal((await request(target, { path: '/%70rivate/a.txt' })).status, 403);
  } finally {
    await inspector.closeAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PATCH /api/sessions/:id/options changes the preview of a running tunnel', async () => {
  const app = createApp({ probe: async () => ({ present: true, version: 'test' }) });
  const headers = { 'Content-Type': 'application/json' };
  const base = await app.listen(0, '127.0.0.1');
  try {
    const session = app.store.create('http://127.0.0.1:9', { inspect: true });
    const patch = (body) => fetch(`${base}/api/sessions/${session.id}/options`, { method: 'PATCH', headers, body: JSON.stringify(body) });
    const ok = await patch({ rewrite: true, blocked: ['/wp-admin/'], badge: true });
    assert.equal(ok.status, 200);
    const { session: s } = await ok.json();
    assert.equal(s.options.rewrite, true);
    assert.deepEqual(s.options.blocked, ['/wp-admin']);
    assert.equal(s.options.noindex, true);
    assert.equal((await patch({ blocked: 'nope' })).status, 400);
    assert.equal((await fetch(`${base}/api/sessions/${session.id}/options`, { method: 'POST', headers, body: '{}' })).status, 405);
    assert.equal((await fetch(`${base}/api/sessions/missing/options`, { method: 'PATCH', headers, body: '{}' })).status, 404);

    const plain = app.store.create('http://127.0.0.1:9', { inspect: false });
    const conflict = await fetch(`${base}/api/sessions/${plain.id}/options`, { method: 'PATCH', headers, body: JSON.stringify({ rewrite: true }) });
    assert.equal(conflict.status, 409);
  } finally {
    await app.close();
  }
});
