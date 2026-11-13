import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { loadDashboard, browserScripts } from '../src/load-dashboard.js';
import { readAsset } from '../src/assets.js';
import { createInspector } from '../src/inspector.js';
import { createApp } from '../server.js';
import { newKey, newId } from '../src/links.js';

const dash = loadDashboard();

function request(target, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(target);
    const req = http.request({ hostname: url.hostname, port: url.port, method, path: p, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function startOrigin() {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>Bottega</title><body><h1 id="hero">Ciao</h1></body>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { seen, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

const post = (target, body, headers = {}) => request(target, {
  method: 'POST',
  path: '/__trydash/comments',
  headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile Safari/604.1', ...headers },
  body: JSON.stringify(body),
});

test('with comments on, pages get the widget and the tunnel takes comments; the site never sees /__trydash/', async () => {
  const origin = await startOrigin();
  const store = dash.createSessionStore();
  const saved = [];
  const inspector = createInspector({ store, onComment: (id, c) => saved.push(c.id) });
  const session = store.create(origin.url, { comments: true });
  assert.equal(store.get(session.id).options.inspect, true);
  const target = await inspector.open(session);
  try {
    const page = await request(target, { path: '/' });
    assert.match(page.body, /<h1 id="hero">Ciao<\/h1><script src="\/__trydash\/comments.js" defer data-trydash="comments"><\/script><\/body>/);
    const js = await request(target, { path: '/__trydash/comments.js' });
    assert.equal(js.status, 200);
    assert.match(js.headers['content-type'], /^text\/javascript/);
    assert.equal(js.body, readAsset('public/widget/comments.js').toString('utf8'));

    const made = await post(target, {
      page: '/chi-siamo/', title: 'Chi siamo', text: 'Il titolo più grande, per favore', name: 'Mario',
      selector: '#hero', x: 0.25, y: 2, docX: 120, docY: -5, element: { tag: 'h1', text: 'Ciao' },
      viewport: { w: 390, h: 844, dpr: 3 }, errors: ['TypeError: x is undefined (app.js:12)'],
    }, { 'cf-connecting-ip': '203.0.113.7' });
    assert.equal(made.status, 201);
    const { comment } = JSON.parse(made.body);
    assert.match(comment.id, /^c[0-9a-f]{10}$/);
    assert.deepEqual([comment.x, comment.y, comment.docX, comment.docY], [0.25, 1, 120, 0], 'clamped');
    const kept = store.get(session.id).comments[0];
    assert.equal(kept.author, 'Mario');
    assert.equal(kept.page, '/chi-siamo/');
    assert.deepEqual(kept.viewport, { w: 390, h: 844, dpr: 3 });
    assert.deepEqual(kept.errors, ['TypeError: x is undefined (app.js:12)']);
    assert.match(kept.userAgent, /iPhone/);
    assert.equal(kept.linkId, null);
    assert.deepEqual(saved, [comment.id], 'the server is told, to save it');

    const list = JSON.parse((await request(target, { path: '/__trydash/comments?page=%2Fchi-siamo%2F' })).body);
    assert.deepEqual(list.comments.map((c) => c.text), ['Il titolo più grande, per favore']);
    assert.equal(list.me, null);
    assert.equal(list.comments[0].userAgent, undefined, 'visitors see the pin, not the details');
    assert.equal(JSON.parse((await request(target, { path: '/__trydash/comments?page=/' })).body).comments.length, 0);

    // JSON only (no cross-site form posts), real text only, a page path, and a rate limit.
    assert.equal((await request(target, { method: 'POST', path: '/__trydash/comments', headers: { 'Content-Type': 'text/plain' }, body: '{"page":"/","text":"x"}' })).status, 415);
    assert.equal((await post(target, { page: '/', text: '   ' })).status, 400);
    assert.equal((await post(target, { page: 'https://evil/', text: 'x' })).status, 400);
    assert.equal((await post(target, { page: '/', text: 'x'.repeat(20000) })).status, 400);
    for (let i = 0; i < 29; i += 1) await post(target, { page: '/', text: `n${i}` }, { 'cf-connecting-ip': '198.51.100.1' });
    assert.equal((await post(target, { page: '/', text: 'one too many' }, { 'cf-connecting-ip': '198.51.100.1' })).status, 201);
    assert.equal((await post(target, { page: '/', text: 'now too many' }, { 'cf-connecting-ip': '198.51.100.1' })).status, 429);
    assert.equal((await post(target, { page: '/', text: 'another visitor' }, { 'cf-connecting-ip': '198.51.100.2' })).status, 201);
    assert.equal((await request(target, { path: '/__trydash/other' })).status, 404);
    assert.deepEqual(origin.seen, ['/'], 'nothing under /__trydash/ reached the site');

    // Turned off: no widget, no endpoint.
    store.updatePreview(session.id, { comments: false });
    assert.doesNotMatch((await request(target, { path: '/' })).body, /__trydash/);
    assert.equal((await request(target, { path: '/__trydash/comments.js' })).status, 404);
  } finally {
    await inspector.closeAll();
    await origin.close();
  }
});

test('a client with a personal link comments under their name and sees only their comments; the owner sees all', async () => {
  const origin = await startOrigin();
  const store = dash.createSessionStore();
  const inspector = createInspector({ store });
  const session = store.create(origin.url, { comments: true });
  store.setOwnerKey(session.id, newKey());
  const mario = store.addLink(session.id, { id: newId(), name: 'Mario Rossi', key: newKey() });
  const target = await inspector.open(session);
  const cookieFor = async (key) => (await request(target, { path: `/?tdk=${key}` })).headers['set-cookie'][0].split(';')[0];
  try {
    const marioCookie = await cookieFor(mario.key);
    await post(target, { page: '/', text: 'da Mario', name: 'Finto nome' }, { cookie: marioCookie });
    await post(target, { page: '/', text: 'anonimo', name: '' });
    const kept = store.get(session.id).comments;
    assert.deepEqual(JSON.parse(JSON.stringify(kept.map((c) => [c.text, c.author, c.linkId]))), [['da Mario', 'Mario Rossi', mario.id], ['anonimo', null, null]]);
    const forMario = JSON.parse((await request(target, { path: '/__trydash/comments?page=/', headers: { cookie: marioCookie } })).body);
    assert.deepEqual(forMario.me, { name: 'Mario Rossi' });
    assert.deepEqual(forMario.comments.map((c) => c.text), ['da Mario']);
    const anon = JSON.parse((await request(target, { path: '/__trydash/comments?page=/' })).body);
    assert.deepEqual(anon.comments.map((c) => c.text), ['anonimo']);
    const ownerCookie = await cookieFor(store.get(session.id).ownerKey);
    const owner = JSON.parse((await request(target, { path: '/__trydash/comments?page=/', headers: { cookie: ownerCookie } })).body);
    assert.deepEqual(owner.comments.map((c) => c.text).sort(), ['anonimo', 'da Mario']);
    // A resolved comment leaves the page.
    store.setCommentResolved(session.id, kept[0].id, true);
    assert.equal(JSON.parse((await request(target, { path: '/__trydash/comments?page=/', headers: { cookie: marioCookie } })).body).comments.length, 0);
    // Links only: no comments from outside.
    store.updatePreview(session.id, { linksOnly: true });
    assert.equal((await post(target, { page: '/', text: 'intruso' })).status, 403);
  } finally {
    await inspector.closeAll();
    await origin.close();
  }
});

test('the author can edit or delete their comment: same link, same browser (edit key), or the owner', async () => {
  const origin = await startOrigin();
  const store = dash.createSessionStore();
  const inspector = createInspector({ store });
  const session = store.create(origin.url, { comments: true });
  store.setOwnerKey(session.id, newKey());
  const mario = store.addLink(session.id, { id: newId(), name: 'Mario', key: newKey() });
  const target = await inspector.open(session);
  const change = (id, method, body, headers = {}) => request(target, { method, path: `/__trydash/comments/${id}`, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body || {}) });
  const cookieFor = async (key) => (await request(target, { path: `/?tdk=${key}` })).headers['set-cookie'][0].split(';')[0];
  try {
    const anon = JSON.parse((await post(target, { page: '/', text: 'prima versione' })).body);
    assert.match(anon.editKey, /^[\w-]{22}$/);
    assert.equal(anon.comment.mine, true);
    assert.equal(store.get(session.id).comments[0].editHash.length, 64, 'only a hash is kept');
    assert.equal((await change(anon.comment.id, 'PATCH', { text: 'hack' })).status, 403, 'no key, not yours');
    assert.equal((await change(anon.comment.id, 'PATCH', { text: 'hack', editKey: 'x'.repeat(22) })).status, 403);
    const edited = await change(anon.comment.id, 'PATCH', { text: 'seconda versione', editKey: anon.editKey });
    assert.equal(edited.status, 200);
    assert.equal(JSON.parse(edited.body).comment.text, 'seconda versione');
    assert.ok(store.get(session.id).comments[0].editedAt);
    assert.equal((await change(anon.comment.id, 'PATCH', { text: '  ', editKey: anon.editKey })).status, 400);
    assert.equal((await request(target, { method: 'PATCH', path: `/__trydash/comments/${anon.comment.id}`, headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);

    const marioCookie = await cookieFor(mario.key);
    const his = JSON.parse((await post(target, { page: '/', text: 'di Mario' }, { cookie: marioCookie })).body).comment;
    const listed = JSON.parse((await request(target, { path: '/__trydash/comments?page=/', headers: { cookie: marioCookie } })).body).comments;
    assert.equal(listed.find((c) => c.id === his.id).mine, true, 'his link says it is his, on any browser');
    assert.equal((await change(his.id, 'DELETE', {})).status, 403);
    assert.equal((await change(his.id, 'DELETE', {}, { cookie: marioCookie })).status, 200);
    assert.equal(store.get(session.id).comments.some((c) => c.id === his.id), false);

    const ownerCookie = await cookieFor(store.get(session.id).ownerKey);
    assert.equal((await change(anon.comment.id, 'DELETE', {}, { cookie: ownerCookie })).status, 200, 'the owner may tidy up');
    assert.equal((await change(anon.comment.id, 'DELETE', {}, { cookie: ownerCookie })).status, 404);
  } finally {
    await inspector.closeAll();
    await origin.close();
  }
});

test('a folder gets the widget too', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trydash-comments-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<html><body><p>ok</p></body></html>');
  const store = dash.createSessionStore();
  const inspector = createInspector({ store });
  const session = store.create('', { mode: 'folder', folder: dir, comments: true });
  const target = await inspector.open(session);
  try {
    assert.match((await request(target, { path: '/' })).body, /<p>ok<\/p><script src="\/__trydash\/comments.js"/);
    assert.equal((await post(target, { page: '/', text: 'bella' })).status, 201);
  } finally {
    await inspector.closeAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('comments API: newest first, version, resolve, delete, counts in the state, saved and restored', async () => {
  const saves = [];
  const persist = { file: '/tmp/none.json', save: (list) => { saves.push(JSON.parse(JSON.stringify(list))); return true; }, load: () => [] };
  const app = createApp({ probe: async () => ({ present: true, version: 'test' }), persist });
  await app.listen(0, '127.0.0.1');
  const call = async (method, p, body) => {
    const res = await fetch(`${app.url}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  try {
    const session = app.store.create('http://127.0.0.1:9', { comments: true });
    const target = await app.inspector.open(session);
    await post(target, { page: '/', text: 'primo' });
    await post(target, { page: '/a', text: 'secondo' });
    assert.equal(saves.length, 2, 'saved after each comment');
    assert.deepEqual(saves[1][0].comments.map((c) => c.text), ['primo', 'secondo']);
    const base = `/api/sessions/${session.id}/comments`;
    const list = await call('GET', base);
    assert.deepEqual(list.json.comments.map((c) => c.text), ['secondo', 'primo']);
    assert.deepEqual((await call('GET', `${base}?version=${list.json.version}`)).json, { version: list.json.version, unchanged: true });
    const state = (await call('GET', '/api/state')).json.sessions.find((s) => s.id === session.id);
    assert.deepEqual(state.comments, { open: 2, total: 2, version: list.json.version });
    const first = list.json.comments[1];
    assert.equal((await call('PATCH', `${base}/${first.id}`, { resolved: true })).json.comment.resolved, true);
    assert.equal((await call('GET', '/api/state')).json.sessions.find((s) => s.id === session.id).comments.open, 1);
    assert.equal((await call('DELETE', `${base}/${first.id}`)).status, 200);
    assert.equal((await call('DELETE', `${base}/${first.id}`)).status, 404);
    assert.equal((await call('POST', base)).status, 405);

    const again = createApp({ probe: async () => ({ present: true, version: 'test' }) });
    const [restored] = again.restoreTunnels([{ origin: 'http://127.0.0.1:9', options: { comments: true }, comments: saves[1][0].comments.concat([{ id: 'bad', text: 'x' }]) }]);
    assert.deepEqual(JSON.parse(JSON.stringify(restored.comments.map((c) => c.text))), ['primo', 'secondo'], 'broken entries are left out');
    await again.close();
  } finally {
    await app.close();
  }
});

test('dashboard helpers: browser, Markdown, the link to the pin', () => {
  const sandbox = { console, URL, Date, Intl, navigator: { language: 'it-IT' } };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const rel of browserScripts) {
    if (/app\.js$/.test(rel)) continue;
    vm.runInContext(readAsset(rel).toString('utf8'), sandbox, { filename: rel });
  }
  const T = sandbox.TryDash;
  T.setLang ? T.setLang('it') : (T.lang = 'it');
  assert.equal(T.browserOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36'), 'Chrome 131 · macOS');
  assert.equal(T.browserOf('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile/15E148 Safari/604.1'), 'Safari 18 · iOS');
  assert.equal(T.browserOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0 Safari/537.36 Edg/131.0'), 'Edge 131 · Windows');
  const session = { url: 'https://a-b.trycloudflare.com', options: { linksOnly: false }, ownerKey: 'OWNERKEYOWNERKEYOWNERK', inspect: { enabled: true } };
  const comment = { id: 'c0123456789', at: '2026-11-13T10:22:00.000Z', page: '/chi-siamo/?x=1', title: 'Chi siamo', text: 'Più grande\ngrazie', author: 'Mario', element: { tag: 'h1', text: 'Chi siamo' }, viewport: { w: 390, h: 844 }, userAgent: 'iPhone OS 18_0 Version/18.0 Safari/604.1', errors: ['TypeError: x'] };
  // Always with the owner's key: the owner sees the pins of every client, links only or not.
  assert.equal(T.commentUrl(session, comment), 'https://a-b.trycloudflare.com/chi-siamo/?x=1&tdk=OWNERKEYOWNERKEYOWNERK#trydash-comment=c0123456789');
  assert.equal(T.commentUrl({ ...session, ownerKey: null }, comment), 'https://a-b.trycloudflare.com/chi-siamo/?x=1#trydash-comment=c0123456789');
  assert.equal(T.ownerUrl(session), 'https://a-b.trycloudflare.com/?tdk=OWNERKEYOWNERKEYOWNERK');
  assert.equal(T.ownerUrl({ ...session, inspect: { enabled: false } }), 'https://a-b.trycloudflare.com');
  const md = T.commentMarkdown({ ...session, options: { linksOnly: true } }, comment);
  assert.match(md, /^\*\*Mario\*\* · .* · `\/chi-siamo\/\?x=1` \(“Chi siamo”\)\n> Più grande\n> grazie\n`<h1> “Chi siamo”` · 390×844 · Safari 18 · iOS\nErrori JavaScript:\n- `TypeError: x`\nhttps:\/\/a-b\.trycloudflare\.com\/chi-siamo\/\?x=1#trydash-comment=c0123456789$/);
  assert.doesNotMatch(md, /OWNERKEY/, 'the owner key never goes into a copied comment');
});
