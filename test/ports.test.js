import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { scanPorts, isListening, COMMON_PORTS } from '../src/ports.js';
import { createApp } from '../server.js';

function listen(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.end());
    server.once('error', reject);
    server.listen(0, host, () => resolve(server));
  });
}

test('only listening ports come back, an IPv6-only one with an [::1] origin', async () => {
  const v4 = await listen();
  let v6 = null;
  try { v6 = await listen('::1'); } catch { v6 = null; }
  const closed = await listen();
  const closedPort = closed.address().port;
  await new Promise((r) => closed.close(r));
  try {
    const ports = [
      { port: v4.address().port, hint: 'Vite' },
      { port: closedPort, hint: null },
      ...(v6 ? [{ port: v6.address().port, hint: null }] : []),
    ];
    const found = await scanPorts({ ports, timeoutMs: 300 });
    assert.deepEqual(found.find((p) => p.port === v4.address().port), { port: v4.address().port, hint: 'Vite', origin: String(v4.address().port) });
    assert.equal(found.some((p) => p.port === closedPort), false);
    if (v6) {
      const six = found.find((p) => p.port === v6.address().port);
      // The same port may be free on 127.0.0.1 only by luck; then the IPv6 origin is used.
      if (!(await isListening(v6.address().port, '127.0.0.1'))) assert.equal(six.origin, `http://[::1]:${v6.address().port}`);
    }
    assert.deepEqual(await scanPorts({ ports, exclude: [v4.address().port], timeoutMs: 300 }).then((l) => l.some((p) => p.port === v4.address().port)), false);
    assert.ok(COMMON_PORTS.some((p) => p.port === 5173 && p.hint === 'Vite'));
    assert.equal(await isListening(closedPort, '127.0.0.1', 200), false);
  } finally {
    await new Promise((r) => v4.close(r));
    if (v6) await new Promise((r) => v6.close(r));
  }
});

test('GET /api/ports leaves out trydash itself and marks ports already in a tunnel', async () => {
  const calls = [];
  const app = createApp({
    probe: async () => ({ present: true, version: 'test' }),
    spawn() { return quietProcess(); },
    scanPorts: async ({ exclude }) => { calls.push(exclude); return [{ port: 3000, hint: 'Next.js', origin: '3000' }, { port: 5173, hint: 'Vite', origin: '5173' }]; },
  });
  await app.listen(0, '127.0.0.1');
  try {
    app.store.create('3000');
    const first = await (await fetch(`${app.url}/api/ports`)).json();
    assert.deepEqual(first.ports.map((p) => [p.port, p.busy]), [[3000, true], [5173, false]]);
    assert.ok(calls[0].includes(Number(new URL(app.url).port)));
    await fetch(`${app.url}/api/ports`);
    assert.equal(calls.length, 1, 'cached for a few seconds');
    assert.equal((await fetch(`${app.url}/api/ports`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  } finally {
    await app.close();
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
