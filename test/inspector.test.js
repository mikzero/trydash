import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { loadDashboard } from '../src/load-dashboard.js';
import { createInspector, describeBody, forwardHeaders } from '../src/inspector.js';
import { createApp } from '../server.js';

const dash = loadDashboard();

async function startOrigin(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      handler(req, res, seen[seen.length - 1]);
    });
  });
  // Upgraded sockets leave the server's books, so they are tracked here.
  const sockets = new Set();
  server.on('connection', (socket) => sockets.add(socket));
  server.on('upgrade', (req, socket) => sockets.add(socket));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    seen,
    server,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}

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

async function until(check, tries = 100) {
  for (let i = 0; i < tries; i += 1) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out');
}

function sessionFor(store, origin, options) {
  return store.create(origin, options);
}

test('the proxy forwards requests unchanged and records both sides', async () => {
  const origin = await startOrigin((req, res, seen) => {
    res.writeHead(201, { 'Content-Type': 'application/json', 'X-Origin': 'yes' });
    res.end(JSON.stringify({ got: seen.body }));
  });
  const store = dash.createSessionStore();
  const inspector = createInspector({ store });
  try {
    const session = sessionFor(store, `${origin.url}/app?x=1`);
    const target = await inspector.open(session);
    assert.match(target, /^http:\/\/127\.0\.0\.1:\d+\/app\?x=1$/);
    assert.notEqual(new URL(target).port, new URL(origin.url).port);

    const res = await request(target, {
      method: 'POST',
      path: '/app/hook?y=2',
      headers: { Host: 'aqua-wolf-1234.trycloudflare.com', 'Content-Type': 'application/json', 'Cf-Connecting-Ip': '203.0.113.7', 'X-Trydash-Replay': 'forged:1:a' },
      body: '{"event":"paid"}',
    });
    assert.equal(res.status, 201);
    assert.equal(res.headers['x-origin'], 'yes');
    assert.equal(res.body, '{"got":"{\\"event\\":\\"paid\\"}"}');

    const seen = origin.seen[0];
    assert.equal(seen.method, 'POST');
    assert.equal(seen.url, '/app/hook?y=2');
    assert.equal(seen.headers.host, 'aqua-wolf-1234.trycloudflare.com');
    assert.equal(seen.headers['cf-connecting-ip'], '203.0.113.7');
    assert.equal('x-trydash-replay' in seen.headers, false);

    const list = await until(() => {
      const current = inspector.list(session.id);
      return current.requests[0] && current.requests[0].state === 'done' ? current : null;
    });
    assert.equal(list.total, 1);
    const row = list.requests[0];
    assert.equal(row.method, 'POST');
    assert.equal(row.path, '/app/hook?y=2');
    assert.equal(row.status, 201);
    assert.equal(row.replayOf, null);
    assert.equal(row.requestSize, 16);
    assert.equal(row.contentType, 'application/json');
    assert.ok(row.durationMs >= 0);

    const detail = inspector.get(session.id, row.seq);
    assert.equal(detail.remote, '203.0.113.7');
    assert.equal(detail.requestBody.text, '{"event":"paid"}');
    assert.equal(detail.responseBody.text, res.body);
    assert.equal(detail.replayable, true);
    assert.ok(detail.requestHeaders.some(([k, v]) => k === 'Content-Type' && v === 'application/json'));
    assert.equal(detail.requestHeaders.some(([k]) => k.toLowerCase() === 'x-trydash-replay'), false);
    assert.ok(detail.responseHeaders.some(([k, v]) => k.toLowerCase() === 'x-origin' && v === 'yes'));
  } finally {
    await inspector.closeAll();
    await origin.close();
  }
});

test('a replay sends the same request again and points back to the original', async () => {
  const origin = await startOrigin((req, res) => res.end('ok'));
  const store = dash.createSessionStore();
  const inspector = createInspector({ store });
  try {
    const session = sessionFor(store, origin.url);
    const target = await inspector.open(session);
    await request(target, { method: 'PUT', path: '/item/7', headers: { 'Content-Type': 'text/plain', 'X-Sig': 'abc' }, body: 'hello' });
    const first = await until(() => inspector.list(session.id).requests.find((r) => r.state === 'done'));

    const replayed = await inspector.replay(session.id, first.seq);
    assert.equal(replayed.replayOf, first.seq);
    assert.equal(replayed.method, 'PUT');
    assert.equal(replayed.path, '/item/7');
    assert.equal(origin.seen.length, 2);
    assert.equal(origin.seen[1].body, 'hello');
    assert.equal(origin.seen[1].headers['x-sig'], 'abc');
    assert.equal('x-trydash-replay' in origin.seen[1].headers, false);
    assert.equal(inspector.list(session.id).requests[0].replayOf, first.seq);
    const again = inspector.get(session.id, replayed.seq);
    assert.ok(again.requestHeaders.some(([k, v]) => k === 'X-Sig' && v === 'abc'));

    await assert.rejects(inspector.replay(session.id, 999), (e) => e.key === 'inspect.requestNotFound');
  } finally {
    await inspector.closeAll();
    await origin.close();
  }
});

