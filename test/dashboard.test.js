import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { loadDashboard, dashboardRoot } from '../src/load-dashboard.js';
import { bindProcess, openQuickTunnel, stopProcess } from '../src/runtime.js';
import { createApp, appVersion } from '../server.js';

const dash = loadDashboard();
const fixturePath = path.join(dashboardRoot, 'test/fixtures/quick-tunnel.log');
const fixture = fs.readFileSync(fixturePath, 'utf8');

function fixtureProcess(stdoutText, stderrText = '') {
  const proc = new EventEmitter();
  proc.stdout = Readable.from([Buffer.from(stdoutText)]);
  proc.stderr = Readable.from([Buffer.from(stderrText)]);
  proc.pid = 0;
  proc.killed = false;
  proc.kill = () => { proc.killed = true; };
  return proc;
}

test('plain text and JSON lines keep level, message, timestamp, and the trycloudflare URL', () => {
  const text = '2026-09-22T11:26:24Z INF |  https://aqua-wolf-1234.trycloudflare.com |';
  const textEntry = dash.parseLogLine(text);
  assert.equal(textEntry.level, 'info');
  assert.equal(textEntry.message, '|  https://aqua-wolf-1234.trycloudflare.com |');
  assert.equal(textEntry.timestamp, '2026-09-22T11:26:24Z');
  assert.equal(textEntry.url, 'https://aqua-wolf-1234.trycloudflare.com');

  const bare = dash.parseLogLine('INF bare line without a timestamp');
  assert.equal(bare.level, 'info');
  assert.equal(bare.message, 'bare line without a timestamp');
  assert.equal(bare.timestamp, null);
  assert.equal(bare.url, null);

  const json = dash.parseLogLine('{"level":"info","time":"2026-09-22T11:26:26Z","message":"retrying connection"}');
  assert.equal(json.level, 'info');
  assert.equal(json.message, 'retrying connection');
  assert.equal(json.timestamp, '2026-09-22T11:26:26Z');

  const jsonNoTime = dash.parseLogLine('{"level":"error","message":"control stream failed without a timestamp"}');
  assert.equal(jsonNoTime.level, 'error');
  assert.equal(jsonNoTime.message, 'control stream failed without a timestamp');
  assert.equal(jsonNoTime.timestamp, null);

  const jsonUrl = dash.parseLogLine('{"level":"info","time":"2026-09-22T11:26:50Z","message":"|  https://perfect-connecticut-armor-wooden.trycloudflare.com                                |"}');
  assert.equal(jsonUrl.url, 'https://perfect-connecticut-armor-wooden.trycloudflare.com');
  assert.equal(jsonUrl.level, 'info');
  assert.equal(jsonUrl.timestamp, '2026-09-22T11:26:50Z');

  const warn = dash.parseLogLine('{"error":"Group ID 1000 is not between ping group 1 to 0","level":"warn","message":"ICMP proxy feature is disabled","time":"2026-09-22T11:26:51Z"}');
  assert.equal(warn.level, 'warn');
  assert.equal(warn.message, 'ICMP proxy feature is disabled');
  assert.equal(warn.timestamp, '2026-09-22T11:26:51Z');

  const entries = dash.parseLogStream(fixture);
  const firstUrl = entries.find((entry) => entry.url);
  assert.equal(firstUrl.url, 'https://aqua-wolf-1234.trycloudflare.com');
  const noTimestamp = entries.find((entry) => entry.message === 'control stream failed without a timestamp');
  assert.equal(noTimestamp.timestamp, null);
  assert.equal(noTimestamp.level, 'error');
});

test('missing probe is install-only and a present probe is the workspace', () => {
  const missing = dash.viewForProbe({ present: false, platform: 'linux', arch: 'x64' });
  assert.equal(missing.phase, 'install');
  assert.equal(missing.workspace, null);
  assert.equal(missing.install.missing, 'cloudflared');
  assert.ok(missing.install.summary.length > 0);
  assert.ok(missing.install.steps.length >= 2);
  assert.ok(missing.install.steps.some((step) => step.command.includes('cloudflared')));
  assert.ok(missing.actions.includes('recheck'));
  for (const action of dash.WORKSPACE_ACTIONS) {
    assert.equal(missing.actions.includes(action), false);
  }

  const present = dash.viewForProbe({ present: true, version: 'cloudflared version 2026.10.0', platform: 'linux' });
  assert.equal(present.phase, 'workspace');
  assert.equal(present.install, null);
  assert.equal(present.workspace.version, 'cloudflared version 2026.10.0');
  for (const action of dash.INSTALL_ACTIONS) {
    assert.equal(present.actions.includes(action), false);
  }
  for (const action of dash.WORKSPACE_ACTIONS) {
    assert.equal(present.actions.includes(action), true);
  }
});

