import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { loadDashboard } from '../src/load-dashboard.js';
import { createInspector } from '../src/inspector.js';
import { createApp } from '../server.js';
import {
  newKey, newId, pinHash, pinMatches, cookieValue, cookieLinkId, withoutCookie, withoutKey, safeBack, checkPin, readCookie,
} from '../src/links.js';

const dash = loadDashboard();

function request(target, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(target);
    const req = http.request({ hostname: url.hostname, port: url.port, method, path, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function cookieFrom(res) {
  const line = [].concat(res.headers['set-cookie'] || []).find((c) => c.startsWith('trydash_link='));
  return line ? line.split(';')[0] : null;
}

async function startOrigin() {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, cookie: req.headers.cookie || null });
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h1>site</h1>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { seen, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

test('link helpers: signed cookie, no trydash cookie or key for the origin, safe redirects', () => {
  const secret = Buffer.from('s'.repeat(32));
  const link = { id: newId(), key: newKey(), pinHash: null };
  assert.match(link.id, /^l[0-9a-f]{10}$/);
  assert.match(link.key, /^[A-Za-z0-9_-]{22}$/);
  const value = cookieValue(secret, link);
  const find = (id) => (id === link.id ? link : null);
  assert.equal(cookieLinkId(secret, value, find), link);
  assert.equal(cookieLinkId(secret, value.slice(0, -1) + (value.endsWith('A') ? 'B' : 'A'), find), null, 'tampered');
  assert.equal(cookieLinkId(Buffer.from('x'.repeat(32)), value, find), null, 'another secret');
  // Setting a PIN invalidates cookies made without it.
  assert.equal(cookieLinkId(secret, value, () => ({ ...link, pinHash: 'abc' })), null);
  assert.equal(withoutCookie('a=1; trydash_link=x.y; b=2', 'trydash_link'), 'a=1; b=2');
  assert.equal(withoutCookie('trydash_link=x.y', 'trydash_link'), null);
  assert.equal(readCookie('a=1; trydash_link=v', 'trydash_link'), 'v');
  assert.equal(withoutKey('/shop?tdk=abc&x=1'), '/shop?x=1');
  assert.equal(withoutKey('/?tdk=abc'), '/');
  for (const bad of ['//evil.com', 'https://evil.com', '/\\evil.com', '', '/\t/evil.com', '/\t\\evil.com', '/ok\r\nSet-Cookie: a=1', '/\n/evil.com']) {
    assert.equal(safeBack(bad), '/', JSON.stringify(bad));
  }
  assert.equal(safeBack('/wp/?p=1'), '/wp/?p=1');
  const withPin = { ...link, pinHash: pinHash(link.key, '482191') };
  assert.equal(pinMatches(withPin, '482191'), true);
  assert.equal(pinMatches(withPin, '482192'), false);
  assert.equal(pinMatches({ ...withPin, key: newKey() }, '482191'), false, 'the key salts the hash');
  assert.equal(checkPin(''), null);
  assert.equal(checkPin('482191'), '482191');
  assert.throws(() => checkPin('12'), /links\.badPin/);
  assert.throws(() => checkPin('4821'), /links\.badPin/);
  assert.throws(() => checkPin('abcd'), /links\.badPin/);
});

test('a personal link becomes a cookie, the origin never sees it, visits are counted', async () => {
  const origin = await startOrigin();
  const store = dash.createSessionStore();
  const inspector = createInspector({ store });
  const session = store.create(origin.url, {});
  store.setOwnerKey(session.id, newKey());
  const mario = store.addLink(session.id, { id: newId(), name: 'Mario', key: newKey() });
  const target = await inspector.open(session);
  const page = { accept: 'text/html', 'sec-fetch-dest': 'document' };
  try {
    const first = await request(target, { path: `/shop?tdk=${mario.key}&x=1`, headers: page });
    assert.equal(first.status, 302);
    assert.equal(first.headers.location, '/shop?x=1');
    assert.match(first.headers['set-cookie'][0], /^trydash_link=l[0-9a-f]{10}\.[\w-]{43}; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=/);
    assert.equal(origin.seen.length, 0, 'the key never reaches the site');
    const cookie = cookieFrom(first);

    await request(target, { path: '/shop?x=1', headers: { ...page, cookie: `${cookie}; wp_session=abc` } });
    assert.deepEqual(origin.seen[0], { url: '/shop?x=1', cookie: 'wp_session=abc' });
    await request(target, { path: '/style.css', headers: { accept: 'text/css', cookie } });
    assert.equal(origin.seen[1].cookie, null);
    const link = store.getLink(session.id, mario.id);
    assert.equal(link.visits, 1, 'pages only, not every asset');
    assert.ok(link.firstSeen && link.lastSeen);
    const recs = inspector.list(session.id).requests;
    assert.equal(recs[0].client, 'Mario');
    const detail = inspector.get(session.id, recs[0].seq);
    assert.equal(detail.requestHeaders.some(([k, v]) => k.toLowerCase() === 'cookie' && v.includes('trydash_link')), false, 'not in the inspector either');

    // Without "links only", anyone with the URL still gets in.
    assert.equal((await request(target, { path: '/', headers: page })).status, 200);
    assert.equal(inspector.list(session.id).requests[0].client, null);

    // With it: no link, a wrong key or a revoked link get a page, not the site.
    store.updatePreview(session.id, { linksOnly: true });
    const before = origin.seen.length;
    const none = await request(target, { path: '/', headers: { ...page, 'accept-language': 'it' } });
    assert.equal(none.status, 403);
    assert.match(none.body, /Serve un link personale/);
    assert.equal((await request(target, { path: `/?tdk=${newKey()}`, headers: page })).status, 403);
    assert.equal((await request(target, { path: '/', headers: { ...page, cookie } })).status, 200);
    store.updateLink(session.id, mario.id, { revoked: true });
    const revoked = await request(target, { path: '/', headers: { ...page, cookie } });
    assert.equal(revoked.status, 403);
    assert.match(revoked.body, /isn’t valid or was revoked/);
    assert.match(revoked.headers['set-cookie'][0], /trydash_link=; .*Max-Age=0/);
    assert.equal((await request(target, { path: `/?tdk=${mario.key}`, headers: page })).status, 403);
    assert.equal(origin.seen.length, before + 1, 'only the request with a valid link got through');

    // The owner's key (the dashboard's Open button) works and isn't counted as a client.
    const owner = await request(target, { path: `/?tdk=${store.get(session.id).ownerKey}`, headers: page });
    assert.equal(owner.status, 302);
    assert.equal((await request(target, { path: '/', headers: { ...page, cookie: cookieFrom(owner) } })).status, 200);
    assert.equal(inspector.list(session.id).requests[0].client, null);

    // A WebSocket needs the link too.
    const ws = await new Promise((resolve) => {
      const socket = net.connect(Number(new URL(target).port), '127.0.0.1', () => {
        socket.write('GET /hmr HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
      });
      socket.once('data', (d) => { resolve(d.toString('latin1').split('\r\n')[0]); socket.destroy(); });
    });
    assert.equal(ws, 'HTTP/1.1 403 Forbidden');
  } finally {
    await inspector.closeAll();
    await origin.close();
  }
});

test('a link with a PIN asks for it, and locks after five wrong tries', async () => {
  const origin = await startOrigin();
  let now = Date.now();
  const store = dash.createSessionStore();
  const inspector = createInspector({ store, clock: () => now });
  const session = store.create(origin.url, { linksOnly: true });
  const key = newKey();
  const anna = store.addLink(session.id, { id: newId(), name: 'Anna', key, pinHash: pinHash(key, '482191') });
  const target = await inspector.open(session);
  const form = (pin, back = '/catalogo?p=2', ip = '203.0.113.10') => request(target, {
    method: 'POST',
    path: '/__trydash/pin',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'accept-language': 'it-IT', 'cf-connecting-ip': ip },
    body: new URLSearchParams({ key, pin, back }).toString(),
  });
  try {
    const ask = await request(target, { path: `/catalogo?tdk=${key}&p=2`, headers: { 'accept-language': 'it' } });
    assert.equal(ask.status, 200);
    assert.match(ask.body, /Inserisci il PIN/);
    assert.match(ask.body, /name="back" value="\/catalogo\?p=2"/);
    assert.equal(ask.headers['set-cookie'], undefined);

    const wrong = await form('111111');
    assert.equal(wrong.status, 401);
    assert.match(wrong.body, /PIN errato/);
    for (let i = 0; i < 3; i += 1) await form('111111');
    const locked = await form('111111');
    assert.equal(locked.status, 429);
    assert.match(locked.body, /Troppi tentativi/);
    assert.equal((await form('482191')).status, 429, 'even the right PIN waits while locked');
    const other = await form('482191', '/catalogo?p=2', '203.0.113.11');
    assert.equal(other.status, 303, 'another visitor is not locked out');
    assert.equal(other.headers.location, '/catalogo?p=2');

    now += 11 * 60 * 1000;
    const bulky = `x=${'a'.repeat(5000)}&${new URLSearchParams({ key, pin: '482191', back: '/catalogo?p=2' })}`;
    assert.equal((await request(target, {
      method: 'POST', path: '/__trydash/pin',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': '203.0.113.10' },
      body: bulky,
    })).status, 413);
    const ok = await form('482191');
    assert.equal(ok.status, 303);
    assert.equal(ok.headers.location, '/catalogo?p=2');
    const cookie = cookieFrom(ok);
    assert.equal((await request(target, { path: '/catalogo?p=2', headers: { cookie } })).status, 200);
    for (const back of ['//evil.example/', '/\t/evil.com', '/\t\\evil.com', '/ok\r\nSet-Cookie: a=1']) {
      assert.equal((await form('482191', back)).headers.location, '/', `no open redirect for ${JSON.stringify(back)}`);
    }

    // A new PIN logs out the cookies made with the old one.
    store.updateLink(session.id, anna.id, { pinHash: pinHash(key, '999999') });
    assert.equal((await request(target, { path: '/', headers: { cookie } })).status, 403);
    assert.equal(origin.seen.length, 1);
  } finally {
    await inspector.closeAll();
    await origin.close();
  }
});

test('a folder tunnel takes personal links too', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trydash-links-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<p>portfolio</p>');
  const store = dash.createSessionStore();
  const firsts = [];
  const inspector = createInspector({ store, onFirstVisit: (id, link) => firsts.push(link.name) });
  const session = store.create('', { mode: 'folder', folder: dir, linksOnly: true });
  const link = store.addLink(session.id, { id: newId(), name: 'Luca', key: newKey() });
  const target = await inspector.open(session);
  try {
    assert.equal((await request(target, { path: '/' })).status, 403);
    const cookie = cookieFrom(await request(target, { path: `/?tdk=${link.key}` }));
    const page = await request(target, { path: '/', headers: { cookie, accept: 'text/html' } });
    assert.equal(page.body, '<p>portfolio</p>');
    await request(target, { path: '/', headers: { cookie, accept: 'text/html' } });
    assert.deepEqual(firsts, ['Luca'], 'the first visit only');
  } finally {
    await inspector.closeAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('links API: create with or without PIN, rename, revoke, delete; saved and restored with their keys', async () => {
  const saves = [];
  const persist = { file: '/tmp/none.json', save: (list) => { saves.push(JSON.parse(JSON.stringify(list))); return true; }, load: () => [] };
  const app = createApp({ probe: async () => ({ present: true, version: 'test' }), persist });
  await app.listen(0, '127.0.0.1');
  const call = async (method, p, body) => {
    const res = await fetch(`${app.url}${p}`, { method, headers: { 'Content-Type': 'application/json', 'Accept-Language': 'it' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  try {
    const session = app.store.create('http://127.0.0.1:9', { inspect: true });
    app.store.setOwnerKey(session.id, newKey());
    const base = `/api/sessions/${session.id}/links`;
    const made = await call('POST', base, { name: 'Mario Rossi', pin: '482191' });
    assert.equal(made.status, 201);
    assert.equal(made.json.link.name, 'Mario Rossi');
    assert.equal(made.json.link.hasPin, true);
    assert.equal(made.json.link.pinHash, undefined, 'the hash never leaves the server');
    assert.equal((await call('POST', base, { name: 'x', pin: '12' })).json.error, 'Il PIN deve avere da 6 a 8 cifre.');
    assert.equal((await call('POST', base, { name: 'x', pin: '4821' })).json.error, 'Il PIN deve avere da 6 a 8 cifre.');
    assert.equal((await call('POST', base, { name: '' })).status, 400);
    const plain = (await call('POST', base, { name: 'Anna' })).json.link;
    assert.equal(plain.hasPin, false);

    const state = (await call('GET', '/api/state')).json.sessions.find((s) => s.id === session.id);
    assert.deepEqual(state.links.map((l) => l.name), ['Mario Rossi', 'Anna']);
    assert.equal(JSON.stringify(state).includes('pinHash'), false);

    const renamed = await call('PATCH', `${base}/${plain.id}`, { name: 'Anna B.', revoked: true, pin: '123456' });
    assert.deepEqual([renamed.json.link.name, renamed.json.link.revoked, renamed.json.link.hasPin], ['Anna B.', true, true]);
    assert.equal((await call('PATCH', `${base}/${plain.id}`, { pin: '' })).json.link.hasPin, false);
    assert.equal((await call('PATCH', `${base}/lffffffffff`, { name: 'x' })).status, 404);

    const saved = saves[saves.length - 1][0];
    assert.match(saved.ownerKey, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(saved.links.length, 2);
    assert.match(saved.links[0].pinHash, /^[0-9a-f]{64}$/);
    assert.equal((await call('DELETE', `${base}/${plain.id}`)).status, 200);
    assert.equal(app.store.get(session.id).links.length, 1);

    // Restored: same keys, so the links sent to clients keep working on the new URL.
    const restoredApp = createApp({ probe: async () => ({ present: true, version: 'test' }), persist: { ...persist, save: () => true } });
    const [restored] = restoredApp.restoreTunnels([{ origin: 'http://127.0.0.1:9', options: { inspect: true }, ownerKey: 'O'.repeat(22), links: saves[saves.length - 1][0].links }]);
    assert.equal(restored.ownerKey, 'O'.repeat(22));
    assert.equal(restored.links[0].key, made.json.link.key);
    assert.equal(restored.links[0].pinHash, saves[saves.length - 1][0].links[0].pinHash);
    await restoredApp.close();
  } finally {
    await app.close();
  }
});