test('large bodies are cut and cannot be replayed; only the latest requests stay', async () => {
  const origin = await startOrigin((req, res) => res.end('x'.repeat(50)));
  const store = dash.createSessionStore();
  const inspector = createInspector({ store, keep: 3, requestBodyCap: 8, responseBodyCap: 10 });
  try {
    const session = sessionFor(store, origin.url);
    const target = await inspector.open(session);
    const res = await request(target, { method: 'POST', body: '0123456789abcdef' });
    assert.equal(res.body.length, 50);
    assert.equal(origin.seen[0].body, '0123456789abcdef');
    const row = await until(() => inspector.list(session.id).requests.find((r) => r.state === 'done'));
    assert.equal(row.requestSize, 16);
    assert.equal(row.responseSize, 50);
    const detail = inspector.get(session.id, row.seq);
    assert.equal(detail.requestBody.truncated, true);
    assert.equal(detail.requestBody.text, '01234567');
    assert.equal(detail.responseBody.text, 'x'.repeat(10));
    assert.equal(detail.replayable, false);
    await assert.rejects(inspector.replay(session.id, row.seq), (e) => e.key === 'inspect.replayTruncated');

    for (let i = 0; i < 4; i += 1) await request(target, { path: `/n${i}` });
    const list = inspector.list(session.id);
    assert.equal(list.requests.length, 3);
    assert.equal(list.total, 5);
    assert.deepEqual(list.requests.map((r) => r.path), ['/n3', '/n2', '/n1']);

    const before = list.version;
    inspector.clear(session.id);
    assert.equal(inspector.list(session.id).requests.length, 0);
    assert.ok(inspector.list(session.id).version > before);
  } finally {
    await inspector.closeAll();
    await origin.close();
  }
});

test('an origin that does not answer gets a 502, a log line and the warning', async () => {
  const store = dash.createSessionStore();
  const inspector = createInspector({ store });
  const closed = await startOrigin(() => {});
  const deadUrl = closed.url;
  await closed.close();
  try {
    const session = sessionFor(store, deadUrl);
    const target = await inspector.open(session);
    const res = await request(target, { path: '/x' });
    assert.equal(res.status, 502);
    assert.match(res.body, /is not responding/);
    const row = await until(() => inspector.list(session.id).requests.find((r) => r.state === 'error'));
    assert.equal(row.status, 502);
    assert.equal(row.error, 'ECONNREFUSED');
    assert.ok(session.lastOriginError);
    assert.match(session.lastOriginError.message, /Unable to reach the origin/);
    assert.equal(session.entries.at(-1).level, 'error');
  } finally {
    await inspector.closeAll();
  }
});

test('WebSocket upgrades pass through and show as one entry', async () => {
  const origin = await startOrigin((req, res) => res.end('plain'));
  origin.server.on('upgrade', (req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.on('data', (d) => socket.write('echo:' + d));
  });
  const store = dash.createSessionStore();
  const inspector = createInspector({ store });
  try {
    const session = sessionFor(store, origin.url);
    const target = new URL(await inspector.open(session));
    const reply = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: target.hostname, port: target.port, path: '/hmr', headers: { Connection: 'Upgrade', Upgrade: 'websocket' } });
      req.on('upgrade', (res, socket) => {
        socket.on('data', (d) => { resolve({ status: res.statusCode, data: String(d) }); socket.destroy(); });
        socket.write('ping');
      });
      req.on('error', reject);
      req.end();
    });
    assert.deepEqual(reply, { status: 101, data: 'echo:ping' });
    const row = await until(() => inspector.list(session.id).requests.find((r) => r.state === 'done'));
    assert.equal(row.websocket, true);
    assert.equal(row.status, 101);
    assert.equal(row.path, '/hmr');
    await assert.rejects(inspector.replay(session.id, row.seq), (e) => e.key === 'inspect.replayWebsocket');
  } finally {
    await inspector.closeAll();
    await origin.close();
  }
});