test('create records a quick-tunnel command and a process stream feeds the normalizer', async () => {
  const origin = 'http://127.0.0.1:4321';
  const store = dash.createSessionStore();
  let captured = null;
  const opened = openQuickTunnel(store, origin, (bin, args) => {
    captured = { bin, args };
    return fixtureProcess(fixture);
  });

  assert.equal(opened.session.invocation.bin, 'cloudflared');
  assert.equal(opened.session.invocation.args[0], 'tunnel');
  assert.equal(opened.session.invocation.args[1], '--url');
  assert.equal(opened.session.invocation.args[2], origin);
  assert.equal(opened.session.invocation.equivalent, `cloudflared tunnel --url ${origin}`);
  assert.equal(captured.bin, 'cloudflared');
  assert.equal(captured.args[0], 'tunnel');
  assert.equal(captured.args[1], '--url');
  assert.equal(captured.args[2], origin);
  assert.equal(captured.args.includes('login'), false);
  assert.equal(captured.args.includes('create'), false);
  assert.equal(captured.args.includes('route'), false);
  assert.equal(captured.args.includes('run'), false);

  const session = await opened.done;
  assert.equal(session.url, 'https://aqua-wolf-1234.trycloudflare.com');
  assert.equal(session.entries[0].level, 'info');
  assert.equal(session.entries[0].message, 'Requesting new quick Tunnel on trycloudflare.com...');
  assert.equal(session.entries[0].timestamp, '2026-09-22T11:26:20Z');
  const bare = session.entries.find((entry) => entry.message === 'bare line without a timestamp');
  assert.equal(bare.timestamp, null);

  store.select(session.id, 1);
  const detail = store.detail(session.id);
  assert.equal(detail, session.entries[1]);
  assert.equal(detail.url, 'https://aqua-wolf-1234.trycloudflare.com');
  assert.equal(session.entries.length > 1, true);

  store.stop(session.id);
  assert.equal(store.listActive().some((item) => item.id === session.id), false);

  const other = store.create('9090');
  assert.equal(other.origin, 'http://127.0.0.1:9090');
  assert.equal(other.invocation.equivalent, 'cloudflared tunnel --url http://127.0.0.1:9090');
  store.remove(other.id);
  assert.equal(store.get(other.id), null);
  assert.equal(store.listActive().some((item) => item.id === other.id), false);
});

test('split process chunks are normalized into one entry', async () => {
  const store = dash.createSessionStore();
  const session = store.create('http://127.0.0.1:8080');
  const proc = new EventEmitter();
  proc.stdout = Readable.from([
    Buffer.from('2024-06-01T00:00:01Z INF hel'),
    Buffer.from('lo https://split-chunk.trycloudflare.com\n'),
  ]);
  proc.stderr = Readable.from([]);
  const after = await bindProcess(store, session.id, proc);
  assert.equal(after.entries.length, 1);
  assert.equal(after.entries[0].level, 'info');
  assert.equal(after.entries[0].message, 'hello https://split-chunk.trycloudflare.com');
  assert.equal(after.entries[0].timestamp, '2024-06-01T00:00:01Z');
  assert.equal(after.url, 'https://split-chunk.trycloudflare.com');
});

test('a multi-thousand-line window is capped and the offset resolves that entry', () => {
  const lines = [];
  for (let i = 0; i < 4000; i += 1) lines.push(`2024-01-01T00:00:01Z INF row-${i}`);
  const store = dash.createSessionStore();
  const session = store.create('http://127.0.0.1:8080');
  store.appendChunk(session.id, lines.join('\n'));
  const saved = store.get(session.id).entries;
  assert.equal(saved.length, 4000);

  const offset = 3210;
  const win = dash.logWindow(saved, { offset, limit: 99999 });
  assert.ok(win.entries.length <= dash.LOG_WINDOW_CAP);
  assert.equal(win.entries.length, dash.LOG_WINDOW_CAP);
  assert.equal(win.entries[0], saved[offset]);
  assert.equal(win.entries[0].message, `row-${offset}`);

  const resolved = dash.resolveWindowEntry(saved, offset);
  assert.equal(resolved.detail, saved[offset]);
  store.select(session.id, offset);
  assert.equal(store.detail(session.id), saved[offset]);
  assert.equal(store.detail(session.id).message, saved[offset].message);
  assert.equal(store.detail(session.id).level, saved[offset].level);
  assert.equal(store.detail(session.id).timestamp, saved[offset].timestamp);
});

