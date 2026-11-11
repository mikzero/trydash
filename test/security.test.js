import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { loadDashboard } from '../src/load-dashboard.js';
import { lineSplitter, stopProcess, MAX_LINE } from '../src/runtime.js';
import { createInspector } from '../src/inspector.js';
import { createApp, isAllowedRequest, SECURITY_HEADERS, MAX_SESSIONS } from '../server.js';

const dash = loadDashboard();

function quietProcess() {
  const proc = new EventEmitter();
  proc.stdout = Readable.from([]);
  proc.stderr = Readable.from([]);
  proc.pid = 0;
  proc.kill = () => {};
  return proc;
}

function raw(url, { method = 'GET', path = '/', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = http.request({ hostname: target.hostname, port: target.port, method, path, headers, agent: false }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('every dashboard response forbids framing, sniffing and inline code', async () => {
  const app = createApp({ probe: async () => ({ present: true, version: 'test' }), spawn: quietProcess });
  await app.listen(0, '127.0.0.1');
  try {
    for (const path of ['/', '/js/app.js', '/api/state', '/missing']) {
      const res = await raw(app.url, { path });
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.equal(res.headers[name.toLowerCase()], value, `${path} ${name}`);
    }
    assert.match(SECURITY_HEADERS['Content-Security-Policy'], /frame-ancestors 'none'/);
    assert.doesNotMatch(SECURITY_HEADERS['Content-Security-Policy'], /unsafe-inline|unsafe-eval/);
  } finally {
    await app.close();
  }
});

test('with a token, the API needs it as a cookie or a bearer header', async () => {
  const app = createApp({ token: 'tok-123', probe: async () => ({ present: true, version: 'test' }), spawn: quietProcess });
  await app.listen(0, '127.0.0.1');
  const port = new URL(app.url).port;
  try {
    const denied = await raw(app.url, { path: '/api/state', headers: { 'Accept-Language': 'en' } });
    assert.equal(denied.status, 401);
    assert.equal(JSON.parse(denied.body).key, 'request.unauthorized');
    assert.equal((await raw(app.url, { path: '/' })).status, 200);
    assert.equal((await raw(app.url, { path: '/api/state', headers: { Authorization: 'Bearer nope' } })).status, 401);
    assert.equal((await raw(app.url, { path: '/api/state', headers: { Authorization: 'Bearer tok-123' } })).status, 200);
    assert.equal((await raw(app.url, { method: 'POST', path: '/api/sessions', headers: { 'Content-Type': 'application/json' } })).status, 401);

    const wrong = await raw(app.url, { path: '/?token=nope' });
    assert.equal(wrong.status, 303);
    assert.equal(wrong.headers['set-cookie'], undefined);

    const login = await raw(app.url, { path: '/?token=tok-123&x=1' });
    assert.equal(login.status, 303);
    assert.equal(login.headers.location, '/?x=1');
    const cookie = login.headers['set-cookie'][0];
    assert.equal(cookie, `trydash_${port}=tok-123; HttpOnly; SameSite=Strict; Path=/`);
    const withCookie = await raw(app.url, { path: '/api/state', headers: { Cookie: `other=1; trydash_${port}=tok-123` } });
    assert.equal(withCookie.status, 200);
    assert.equal((await raw(app.url, { path: '/api/state', headers: { Cookie: 'trydash_1=tok-123' } })).status, 401);
  } finally {
    await app.close();
  }
});

test('API calls from another page are refused, even a GET and even from another port', async () => {
  let probes = 0;
  const app = createApp({
    probe: async () => { probes += 1; await new Promise((r) => setTimeout(r, 20)); return { present: true, version: 'test' }; },
    spawn: quietProcess,
  });
  await app.listen(0, '127.0.0.1');
  try {
    for (const site of ['cross-site', 'same-site']) {
      const res = await raw(app.url, { path: '/api/probe?fresh=1', headers: { 'Sec-Fetch-Site': site } });
      assert.equal(res.status, 403, site);
    }
    assert.equal(probes, 0);
    assert.equal((await raw(app.url, { path: '/', headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 200);
    assert.equal((await raw(app.url, { path: '/api/state', headers: { 'Sec-Fetch-Site': 'same-origin' } })).status, 200);
    assert.equal(isAllowedRequest('GET', { host: '127.0.0.1:1', 'sec-fetch-site': 'none' }, { api: true }), true);
    assert.equal(isAllowedRequest('GET', { host: '127.0.0.1:1' }, { api: true }), true);

    // A burst of refreshes shares one running probe.
    probes = 0;
    await Promise.all(Array.from({ length: 10 }, () => raw(app.url, { path: '/api/probe?fresh=1' })));
    assert.equal(probes, 1);
  } finally {
    await app.close();
  }
});

test('the number of tunnels is capped', async () => {
  const app = createApp({ probe: async () => ({ present: true, version: 'test' }), spawn: quietProcess });
  await app.listen(0, '127.0.0.1');
  const post = (body) => fetch(`${app.url}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    for (let i = 0; i < MAX_SESSIONS; i += 1) assert.equal((await post({ options: { mode: 'hello' } })).status, 201);
    const over = await post({ options: { mode: 'hello' } });
    assert.equal(over.status, 429);
    assert.equal((await over.json()).key, 'session.tooMany');
  } finally {
    await app.close();
  }
});

test('stored logs and single lines are bounded', async () => {
  const store = dash.createSessionStore();
  const session = store.create('3000');
  const lines = Array.from({ length: dash.MAX_ENTRIES + 10 }, (_, i) => (i % 2 ? `ERR line ${i}` : `INF line ${i}`));
  store.appendChunk(session.id, lines.join('\n'));
  assert.equal(session.droppedEntries, dash.LOG_DROP);
  assert.equal(session.entries.length, dash.MAX_ENTRIES + 10 - dash.LOG_DROP);
  assert.equal(session.entries[0].index, dash.LOG_DROP);
  assert.equal(session.entries[0].message, `line ${dash.LOG_DROP}`);
  assert.equal(session.counts.info + session.counts.error, session.entries.length);
  assert.equal(store.select(session.id, dash.LOG_DROP + 1).message, `line ${dash.LOG_DROP + 1}`);

  const app = createApp({ store, probe: async () => ({ present: true, version: 'test' }), spawn: quietProcess });
  await app.listen(0, '127.0.0.1');
  try {
    assert.equal((await fetch(`${app.url}/api/sessions/${session.id}/entries/3`)).status, 404);
    const kept = await (await fetch(`${app.url}/api/sessions/${session.id}/entries/${dash.LOG_DROP + 2}`)).json();
    assert.equal(kept.detail.message, `line ${dash.LOG_DROP + 2}`);
    const state = await (await fetch(`${app.url}/api/state`)).json();
    assert.equal(state.sessions[0].droppedEntries, dash.LOG_DROP);
  } finally {
    await app.close();
  }

  const seen = [];
  const split = lineSplitter((line) => seen.push(line), 10);
  split.push('short\n0123456789ABC');
  split.push('DEFGHIJ still the same line');
  split.push(' end\nnext\npart');
  split.end();
  assert.deepEqual(seen, ['short', '0123456789 … [riga troncata]', 'next', 'part']);
  assert.equal(MAX_LINE, 16 * 1024);
});

test('a process that ignores SIGTERM gets SIGKILL', async () => {
  const proc = new EventEmitter();
  const signals = [];
  proc.exitCode = null;
  proc.signalCode = null;
  proc.kill = (name) => {
    signals.push(name);
    if (name === 'SIGKILL') {
      proc.signalCode = 'SIGKILL';
      proc.emit('exit', null, 'SIGKILL');
    }
  };
  await stopProcess(proc, { killAfterMs: 10 });
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);

  const polite = new EventEmitter();
  const politeSignals = [];
  polite.exitCode = null;
  polite.signalCode = null;
  polite.kill = (name) => {
    politeSignals.push(name);
    polite.exitCode = 0;
    polite.emit('exit', 0);
  };
  await stopProcess(polite, { killAfterMs: 10 });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(politeSignals, ['SIGTERM']);
});

test('a stopped tunnel’s proxy refuses traffic but still replays', async () => {
  const origin = http.createServer((req, res) => res.end('ok'));
  await new Promise((r) => origin.listen(0, '127.0.0.1', r));
  const store = dash.createSessionStore();
  let live = true;
  const inspector = createInspector({ store, isLive: () => live });
  try {
    const session = store.create(`http://127.0.0.1:${origin.address().port}`);
    const target = await inspector.open(session);
    assert.equal((await raw(target, { path: '/a' })).body, 'ok');
    const first = inspector.list(session.id).requests[0];
    live = false;
    const refused = await raw(target, { path: '/b' });
    assert.equal(refused.status, 503);
    assert.match(refused.body, /tunnel è fermo/);
    assert.equal(inspector.list(session.id).requests.length, 1);
    const replayed = await inspector.replay(session.id, first.seq);
    assert.equal(replayed.status, 200);
  } finally {
    await inspector.closeAll();
    await new Promise((r) => origin.close(r));
  }
});

test('the Windows command is safe in both cmd.exe and PowerShell', () => {
  const c = dash.buildQuickTunnelCommand('http://127.0.0.1:3000/x?a=1&b=$(calc)&c=`d`', { allowedMail: '*@x.it' });
  assert.equal(c.equivalentWindows, 'cloudflared tunnel --url "http://127.0.0.1:3000/x?a=1&b=%24(calc)&c=%60d%60" --allowed-mail "*@x.it"');
  assert.equal(c.equivalent, "cloudflared tunnel --url 'http://127.0.0.1:3000/x?a=1&b=$(calc)&c=`d`' --allowed-mail '*@x.it'");
  assert.equal(dash.buildQuickTunnelCommand('3000').equivalentWindows, 'cloudflared tunnel --url http://127.0.0.1:3000');
  for (const word of ['a&b', "it's", 'a|b', 'a^b', 'a"b', 'a$b', 'a`b']) {
    const quoted = dash.windowsWord(word);
    assert.match(quoted, /^"[^"$`]*"$/, word);
  }
  dash.platform = 'win32';
  assert.equal(dash.commandFor(c), c.equivalentWindows);
  dash.platform = 'linux';
  assert.equal(dash.commandFor(c), c.equivalent);
  delete dash.platform;
});