test('bodies: compressed text is decoded, binary stays binary', () => {
  const body = (buffer) => ({ chunks: [buffer], size: buffer.length, kept: buffer.length });
  const gz = describeBody(body(zlib.gzipSync('{"a":1}')), [['Content-Type', 'application/json'], ['Content-Encoding', 'gzip']]);
  assert.equal(gz.text, '{"a":1}');
  assert.equal(gz.decoded, 'gzip');
  const png = describeBody(body(Buffer.from([0x89, 0x50, 0x4e, 0x47])), [['Content-Type', 'image/png']]);
  assert.equal(png.binary, true);
  assert.equal(png.text, null);
  const unknown = describeBody(body(Buffer.from([0, 1, 2, 255])), []);
  assert.equal(unknown.binary, true);
  const plain = describeBody(body(Buffer.from('ciao è')), []);
  assert.equal(plain.text, 'ciao è');
  const cut = describeBody({ chunks: [zlib.gzipSync('x').subarray(0, 5)], size: 30, kept: 5 }, [['Content-Encoding', 'gzip']]);
  assert.equal(cut.binary, true);
  assert.equal(cut.truncated, true);

  const fwd = forwardHeaders({ host: 'a', connection: 'keep-alive, x-drop', 'x-drop': '1', 'keep-alive': 't', 'transfer-encoding': 'chunked', 'x-keep': '2', 'x-trydash-replay': 'z' });
  assert.deepEqual(fwd, { host: 'a', 'x-keep': '2' });
});

function quietProcess() {
  const proc = new EventEmitter();
  proc.stdout = Readable.from([Buffer.from('{"level":"info","message":"|  https://aqua-wolf-1234.trycloudflare.com |"}\n')]);
  proc.stderr = Readable.from([]);
  proc.pid = 0;
  proc.kill = () => {};
  return proc;
}