test('bad origins are rejected before a tunnel command exists', () => {
  assert.throws(() => dash.buildQuickTunnelCommand(''), /origine/i);
  assert.throws(() => dash.buildQuickTunnelCommand('ftp://127.0.0.1/file'), /http/i);
  const command = dash.buildQuickTunnelCommand('http://localhost:3000/');
  assert.equal(command.origin, 'http://localhost:3000');
  assert.equal(command.equivalent, 'cloudflared tunnel --url http://localhost:3000');
});

test('HTTP create uses the quick-tunnel spawn, detail, stop, and the log window', async () => {
  const seen = [];
  const app = createApp({
    probe: async () => ({ present: true, version: 'cloudflared version test' }),
    spawn(bin, args) {
      seen.push({ bin, args });
      return fixtureProcess(fixture);
    },
  });
  await app.listen(0, '127.0.0.1');
  try {
    const denied = createApp({
      probe: async () => ({ present: false, platform: 'linux' }),
      spawn() { throw new Error('spawn should not run'); },
    });
    await denied.listen(0, '127.0.0.1');
    try {
      const blocked = await fetch(`${denied.url}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ origin: 'http://127.0.0.1:8080' }),
      });
      assert.equal(blocked.status, 409);
      const blockedBody = await blocked.json();
      assert.equal(blockedBody.phase, 'install');
      const blockedState = await (await fetch(`${denied.url}/api/state`)).json();
      assert.equal(blockedState.probe.present, false);
      assert.equal(blockedState.sessions.length, 0);
    } finally {
      await denied.close();
    }

    const bad = await fetch(`${app.url}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin: '' }),
    });
    assert.equal(bad.status, 400);

    const created = await fetch(`${app.url}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin: 'http://127.0.0.1:8080' }),
    });
    assert.equal(created.status, 201);
    const body = await created.json();
    assert.equal(body.session.equivalent, 'cloudflared tunnel --url http://127.0.0.1:8080');
    assert.equal(seen[0].bin, 'cloudflared');
    assert.equal(seen[0].args[0], 'tunnel');
    assert.equal(seen[0].args[1], '--url');
    assert.equal(seen[0].args[2], 'http://127.0.0.1:8080');

    let url = null;
    for (let i = 0; i < 50; i += 1) {
      const state = await (await fetch(`${app.url}/api/state`)).json();
      url = state.sessions[0] && state.sessions[0].url;
      if (url) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(url, 'https://aqua-wolf-1234.trycloudflare.com');

    const logs = await (await fetch(`${app.url}/api/sessions/${body.session.id}/logs?offset=1&limit=5000`)).json();
    assert.ok(logs.entries.length <= dash.LOG_WINDOW_CAP);
    assert.equal(logs.entries[0].url, 'https://aqua-wolf-1234.trycloudflare.com');
    const detail = await (await fetch(`${app.url}/api/sessions/${body.session.id}/entries/1`)).json();
    assert.deepEqual(detail.detail, logs.entries[0]);

    const stopped = await fetch(`${app.url}/api/sessions/${body.session.id}/stop`, { method: 'POST' });
    assert.equal(stopped.status, 200);
    const after = await (await fetch(`${app.url}/api/state`)).json();
    const stoppedRow = after.sessions.find((session) => session.id === body.session.id);
    assert.equal(stoppedRow.status, 'stopped');
    assert.ok(stoppedRow.counts.error >= 1);
  } finally {
    await app.close();
  }
});

test('filters, virtual range and page cache', async () => {
  assert.equal(dash.levelGroup('fatal'), 'error');
  assert.equal(dash.levelGroup('trace'), 'debug');
  assert.equal(dash.levelGroup('warn'), 'warn');
  const entries = dash.parseLogStream(fixture);
  assert.deepEqual([...dash.filterEntries(entries, { levels: ['error'] }).map((e) => e.index)], [4]);
  assert.equal(dash.filterEntries(entries, { q: 'RETRYING' })[0].index, 3);
  assert.equal(dash.filterEntries(entries, { q: 'Group ID 1000' }).length, 1);
  assert.equal(dash.filterEntries(entries, { levels: ['info', 'warn'], q: 'icmp' }).length, 1);
  assert.equal(dash.filterEntries(entries, { q: '(x' }).length, 0);
  assert.equal(dash.filterEntries(entries, {}).length, entries.length);

  assert.deepEqual({ ...dash.visibleRange(0, 280, 28, 0, 30) }, { start: 0, end: 0 });
  assert.deepEqual({ ...dash.visibleRange(0, 280, 28, 50, 30) }, { start: 0, end: 40 });
  assert.deepEqual({ ...dash.visibleRange(28 * 990, 280, 28, 1000, 30) }, { start: 960, end: 1000 });
  assert.deepEqual([...dash.pagesFor({ start: 0, end: 0 }, 200)], []);
  assert.deepEqual([...dash.pagesFor({ start: 150, end: 450 }, 200)], [0, 1, 2]);
  assert.equal(dash.ROW_H, 28);

  const calls = [];
  let release;
  const cache = dash.createPageCache((key, page) => {
    calls.push([key, page]);
    if (key === 'A') return new Promise((resolve) => { release = resolve; });
    return Promise.resolve({ total: 3, entries: [{ index: 7 }, { index: 8 }, { index: 9 }] });
  });
  cache.reset('A');
  const pending = cache.ensure([0]);
  cache.ensure([0]);
  assert.equal(calls.length, 1);
  cache.reset('B');
  await cache.ensure([0]);
  release({ total: 99, entries: [{ index: 1 }] });
  await pending;
  assert.equal(cache.total, 3);
  assert.equal(cache.entryAt(0).index, 7);
  assert.equal(cache.entryAt(3), undefined);
});

test('session lifecycle: starting, running, stopped, exited, restart', () => {
  const store = dash.createSessionStore();
  const s = store.create('3000');
  assert.equal(s.status, 'starting');
  assert.equal(s.active, true);
  assert.equal(s.restarts, 0);
  assert.equal(s.exitCode, null);
  assert.equal(typeof s.startedAt, 'string');
  store.appendChunk(s.id, fixture);
  assert.equal(s.status, 'running');
  assert.equal(s.counts.error, 1);
  assert.equal(s.counts.warn, 1);
  store.appendChunk(s.id, '{"level":"fatal","message":"boom"}');
  assert.equal(s.counts.error, 2);

  store.stop(s.id);
  assert.equal(s.status, 'stopped');
  assert.equal(typeof s.stoppedAt, 'string');
  assert.ok(store.list().includes(s));
  assert.equal(store.listActive().includes(s), false);
  const before = s.entries.length;
  store.markExited(s.id, 1);
  assert.equal(s.status, 'stopped');
  assert.equal(s.entries.length, before);

  const r = store.restart(s.id);
  assert.equal(r, s);
  assert.equal(s.status, 'starting');
  assert.equal(s.active, true);
  assert.equal(s.url, null);
  assert.equal(s.restarts, 1);
  assert.equal(s.stoppedAt, null);
  assert.equal(s.entries.length, before + 1);
  assert.equal(s.entries.at(-1).message, '— riavvio #1 —');
  assert.equal(s.entries.at(-1).index, before);
  assert.throws(() => store.restart(s.id), (e) => e.code === 'CONFLICT');

  store.markExited(s.id, 2);
  assert.equal(s.status, 'exited');
  assert.equal(s.exitCode, 2);
  assert.equal(s.active, false);
  assert.equal(s.entries.at(-1).message, 'cloudflared terminato (codice 2)');
  assert.equal(s.entries.at(-1).level, 'error');

  const ok = store.create('4000');
  store.markExited(ok.id, 0);
  assert.equal(ok.entries.at(-1).level, 'info');
  assert.equal(ok.counts.info, 1);
  assert.deepEqual([...store.list().map((x) => x.id)], [s.id, ok.id]);
});

test('HTTP restart, filtered logs, cached probe, stale exit', async () => {
  let probeCalls = 0;
  const procs = [];
  const app = createApp({
    probe: async () => { probeCalls += 1; return { present: true, version: 'cloudflared version test' }; },
    spawn() {
      const proc = fixtureProcess(fixture);
      procs.push(proc);
      return proc;
    },
  });
  await app.listen(0, '127.0.0.1');
  const json = async (path, init) => {
    const res = await fetch(`${app.url}${path}`, init);
    return { status: res.status, body: await res.json() };
  };
  const post = (path, body) => json(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const sessionState = async (id) => (await json('/api/state')).body.sessions.find((s) => s.id === id);
  try {
    await json('/api/state');
    await json('/api/state');
    await json('/api/state');
    assert.equal(probeCalls, 1);
    await json('/api/probe?fresh=1');
    assert.equal(probeCalls, 2);

    const created = await post('/api/sessions', { origin: '3000' });
    assert.equal(created.status, 201);
    const id = created.body.session.id;
    for (let i = 0; i < 50 && !(await sessionState(id)).url; i += 1) await new Promise((r) => setTimeout(r, 10));

    const logs = await json(`/api/sessions/${id}/logs?levels=error&q=control`);
    assert.equal(logs.body.total, 1);
    assert.equal(logs.body.entries[0].message, 'control stream failed without a timestamp');

    const busy = await post(`/api/sessions/${id}/restart`);
    assert.equal(busy.status, 409);
    assert.equal(busy.body.error, 'Il tunnel è già attivo');

    assert.equal((await post(`/api/sessions/${id}/stop`)).status, 200);
    const both = await Promise.all([post(`/api/sessions/${id}/restart`), post(`/api/sessions/${id}/restart`)]);
    assert.deepEqual(both.map((r) => r.status).sort(), [200, 409]);
    assert.equal(procs.length, 2);
    assert.equal((await post('/api/sessions/nope/restart')).status, 404);

    procs[0].emit('exit', 0);
    assert.notEqual((await sessionState(id)).status, 'exited');
    procs[1].emit('exit', 3);
    const exited = await sessionState(id);
    assert.equal(exited.status, 'exited');
    assert.equal(exited.exitCode, 3);
    assert.equal(exited.restarts, 1);
  } finally {
    await app.close();
  }
});

function fakeLog(total) {
  const rows = Array.from({ length: total }, (_, index) => ({ index }));
  return (key, page) => Promise.resolve({ total: rows.length, entries: rows.slice(page * 200, page * 200 + 200) });
}

test('page cache refetches a partial tail page after total grows past it', async () => {
  let total = 1190;
  const cache = dash.createPageCache((key, page) => fakeLog(total)(key, page));
  cache.reset('k');
  await cache.ensure([5]);
  assert.equal(cache.entryAt(1189).index, 1189);
  total = 1205;
  await cache.ensure([2]);
  await cache.refreshTail();
  await cache.ensure([...dash.pagesFor({ start: 1180, end: 1205 }, 200)]);
  for (let i = 1190; i < 1205; i += 1) assert.equal(cache.entryAt(i) && cache.entryAt(i).index, i, `row ${i}`);
});

test('page cache reports whether a refresh was applied', async () => {
  let release;
  const cache = dash.createPageCache((key) => (key === 'old'
    ? new Promise((resolve) => { release = resolve; })
    : Promise.resolve({ total: 5, entries: [] })));
  cache.reset('old');
  const stale = cache.refreshTail();
  cache.reset('new');
  release({ total: 500, entries: [] });
  assert.equal(await stale, false);
  assert.equal(await cache.refreshTail(), true);
});

test('the api.trycloudflare.com endpoint in an error is not the tunnel URL', () => {
  const line = '{"level":"error","message":"failed to request quick Tunnel: Post \\"https://api.trycloudflare.com/tunnel\\": dial tcp: lookup api.trycloudflare.com: no such host"}';
  assert.equal(dash.parseLogLine(line).url, null);
  const store = dash.createSessionStore();
  const s = store.create('3000');
  store.appendChunk(s.id, line);
  assert.equal(s.status, 'starting');
  assert.equal(s.url, null);
});

test('stopProcess leaves an already exited process group alone', () => {
  let killed = 0;
  const original = process.kill;
  process.kill = () => { killed += 1; };
  try {
    stopProcess({ pid: 999999, spawnfile: 'cloudflared', killed: false, exitCode: 1, signalCode: null, kill() { killed += 1; } });
    stopProcess({ pid: 999999, spawnfile: 'cloudflared', killed: false, exitCode: null, signalCode: 'SIGTERM', kill() { killed += 1; } });
  } finally {
    process.kill = original;
  }
  assert.equal(killed, 0);
});

// Objects made inside the vm sandbox have another realm's prototypes.
const plain = (value) => JSON.parse(JSON.stringify(value));

test('tunnel options and command', () => {
  const o = dash.normalizeTunnelOptions({ allowedMail: 'Mario@Cliente.it; *@azienda.it;\nmario@cliente.it;' });
  assert.deepEqual(plain(o.allowedMail), ['mario@cliente.it', '*@azienda.it']);
  assert.deepEqual(plain(dash.normalizeTunnelOptions()), { mode: 'origin', allowedMail: [], hostHeader: '', noTlsVerify: false, http2Origin: false });
  assert.throws(() => dash.normalizeTunnelOptions({ allowedMail: 'mario@' }),
    (e) => e.code === 'BAD_OPTIONS' && e.key === 'options.mailInvalid' && e.params.value === 'mario@');
  assert.throws(() => dash.normalizeTunnelOptions({ allowedMail: Array.from({ length: 21 }, (_, i) => `u${i}@x.it`) }),
    (e) => e.key === 'options.mailTooMany' && e.params.max === 20);
  assert.throws(() => dash.normalizeTunnelOptions({ hostHeader: 'a b' }), (e) => e.key === 'options.hostHeaderInvalid');
  assert.deepEqual(plain(dash.normalizeTunnelOptions({ mode: 'hello', hostHeader: 'x.local', noTlsVerify: true, allowedMail: 'a@b.it' })),
    { mode: 'hello', allowedMail: ['a@b.it'], hostHeader: '', noTlsVerify: false, http2Origin: false });

  const c = dash.buildQuickTunnelCommand('3000', { allowedMail: '*@azienda.it', hostHeader: 'app.local', noTlsVerify: true, http2Origin: true });
  assert.deepEqual(plain(c.args), ['tunnel', '--url', 'http://127.0.0.1:3000', '--allowed-mail', '*@azienda.it', '--http-host-header', 'app.local',
    '--no-tls-verify', '--http2-origin', '--metrics', '127.0.0.1:0', '--output', 'json', '--no-autoupdate']);
  assert.equal(c.equivalent, "cloudflared tunnel --url http://127.0.0.1:3000 --allowed-mail '*@azienda.it' --http-host-header app.local --no-tls-verify --http2-origin");
  assert.equal(c.mode, 'origin');
  const hw = dash.buildQuickTunnelCommand('', { mode: 'hello' });
  assert.equal(hw.origin, null);
  assert.equal(hw.args[1], '--hello-world');
  assert.equal(hw.equivalent, 'cloudflared tunnel --hello-world');
  assert.equal(dash.buildQuickTunnelCommand('3000').equivalent, 'cloudflared tunnel --url http://127.0.0.1:3000');
});

test('metrics address, origin errors and traffic in the store', () => {
  const read = (name) => fs.readFileSync(path.join(dashboardRoot, 'test/fixtures', name), 'utf8');
  const hello = read('hello-world.log');
  const down = read('origin-down.log');

  assert.ok(dash.parseLogStream(hello).some((e) => /^127\.0\.0\.1:\d+$/.test(e.metricsAddr || '')));
  assert.ok(dash.parseLogStream(down).some((e) => e.originError === true));
  assert.equal(dash.parseLogStream(fixture).some((e) => e.originError), false);
  assert.equal(dash.parseLogLine('INF plain').metricsAddr, null);

  const store = dash.createSessionStore();
  const s = store.create('3000', { allowedMail: 'a@b.it' });
  assert.equal(s.mode, 'origin');
  assert.equal(s.metricsUrl, null);
  assert.equal(s.traffic, null);
  assert.equal(s.lastOriginError, null);
  store.appendChunk(s.id, hello);
  assert.match(s.metricsUrl, /^http:\/\/127\.0\.0\.1:\d+\/metrics$/);
  store.appendChunk(s.id, down);
  assert.match(s.lastOriginError.message, /Request failed|Unable to reach the origin service/);
  assert.ok(!Number.isNaN(Date.parse(s.lastOriginError.at)));

  for (let i = 0; i <= 150; i += 1) store.recordTraffic(s.id, { inflight: i, total: i * 2, errors: 1, connections: 1 });
  assert.equal(s.traffic.history.length, 150);
  assert.equal(s.traffic.history[149], 150);
  assert.equal(s.traffic.ok, true);
  assert.equal(s.traffic.total, 300);
  store.recordTraffic(s.id, { inflight: null, total: 301, errors: 1, connections: 1 });
  assert.equal(s.traffic.history[149], 0);
  const before = s.traffic.history.slice();
  store.markTrafficStale(s.id);
  assert.equal(s.traffic.ok, false);
  assert.deepEqual(s.traffic.history, before);

  store.stop(s.id);
  store.restart(s.id);
  assert.deepEqual(plain(s.options.allowedMail), ['a@b.it']);
  assert.ok(s.invocation.args.includes('--allowed-mail'));
  assert.equal(s.metricsUrl, null);
  assert.equal(s.traffic, null);
  assert.equal(s.lastOriginError, null);

  const hw = store.create('', { mode: 'hello' });
  assert.equal(hw.origin, null);
  assert.equal(hw.mode, 'hello');
  assert.equal(dash.TRAFFIC_KEEP, 150);
  const fresh = store.create('4000');
  store.markTrafficStale(fresh.id);
  assert.equal(fresh.traffic, null);
});

test('HTTP create accepts tunnel options and hello world; close stops the sampler', async () => {
  const seen = [];
  let fetches = 0;
  const app = createApp({
    probe: async () => ({ present: true, version: 'test' }),
    spawn(bin, args) {
      seen.push(args);
      return fixtureProcess('{"level":"info","message":"Starting metrics server on 127.0.0.1:3999/metrics"}\n');
    },
    fetch: () => { fetches += 1; return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('cloudflared_tunnel_total_requests 3\n') }); },
    trafficIntervalMs: 5,
  });
  await app.listen(0, '127.0.0.1');
  const post = (body) => fetch(`${app.url}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const created = await post({ origin: '3000', options: { allowedMail: 'a@b.it', noTlsVerify: true } });
    assert.equal(created.status, 201);
    const { session } = await created.json();
    assert.deepEqual(session.options.allowedMail, ['a@b.it']);
    assert.equal(session.mode, 'origin');
    assert.equal(session.traffic, null);
    assert.equal(session.lastOriginError, null);
    assert.ok(seen[0].includes('--no-tls-verify'));
    assert.equal(seen[0][seen[0].indexOf('--allowed-mail') + 1], 'a@b.it');

    const hello = await post({ options: { mode: 'hello' } });
    assert.equal(hello.status, 201);
    assert.equal(seen[1][1], '--hello-world');

    const bad = await post({ origin: '3000', options: { allowedMail: 'x' } });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).key, 'options.mailInvalid');

    await new Promise((r) => setTimeout(r, 40));
    const state = await (await fetch(`${app.url}/api/state`)).json();
    assert.equal(state.sessions[0].traffic.total, 3);
  } finally {
    await app.close();
  }
  const after = fetches;
  assert.ok(after >= 1);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(fetches, after);
});

