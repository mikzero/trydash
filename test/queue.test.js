import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { loadDashboard } from '../src/load-dashboard.js';
import { createInspector } from '../src/inspector.js';
import { createApp } from '../server.js';

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

// A webhook receiver that can be stopped and started again on the same port.
function receiver() {
  const got = [];
  let server = null;
  let port = 0;
  const handler = (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      got.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"received":true}');
    });
  };
  return {
    got,
    get port() { return port; },
    async start() {
      server = http.createServer(handler);
      await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
      port = server.address().port;
    },
    async stop() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function until(check, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out');
}

test('with the queue on, a webhook that finds the server down gets 202 and is delivered when it is back', async () => {
  const hook = receiver();
  await hook.start();
  const store = dash.createSessionStore();
  const inspector = createInspector({ store });
  const session = store.create(`http://127.0.0.1:${hook.port}`, { queue: true });
  assert.equal(store.get(session.id).options.queue, true);
  assert.equal(store.get(session.id).options.inspect, true);
  const target = await inspector.open(session);
  try {
    await hook.stop();
    const payload = JSON.stringify({ type: 'payment_intent.succeeded', id: 'evt_1' });
    const sent = await request(target, {
      method: 'POST',
      path: '/webhooks/stripe?x=1',
      headers: { 'Content-Type': 'application/json', 'Stripe-Signature': 't=1,v1=abc', 'Content-Length': Buffer.byteLength(payload) },
      body: payload,
    });
    assert.equal(sent.status, 202);
    assert.equal(JSON.parse(sent.body).queued, true);
    assert.equal(sent.headers['x-trydash-queued'], '1');
    assert.equal(inspector.info(session.id).queued, 1);
    const first = inspector.list(session.id).requests[0];
    assert.deepEqual([first.status, first.queued], [202, 'waiting']);
    assert.match(store.get(session.id).lastOriginError.message, /request #1 queued/);

    // A page view is not queued: the visitor gets the usual 502.
    assert.equal((await request(target, { path: '/' })).status, 502);
    assert.equal(inspector.info(session.id).queued, 1);

    await hook.start();
    await until(() => hook.got.length === 1);
    const delivered = hook.got[0];
    assert.equal(delivered.method, 'POST');
    assert.equal(delivered.url, '/webhooks/stripe?x=1');
    assert.equal(delivered.body, payload, 'the body arrives byte for byte, so signatures still match');
    assert.equal(delivered.headers['stripe-signature'], 't=1,v1=abc');
    await until(() => inspector.info(session.id).queued === 0);
    const list = inspector.list(session.id).requests;
    const original = list.find((r) => r.seq === 1);
    const delivery = list.find((r) => r.delivery);
    assert.equal(original.queued, 'delivered');
    assert.equal(original.deliveredAs, delivery.seq);
    assert.deepEqual([delivery.replayOf, delivery.status], [1, 200]);
    assert.equal(store.get(session.id).lastOriginError, null, 'the server answered: no "not responding" banner');
  } finally {
    await inspector.closeAll();
    await hook.stop().catch(() => {});
  }
});

test('without the queue, or with a body too large to keep, the sender gets 502 as before', async () => {
  const hook = receiver();
  await hook.start();
  await hook.stop();
  const store = dash.createSessionStore();
  const inspector = createInspector({ store, requestBodyCap: 16 });
  try {
    const off = store.create(`http://127.0.0.1:${hook.port}`, {});
    const offTarget = await inspector.open(off);
    assert.equal((await request(offTarget, { method: 'POST', path: '/hook', body: '{}' })).status, 502);
    const on = store.create(`http://127.0.0.1:${hook.port}`, { queue: true });
    const onTarget = await inspector.open(on);
    assert.equal((await request(onTarget, { method: 'POST', path: '/hook', body: 'x'.repeat(64) })).status, 502, 'cut body: cannot be delivered later');
    assert.equal((await request(onTarget, { method: 'POST', path: '/hook', body: 'small' })).status, 202);
    assert.equal(inspector.info(on.id).queued, 1);
    // Delivering now while the server is still down keeps it waiting; dropping clears it.
    assert.deepEqual(await inspector.deliverQueue(on.id), { delivered: 0, left: 1 });
    assert.deepEqual(inspector.dropQueue(on.id), { dropped: 1 });
    assert.equal(inspector.list(on.id).requests.find((r) => r.queued).queued, 'dropped');
  } finally {
    await inspector.closeAll();
  }
});

test('queue API: info in the state, deliver now, drop', async () => {
  const hook = receiver();
  await hook.start();
  const app = createApp({ probe: async () => ({ present: true, version: 'test' }), spawn: null });
  await app.listen(0, '127.0.0.1');
  const call = async (method, p, body) => {
    const res = await fetch(`${app.url}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  try {
    const session = app.store.create(`http://127.0.0.1:${hook.port}`, { queue: true });
    const target = await app.inspector.open(session);
    await hook.stop();
    assert.equal((await request(target, { method: 'POST', path: '/hook', body: 'a' })).status, 202);
    const state = (await call('GET', '/api/state')).json;
    assert.equal(state.sessions.find((s) => s.id === session.id).inspect.queued, 1);
    await hook.start();
    const now = await call('POST', `/api/sessions/${session.id}/queue/deliver`);
    assert.deepEqual(now.json, { delivered: 1, left: 0 });
    assert.equal(hook.got.length, 1);
    assert.equal((await call('DELETE', `/api/sessions/${session.id}/queue`)).json.dropped, 0);
    assert.equal((await call('GET', `/api/sessions/${session.id}/queue`)).status, 405);
    // Turned on and off on a running tunnel, like the preview options.
    const off = await call('PATCH', `/api/sessions/${session.id}/options`, { queue: false });
    assert.equal(off.json.session.options.queue, false);
  } finally {
    await app.close();
    await hook.stop().catch(() => {});
  }
});
