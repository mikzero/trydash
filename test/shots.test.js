import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { findBrowser, clampViewport, createShooter, capture } from '../src/shots.js';
import { createApp, chromeArgs } from '../server.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');

function request(target, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(target);
    const req = http.request({ hostname: url.hostname, port: url.port, method, path: p, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function until(check, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('timed out');
}

test('finding a browser: TRYDASH_CHROME, the usual places, the PATH', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trydash-browser-'));
  try {
    const chromium = path.join(dir, 'chromium');
    fs.writeFileSync(chromium, '#!/bin/sh\n', { mode: 0o755 });
    assert.equal(findBrowser({ env: { PATH: dir }, platform: 'linux' }), chromium);
    assert.equal(findBrowser({ env: { PATH: '/nowhere' }, platform: 'linux' }), null);
    assert.equal(findBrowser({ env: { TRYDASH_CHROME: chromium }, platform: 'linux' }), chromium);
    assert.equal(findBrowser({ env: { TRYDASH_CHROME: '/missing/chrome', PATH: dir }, platform: 'linux' }), null, 'a wrong TRYDASH_CHROME is not second-guessed');
    const mac = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
    assert.equal(findBrowser({ env: {}, platform: 'darwin', exists: (f) => f === mac }), mac);
    const win = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    assert.equal(findBrowser({ env: { PROGRAMFILES: 'C:\\Program Files' }, platform: 'win32', exists: (f) => f === win }), win);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(clampViewport({ w: 390, h: 844 }), { width: 390, height: 844 });
  assert.deepEqual(clampViewport({ w: 10, h: 99999 }), { width: 320, height: 2000 });
  assert.deepEqual(clampViewport(null), { width: 1280, height: 800 });
  assert.deepEqual(chromeArgs('["--host-resolver-rules=MAP *.x 127.0.0.1:1", "--no-proxy-server"]'), ['--host-resolver-rules=MAP *.x 127.0.0.1:1', '--no-proxy-server']);
  assert.deepEqual(chromeArgs('--a --b'), ['--a', '--b']);
  assert.deepEqual(chromeArgs(''), []);
});

test('one screenshot at a time', async () => {
  const log = [];
  const shooter = createShooter({
    browser: '/bin/chrome',
    captureImpl: async (job) => {
      log.push(`start ${job.n}`);
      await new Promise((r) => setTimeout(r, 20));
      log.push(`end ${job.n}`);
      if (job.n === 2) throw new Error('boom');
      return { width: 1, height: 1 };
    },
  });
  assert.equal(shooter.available, true);
  const all = await Promise.allSettled([1, 2, 3].map((n) => shooter.take({ n })));
  assert.deepEqual(log, ['start 1', 'end 1', 'start 2', 'end 2', 'start 3', 'end 3']);
  assert.deepEqual(all.map((r) => r.status), ['fulfilled', 'rejected', 'fulfilled'], 'a failure does not stop the next one');
  assert.equal(createShooter({ browser: null }).available, false);
});

test('a new comment gets its screenshot: public URL with the owner key and the pin, client screen size; served, retaken, deleted', async () => {
  const shotsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trydash-shots-test-'));
  const jobs = [];
  let fail = false;
  const shooter = {
    available: true,
    take: async (job) => {
      jobs.push(job);
      if (fail) throw new Error('net::ERR_NAME_NOT_RESOLVED');
      fs.writeFileSync(job.file, PNG);
      return { width: 390, height: 844 };
    },
  };
  const app = createApp({ probe: async () => ({ present: true, version: 'test' }), shooter, shotsDir });
  await app.listen(0, '127.0.0.1');
  const call = async (method, p) => {
    const res = await fetch(`${app.url}${p}`, { method });
    return { status: res.status, type: res.headers.get('content-type'), buf: Buffer.from(await res.arrayBuffer()) };
  };
  try {
    const session = app.store.create('http://127.0.0.1:9', { comments: true });
    app.store.setOwnerKey(session.id, 'OWNERKEYOWNERKEYOWNERK');
    app.store.get(session.id).url = 'https://shy-fox.trycloudflare.com';
    const target = await app.inspector.open(session);
    const post = (body) => request(target, { method: 'POST', path: '/__trydash/comments', headers: { 'Content-Type': 'application/json', 'Accept-Language': 'it-IT,it;q=0.9' }, body: JSON.stringify(body) });
    const made = JSON.parse((await post({ page: '/chi-siamo/?a=1', text: 'più grande', viewport: { w: 390, h: 844 } })).body.toString()).comment;
    const shot = await until(() => app.store.get(session.id).comments[0].shot.state === 'ready' && app.store.get(session.id).comments[0].shot);
    assert.deepEqual([shot.width, shot.height], [390, 844]);
    assert.equal(jobs[0].url, `https://shy-fox.trycloudflare.com/chi-siamo/?a=1&tdk=OWNERKEYOWNERKEYOWNERK#trydash-comment=${made.id}&trydash-shot=1&trydash-lang=it`);
    assert.deepEqual(jobs[0].viewport, { w: 390, h: 844, dpr: 1 });
    assert.equal(jobs[0].file, path.join(shotsDir, `${made.id}.png`));

    const png = await call('GET', `/api/sessions/${session.id}/comments/${made.id}/screenshot`);
    assert.equal(png.status, 200);
    assert.equal(png.type, 'image/png');
    assert.deepEqual(png.buf, PNG);

    fail = true;
    assert.equal((await call('POST', `/api/sessions/${session.id}/comments/${made.id}/screenshot`)).status, 202);
    const failed = await until(() => app.store.get(session.id).comments[0].shot.state === 'failed' && app.store.get(session.id).comments[0].shot);
    assert.deepEqual([failed.reason, failed.detail], ['browser', 'net::ERR_NAME_NOT_RESOLVED']);

    // Tunnel down: no attempt, a clear reason.
    app.store.get(session.id).url = null;
    await post({ page: '/', text: 'senza URL' });
    const noUrl = await until(() => app.store.get(session.id).comments.find((c) => c.text === 'senza URL').shot);
    assert.deepEqual([noUrl.state, noUrl.reason], ['failed', 'no-url']);
    assert.equal((await call('GET', `/api/sessions/${session.id}/comments/${app.store.get(session.id).comments[1].id}/screenshot`)).status, 404);

    assert.equal((await call('DELETE', `/api/sessions/${session.id}/comments/${made.id}`)).status, 200);
    assert.equal(fs.existsSync(path.join(shotsDir, `${made.id}.png`)), false, 'deleted with its comment');
  } finally {
    await app.close();
    fs.rmSync(shotsDir, { recursive: true, force: true });
  }
});

test('without a browser on the computer, comments say how to get screenshots', async () => {
  const app = createApp({ probe: async () => ({ present: true, version: 'test' }), shooter: { available: false, take: () => Promise.reject(new Error('no')) } });
  await app.listen(0, '127.0.0.1');
  try {
    const session = app.store.create('http://127.0.0.1:9', { comments: true });
    app.store.get(session.id).url = 'https://shy-fox.trycloudflare.com';
    const target = await app.inspector.open(session);
    await request(target, { method: 'POST', path: '/__trydash/comments', headers: { 'Content-Type': 'application/json' }, body: '{"page":"/","text":"ciao"}' });
    assert.equal(app.store.get(session.id).comments[0].shot.state, 'off');
  } finally {
    await app.close();
  }
});

// A real browser, when there is one: Playwright's Chromium here, Chrome on a developer machine.
const realBrowser = findBrowser() || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : null);

test('a real headless screenshot of a local page', { skip: !realBrowser, timeout: 60000 }, async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><meta name="viewport" content="width=device-width"><body style="margin:0;background:#c2410c"><h1>Ciao</h1></body>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trydash-real-shot-'));
  try {
    const file = path.join(dir, 'shot.png');
    const size = await capture({ browser: realBrowser, url: `http://127.0.0.1:${server.address().port}/`, viewport: { w: 390, h: 600 }, file, settleMs: 200, extraArgs: ['--no-proxy-server'] });
    assert.deepEqual(size, { width: 390, height: 600 });
    const png = fs.readFileSync(file);
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(png.readUInt32BE(16), 390, 'PNG width');
    assert.equal(png.readUInt32BE(20), 600, 'PNG height');
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