test('an Outlook recipient list with display names is accepted', () => {
  const o = dash.normalizeTunnelOptions({ allowedMail: 'Mario Rossi <Mario@X.it>; "Bianchi, Anna" <anna@y.it>; *@azienda.it;' });
  assert.deepEqual(plain(o.allowedMail), ['mario@x.it', 'anna@y.it', '*@azienda.it']);
  assert.throws(() => dash.normalizeTunnelOptions({ allowedMail: 'Mario <mario@>' }), (e) => e.key === 'options.mailInvalid' && e.params.value === 'mario@');
});

test('late lines from a replaced process do not reach the restarted session', async () => {
  const { PassThrough } = await import('node:stream');
  const procs = [];
  const app = createApp({
    probe: async () => ({ present: true, version: 'test' }),
    spawn() {
      const proc = new EventEmitter();
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      proc.pid = 0;
      proc.kill = () => {};
      procs.push(proc);
      return proc;
    },
  });
  await app.listen(0, '127.0.0.1');
  const post = (p, body) => fetch(`${app.url}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const tick = () => new Promise((r) => setTimeout(r, 20));
  try {
    const { session } = await (await post('/api/sessions', { origin: '3000' })).json();
    await post(`/api/sessions/${session.id}/stop`);
    procs[0].stdout.write('INF shutting down after stop\n');
    await tick();
    assert.ok(app.store.get(session.id).entries.some((e) => /shutting down after stop/.test(e.message)));
    await post(`/api/sessions/${session.id}/restart`);
    procs[0].stdout.write('{"level":"error","error":"Unable to reach the origin service. dial tcp: i/o timeout","message":"Request failed"}\n');
    procs[1].stdout.write('INF new process line\n');
    await tick();
    const s = app.store.get(session.id);
    assert.equal(s.lastOriginError, null);
    assert.ok(s.entries.some((e) => /new process line/.test(e.message)));
    assert.equal(s.entries.some((e) => /Unable to reach/.test(e.raw)), false);
  } finally {
    procs.forEach((p) => { p.stdout.end(); p.stderr.end(); });
    await app.close();
  }
});

test('API refuses foreign Host and cross-site writes, allows same-origin and scripts', async () => {
  const http = await import('node:http');
  let spawns = 0;
  const app = createApp({
    probe: async () => ({ present: true, version: 'test' }),
    spawn() { spawns += 1; return fixtureProcess(''); },
  });
  await app.listen(0, '127.0.0.1');
  const port = new URL(app.url).port;
  const send = (method, p, headers = {}, body) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
  const json = { 'Content-Type': 'application/json' };
  const create = JSON.stringify({ origin: '3000' });
  try {
    const rebind = await send('GET', '/api/state', { Host: `evil.example:${port}` });
    assert.equal(rebind.status, 403);
    assert.equal(JSON.parse(rebind.body).key, 'request.forbidden');
    assert.equal((await send('GET', '/', { Host: `evil.example:${port}` })).status, 403);

    assert.equal((await send('POST', '/api/sessions', { ...json, Origin: 'http://evil.example' }, create)).status, 403);
    assert.equal((await send('POST', '/api/sessions', { ...json, Origin: 'null' }, create)).status, 403);
    assert.equal((await send('POST', '/api/sessions', { ...json, 'Sec-Fetch-Site': 'cross-site' }, create)).status, 403);
    assert.equal(spawns, 0);

    const same = await send('POST', '/api/sessions', { ...json, Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}` }, create);
    assert.equal(same.status, 201);
    const id = JSON.parse(same.body).session.id;
    assert.equal((await send('POST', `/api/sessions/${id}/stop`, { Origin: 'http://evil.example' })).status, 403);
    assert.equal((await send('DELETE', `/api/sessions/${id}`, { Origin: 'http://evil.example' })).status, 403);
    assert.equal((await send('POST', `/api/sessions/${id}/stop`, { Host: `localhost:${port}`, Origin: `http://localhost:${port}` })).status, 200);
    assert.equal((await send('POST', '/api/sessions', json, create)).status, 201);   // curl-like: no Origin
    assert.equal(spawns, 2);
    assert.equal((await send('GET', '/api/state', { Host: `localhost:${port}` })).status, 200);
  } finally {
    await app.close();
  }
});