test('HTTP API: tunnels go through the inspector unless it cannot or should not', async () => {
  const origin = await startOrigin((req, res) => res.end('hi'));
  const spawned = [];
  const app = createApp({
    probe: async () => ({ present: true, version: 'test' }),
    spawn(bin, args) {
      spawned.push(args);
      return quietProcess();
    },
  });
  await app.listen(0, '127.0.0.1');
  const post = (path, body, method = 'POST') => fetch(`${app.url}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  try {
    const created = await (await post('/api/sessions', { origin: origin.url })).json();
    const id = created.session.id;
    assert.equal(created.session.equivalent, `cloudflared tunnel --url ${origin.url}`);
    assert.equal(created.session.options.inspect, true);
    assert.equal(created.session.inspect.enabled, true);
    const target = spawned[0][spawned[0].indexOf('--url') + 1];
    assert.notEqual(target, origin.url);
    assert.match(target, /^http:\/\/127\.0\.0\.1:\d+$/);

    await request(target, { method: 'POST', path: '/hook', headers: { 'Content-Type': 'application/json' }, body: '{"n":1}' });
    let rows;
    for (let i = 0; i < 50; i += 1) {
      rows = await (await fetch(`${app.url}/api/sessions/${id}/requests`)).json();
      if (rows.requests[0] && rows.requests[0].state === 'done') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(rows.requests[0].path, '/hook');
    const same = await (await fetch(`${app.url}/api/sessions/${id}/requests?version=${rows.version}`)).json();
    assert.deepEqual(same, { version: rows.version, unchanged: true });

    const state = await (await fetch(`${app.url}/api/state`)).json();
    assert.equal(state.sessions[0].inspect.count, 1);

    const detail = await (await fetch(`${app.url}/api/sessions/${id}/requests/${rows.requests[0].seq}`)).json();
    assert.equal(detail.request.requestBody.text, '{"n":1}');
    assert.equal((await fetch(`${app.url}/api/sessions/${id}/requests/99`)).status, 404);

    const replay = await post(`/api/sessions/${id}/requests/${rows.requests[0].seq}/replay`);
    assert.equal(replay.status, 201);
    assert.equal((await replay.json()).request.replayOf, rows.requests[0].seq);
    assert.equal(origin.seen.length, 2);
    const editedReplay = await post(`/api/sessions/${id}/requests/${rows.requests[0].seq}/replay`, { body: '{"n":2}' });
    assert.equal(editedReplay.status, 201);
    assert.equal((await editedReplay.json()).request.edited, true);
    assert.equal(origin.seen.at(-1).body, '{"n":2}');
    const badEdit = await post(`/api/sessions/${id}/requests/${rows.requests[0].seq}/replay`, { path: 'x' });
    assert.equal(badEdit.status, 400);
    assert.equal((await badEdit.json()).key, 'inspect.replayInvalid');

    const crossSite = await fetch(`${app.url}/api/sessions/${id}/requests/${rows.requests[0].seq}/replay`, { method: 'POST', headers: { Origin: 'https://evil.example' } });
    assert.equal(crossSite.status, 403);

    assert.equal((await post(`/api/sessions/${id}/requests`, null, 'DELETE')).status, 200);
    assert.equal((await (await fetch(`${app.url}/api/sessions/${id}/requests`)).json()).requests.length, 0);

    await post(`/api/sessions/${id}/stop`);
    await post(`/api/sessions/${id}/restart`);
    assert.equal(spawned[1][spawned[1].indexOf('--url') + 1], target);

    const hello = await (await post('/api/sessions', { options: { mode: 'hello' } })).json();
    assert.deepEqual(hello.session.inspect, { enabled: false, reason: 'hello' });
    const helloRows = await fetch(`${app.url}/api/sessions/${hello.session.id}/requests`);
    assert.equal(helloRows.status, 409);
    assert.equal((await helloRows.json()).key, 'inspect.disabled');

    const off = await (await post('/api/sessions', { origin: origin.url, options: { inspect: false } })).json();
    assert.deepEqual(off.session.inspect, { enabled: false, reason: 'off' });
    assert.equal(spawned[3][spawned[3].indexOf('--url') + 1], origin.url);

    const h2 = await (await post('/api/sessions', { origin: origin.url, options: { http2Origin: true } })).json();
    assert.deepEqual(h2.session.inspect, { enabled: false, reason: 'http2' });
    assert.equal(spawned[4][spawned[4].indexOf('--url') + 1], origin.url);

    await post(`/api/sessions/${id}`, null, 'DELETE');
    assert.equal(app.inspector.has(id), false);
  } finally {
    await app.close();
    await origin.close();
  }
});

test('an edited replay sends the changes, and nothing can split the request', async () => {
  const origin = await startOrigin((req, res) => res.end('ok'));
  const store = dash.createSessionStore();
  const inspector = createInspector({ store, requestBodyCap: 64 });
  try {
    const session = sessionFor(store, origin.url);
    const target = await inspector.open(session);
    await request(target, { method: 'POST', path: '/hook', headers: { 'Content-Type': 'application/json', 'X-Sig': 'old' }, body: '{"a":1}' });
    const first = await until(() => inspector.list(session.id).requests.find((r) => r.state === 'done'));

    const edited = await inspector.replay(session.id, first.seq, {
      method: 'PUT',
      path: '/hook?try=2',
      headers: [['Content-Type', 'text/plain'], ['X-Sig', 'new'], ['Content-Length', '999'], ['Connection', 'close']],
      body: 'changed body',
    });
    assert.equal(edited.replayOf, first.seq);
    assert.equal(edited.edited, true);
    const seen = origin.seen.at(-1);
    assert.equal(seen.method, 'PUT');
    assert.equal(seen.url, '/hook?try=2');
    assert.equal(seen.body, 'changed body');
    assert.equal(seen.headers['x-sig'], 'new');
    assert.equal(seen.headers['content-length'], '12');
    assert.equal(inspector.list(session.id).requests.find((r) => r.seq === first.seq).edited, false);

    for (const bad of [
      { method: 'GET /x HTTP/1.1' },
      { path: 'no-slash' },
      { path: '/a b' },
      { path: '/a\r\nX-Evil: 1' },
      { headers: [['X-Evil\r\nHost', 'x']] },
      { headers: [['X-A', 'ok\r\nX-Evil: 1']] },
      { headers: [['X-A']] },
      { headers: 'X-A: 1' },
      { body: 'x'.repeat(65) },
    ]) {
      await assert.rejects(inspector.replay(session.id, first.seq, bad), (e) => e.key === 'inspect.replayInvalid', JSON.stringify(bad));
    }

    // A body too large to keep can still go again once a new one is written.
    await request(target, { method: 'POST', path: '/big', body: 'y'.repeat(200) });
    const big = await until(() => inspector.list(session.id).requests.find((r) => r.path === '/big' && r.state === 'done'));
    await assert.rejects(inspector.replay(session.id, big.seq), (e) => e.key === 'inspect.replayTruncated');
    const rewritten = await inspector.replay(session.id, big.seq, { body: 'small' });
    assert.equal(rewritten.status, 200);
    assert.equal(origin.seen.at(-1).body, 'small');
  } finally {
    await inspector.closeAll();
    await origin.close();
  }
});
