import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadDashboard, dashboardRoot } from '../src/load-dashboard.js';
import { parseMetrics, createTrafficSampler } from '../src/traffic.js';

const dash = loadDashboard();
const metricsText = fs.readFileSync(path.join(dashboardRoot, 'test/fixtures/metrics.txt'), 'utf8');

function ok(text = metricsText) {
  return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(text) });
}

function running(store, port) {
  const session = store.create(String(port));
  store.appendChunk(session.id, `{"level":"info","message":"Starting metrics server on 127.0.0.1:${port}/metrics"}`);
  return session;
}

test('parseMetrics reads the four tunnel metrics', () => {
  const m = parseMetrics(metricsText);
  for (const key of ['inflight', 'total', 'errors', 'connections']) assert.equal(typeof m[key], 'number', key);
  assert.ok(m.total >= 5);
  assert.deepEqual(parseMetrics('a 1\n'), { inflight: null, total: null, errors: null, connections: null });
  const two = 'cloudflared_tunnel_ha_connections{conn_index="0"} 1\ncloudflared_tunnel_ha_connections{conn_index="1"} 1\n# HELP x\n';
  assert.equal(parseMetrics(two).connections, 2);
});

test('sampler records successes and marks failures stale', async () => {
  const store = dash.createSessionStore();
  const a = running(store, 3001);
  const b = running(store, 3002);
  let failB = false;
  const sampler = createTrafficSampler({
    store,
    fetchImpl: (url) => (url.includes(':3002') && failB ? Promise.reject(new Error('down')) : ok()),
  });
  await sampler.tick();
  assert.equal(a.traffic.ok, true);
  assert.equal(a.traffic.history.length, 1);
  assert.equal(b.traffic.ok, true);
  failB = true;
  await sampler.tick();
  assert.equal(b.traffic.ok, false);
  assert.equal(a.traffic.history.length, 2);
});

test('a hanging endpoint times out without blocking the others', async () => {
  const store = dash.createSessionStore();
  const slow = running(store, 3101);
  const fast = running(store, 3102);
  store.recordTraffic(slow.id, { inflight: 1, total: 1, errors: 0, connections: 1 });
  const sampler = createTrafficSampler({
    store,
    timeoutMs: 20,
    fetchImpl: (url, init) => (url.includes(':3101')
      ? new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))))
      : ok()),
  });
  await sampler.tick();
  assert.equal(slow.traffic.ok, false);
  assert.equal(fast.traffic.ok, true);
});

test('ticks do not overlap, stopped and removed sessions are skipped', async () => {
  const store = dash.createSessionStore();
  const live = running(store, 3201);
  const stopped = running(store, 3202);
  const removed = running(store, 3203);
  store.stop(stopped.id);
  const calls = [];
  let releaseRemoved;
  const sampler = createTrafficSampler({
    store,
    fetchImpl: (url) => {
      calls.push(url);
      if (url.includes(':3203')) return new Promise((resolve) => { releaseRemoved = () => resolve({ ok: true, status: 200, text: () => Promise.resolve(metricsText) }); });
      return ok();
    },
  });
  const first = sampler.tick();
  const second = sampler.tick();
  await new Promise((r) => setTimeout(r, 0));   // fetches start on a microtask
  store.remove(removed.id);
  releaseRemoved();
  await Promise.all([first, second]);
  assert.equal(calls.filter((u) => u.includes(':3201')).length, 1);
  assert.equal(calls.some((u) => u.includes(':3202')), false);
  assert.equal(store.get(removed.id), null);
  assert.equal(live.traffic.ok, true);
});

test('stop prevents further rounds', async () => {
  const store = dash.createSessionStore();
  running(store, 3301);
  let count = 0;
  const sampler = createTrafficSampler({ store, intervalMs: 5, fetchImpl: () => { count += 1; return ok(); } });
  sampler.start();
  await new Promise((r) => setTimeout(r, 30));
  sampler.stop();
  const seen = count;
  assert.ok(seen >= 1);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(count, seen);
});