test('the copied command is shell-safe for any origin', () => {
  const amp = dash.buildQuickTunnelCommand('http://127.0.0.1:3000/?a=1&b=2');
  assert.equal(amp.equivalent, "cloudflared tunnel --url 'http://127.0.0.1:3000?a=1&b=2'");
  const sub = dash.buildQuickTunnelCommand('http://127.0.0.1:3000/$(id)');
  assert.match(sub.equivalent, /--url 'http:\/\/127\.0\.0\.1:3000\/\$\(id\)'$/);
  const quote = dash.buildQuickTunnelCommand("http://127.0.0.1:3000/a*'b");
  assert.ok(quote.equivalent.endsWith(`'http://127.0.0.1:3000/a*'\\''b'`), quote.equivalent);
  assert.equal(dash.buildQuickTunnelCommand('3000').equivalent, 'cloudflared tunnel --url http://127.0.0.1:3000');
});

test('metrics address is only taken from a loopback line', () => {
  assert.equal(dash.parseLogLine('{"level":"info","message":"Starting metrics server on 127.0.0.1:39599/metrics"}').metricsAddr, '127.0.0.1:39599');
  assert.equal(dash.parseLogLine('{"error":"Starting metrics server on evil.example:80/metrics","level":"error"}').metricsAddr, null);
});

test('a huge email list fails fast on the limit', () => {
  const many = Array.from({ length: 60000 }, (_, i) => `u${i}@x.it`);
  const started = Date.now();
  assert.throws(() => dash.normalizeTunnelOptions({ allowedMail: many }), (e) => e.key === 'options.mailTooMany');
  assert.ok(Date.now() - started < 200, `took ${Date.now() - started} ms`);
});

test('host header must start with a letter or digit', () => {
  assert.throws(() => dash.normalizeTunnelOptions({ hostHeader: '--hello-world' }), (e) => e.key === 'options.hostHeaderInvalid');
  assert.throws(() => dash.normalizeTunnelOptions({ hostHeader: '.app.local' }), (e) => e.key === 'options.hostHeaderInvalid');
  assert.equal(dash.normalizeTunnelOptions({ hostHeader: 'app.local:8080' }).hostHeader, 'app.local:8080');
});

test('static files never escape public/', async () => {
  const app = createApp({ probe: async () => ({ present: true, version: 'test' }), spawn() { throw new Error('no spawn'); } });
  await app.listen(0, '127.0.0.1');
  try {
    assert.equal((await fetch(`${app.url}/..%2fserver.js`)).status, 404);
    assert.equal((await fetch(`${app.url}/%2e%2e/package.json`)).status, 404);
    assert.equal((await fetch(`${app.url}/js/parse.js`)).status, 200);
  } finally {
    await app.close();
  }
});

test('--version prints the version without opening the port', async () => {
  const run = (env = {}) => Bun.spawnSync(['bun', 'server.js', '--version'], { cwd: dashboardRoot, env: { ...process.env, ...env }, timeout: 3000 });
  const plainRun = run();
  assert.equal(plainRun.exitCode, 0);
  assert.equal(plainRun.stdout.toString(), 'trydash dev\n');
  const busy = createApp({ probe: async () => ({ present: true, version: 'test' }), spawn() { throw new Error('no spawn'); } });
  await busy.listen(0, '127.0.0.1');
  try {
    const onBusyPort = run({ PORT: new URL(busy.url).port });
    assert.equal(onBusyPort.exitCode, 0);
    assert.equal(onBusyPort.stdout.toString(), 'trydash dev\n');
  } finally {
    await busy.close();
  }
  assert.equal(appVersion(), 'dev');
  globalThis.__TRYDASH_VERSION__ = '1.2.3';
  try {
    assert.equal(appVersion(), '1.2.3');
  } finally {
    delete globalThis.__TRYDASH_VERSION__;
  }
});

test('listen rejects when the port is taken', async () => {
  const first = createApp({ probe: async () => ({ present: true, version: 'test' }), spawn() { throw new Error('no spawn'); } });
  await first.listen(0, '127.0.0.1');
  const second = createApp({ probe: async () => ({ present: true, version: 'test' }), spawn() { throw new Error('no spawn'); } });
  try {
    await assert.rejects(second.listen(Number(new URL(first.url).port), '127.0.0.1'), /EADDRINUSE|in use/i);
  } finally {
    await second.close();
    await first.close();
  }
});
