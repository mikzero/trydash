import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import http from 'node:http';
import {
  scanPorts, isListening, COMMON_PORTS, parseProcNet, parseLsof, parseNetstat, parseTasklist, candidates,
  systemListeners, fingerprint, identify, deepScan, formatScan,
} from '../src/ports.js';
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
    // Without the system's list, the given ports are tried one by one.
    const found = await scanPorts({ ports, timeoutMs: 300, listeners: null });
    assert.deepEqual(found.find((p) => p.port === v4.address().port), { port: v4.address().port, hint: 'Vite', origin: String(v4.address().port), process: null, local: true });
    assert.equal(found.some((p) => p.port === closedPort), false);
    if (v6) {
      const six = found.find((p) => p.port === v6.address().port);
      // The same port may be free on 127.0.0.1 only by luck; then the IPv6 origin is used.
      if (!(await isListening(v6.address().port, '127.0.0.1'))) assert.equal(six.origin, `http://[::1]:${v6.address().port}`);
    }
    assert.deepEqual(await scanPorts({ ports, exclude: [v4.address().port], timeoutMs: 300, listeners: null }).then((l) => l.some((p) => p.port === v4.address().port)), false);
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

test('the system list: /proc, lsof and netstat output', () => {
  const tcp = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 111 1 0
   1: 00000000:1F40 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 222 1 0
   2: 0100007F:1F90 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1000        0 333 1 0
   3: 0101A8C0:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 444 1 0
`;
  assert.deepEqual(parseProcNet(tcp), [
    { address: '127.0.0.1', port: 8080, inode: '111' },
    { address: '0.0.0.0', port: 8000, inode: '222' },
    { address: '192.168.1.1', port: 3000, inode: '444' },
  ]);
  const tcp6 = `  sl  local_address                         remote_address                        st
   0: 00000000000000000000000001000000:1435 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000 0 555 1 0
   1: 00000000000000000000000000000000:2328 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000 0 666 1 0
   2: 0000000000000000FFFF00000100007F:1F41 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000 0 777 1 0
`;
  assert.deepEqual(parseProcNet(tcp6, true).map((x) => [x.address, x.port]), [['::1', 5173], ['::', 9000], ['::ffff:127.0.0.1', 8001]]);

  assert.deepEqual(parseLsof('p501\ncnode\nn127.0.0.1:5173\nn[::1]:5173\np777\ncphp\nn*:8080\n'), [
    { address: '127.0.0.1', port: 5173, pid: 501, process: 'node' },
    { address: '::1', port: 5173, pid: 501, process: 'node' },
    { address: '0.0.0.0', port: 8080, pid: 777, process: 'php' },
  ]);
  const netstat = '\r\nActive Connections\r\n\r\n  Proto  Local Address          Foreign Address        State           PID\r\n  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1004\r\n  TCP    127.0.0.1:3000         0.0.0.0:0              LISTENING       4242\r\n  TCP    127.0.0.1:3000         127.0.0.1:50000        ESTABLISHED     4242\r\n  TCP    [::1]:5173             [::]:0                 LISTENING       4343\r\n';
  assert.deepEqual(parseNetstat(netstat), [
    { address: '0.0.0.0', port: 135, pid: 1004 },
    { address: '127.0.0.1', port: 3000, pid: 4242 },
    { address: '::1', port: 5173, pid: 4343 },
  ]);
  assert.deepEqual(Array.from(parseTasklist('"node.exe","4242","Console","1","50,000 K"\r\n"svchost.exe","1004","Services","0","9,000 K"')), [[4242, 'node'], [1004, 'svchost']]);
});

test('candidates: one per port, reachable origin, databases and system services left out', () => {
  const list = [
    { address: '127.0.0.1', port: 5173, process: 'node' },
    { address: '::1', port: 5173, process: 'node' },
    { address: '::1', port: 4321, process: 'node' },
    { address: '0.0.0.0', port: 8080, process: 'php' },
    { address: '172.17.0.1', port: 8088, process: 'docker-proxy' },
    { address: '0.0.0.0', port: 5432, process: 'postgres' },
    { address: '0.0.0.0', port: 3306, process: null },
    { address: '0.0.0.0', port: 22, process: 'sshd' },
    { address: '127.0.0.1', port: 7000, process: 'ControlCe' },
    { address: '127.0.0.1', port: 45123, process: 'code' },
    { address: '127.0.0.1', port: 8787, process: 'bun' },
  ];
  assert.deepEqual(candidates(list, { exclude: [8787] }).map((c) => [c.port, c.origin, c.process]), [
    [4321, 'http://[::1]:4321', 'node'],
    [5173, '5173', 'node'],
    [8080, '8080', 'php'],
    [8088, 'http://172.17.0.1:8088', 'docker-proxy'],
  ]);
  const all = candidates(list, { all: true });
  assert.ok(all.find((c) => c.port === 45123).quiet);
  assert.ok(all.find((c) => c.port === 3306).quiet);
  assert.equal(all.some((c) => c.port === 22 || c.port === 7000), false, 'system services never show');
  assert.equal(all.find((c) => c.port === 5173).hint, 'Vite');
});

test('the system list on this machine finds a server we start, with its process', { skip: !['linux', 'darwin', 'win32'].includes(process.platform) }, async () => {
  const server = await listen();
  try {
    const list = await systemListeners();
    if (list == null) return; // a sandbox without /proc or lsof: the fallback covers it
    const mine = list.find((item) => item.port === server.address().port);
    assert.ok(mine, 'our port is listed');
    assert.ok(mine.process == null || /node|bun/i.test(mine.process), String(mine.process));
    const found = await scanPorts({ exclude: [] });
    assert.ok(found.some((item) => item.port === server.address().port) || server.address().port >= 32768);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('fingerprint: what kind of site answers, and the preview it needs', () => {
  const page = (body, headers = {}, status = 200) => fingerprint({ status, headers, body });
  const wp = page('<html><head><title>Bottega</title><meta name="generator" content="WordPress 6.5"></head></html>');
  assert.deepEqual({ kind: wp.kind, label: wp.label, title: wp.title, suggest: wp.suggest }, { kind: 'wordpress', label: 'WordPress', title: 'Bottega', suggest: { rewrite: true, preset: 'wordpress' } });
  assert.equal(page('', { 'x-redirect-by': 'WordPress', location: 'http://localhost:8080/' }, 301).kind, 'wordpress');
  assert.equal(page('<script type="module" src="/@vite/client"></script>').kind, 'vite');
  assert.deepEqual(page('Blocked request. This host ("x") is not allowed.', {}, 403).suggest, { rewrite: true, preset: null });
  assert.equal(page('<script id="__NEXT_DATA__"></script>', { 'x-powered-by': 'Next.js' }).kind, 'next');
  assert.equal(page('<p>hi</p>', { 'set-cookie': ['XSRF-TOKEN=a; path=/', 'laravel_session=b; path=/'] }).kind, 'laravel');
  assert.equal(page('<h1>DisallowedHost at /</h1>', {}, 400).kind, 'django');
  assert.equal(page('<app-root ng-version="17.0.0"></app-root>').kind, 'angular');
  assert.equal(page('<meta name="generator" content="Astro v4">').kind, 'astro');
  assert.equal(page('', { 'x-powered-by': 'Express' }).kind, 'express');
  assert.equal(page('', { 'x-powered-by': 'PHP/8.3' }).kind, 'php');
  assert.equal(page('', { server: 'nginx/1.25' }).label, 'nginx');
  const plain = page('<title>  My   tool </title>');
  assert.deepEqual([plain.kind, plain.title, plain.suggest.rewrite], [null, 'My tool', false]);
  // Any framework that redirects to localhost needs rewriting.
  assert.equal(page('', { location: 'http://127.0.0.1:3000/login' }, 302).suggest.rewrite, true);
  assert.equal(page('', { location: '/login' }, 302).suggest.rewrite, false);
});

test('identify and the full scan: one GET / with the local Host, nothing else', async () => {
  const seen = [];
  const site = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, host: req.headers.host, ua: req.headers['user-agent'] });
    res.writeHead(301, { Location: `http://localhost:${site.address().port}/`, 'X-Redirect-By': 'WordPress' });
    res.end();
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  // A TCP server that hangs up at once; its half-closed sockets are destroyed at the end.
  const sockets = new Set();
  const silent = await new Promise((resolve) => {
    const server = net.createServer((socket) => { sockets.add(socket); socket.end(); });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
  const port = site.address().port;
  try {
    const found = await identify({ port, origin: String(port) });
    assert.equal(found.kind, 'wordpress');
    assert.equal(found.tls, false);
    assert.deepEqual(seen, [{ method: 'GET', url: '/', host: `localhost:${port}`, ua: 'trydash-scan' }]);
    // A TCP server that closes at once is no web server.
    const none = await identify({ port: silent.address().port, origin: String(silent.address().port) }, { timeoutMs: 400 });
    assert.equal(none.http, false);

    const listeners = async () => [
      { address: '127.0.0.1', port, process: 'php' },
      { address: '127.0.0.1', port: silent.address().port, process: 'node' },
    ];
    const list = await deepScan({ listeners, timeoutMs: 400 });
    const wp = list.find((item) => item.port === port);
    assert.equal(wp.scan.label, 'WordPress');
    // A quiet (high) port that doesn't speak HTTP is dropped; ours are random high ports.
    if (silent.address().port >= 32768) assert.equal(list.some((item) => item.port === silent.address().port), false);
    const text = formatScan(list, { wordpress: ['/wp-admin', '/wp-login.php'] });
    assert.match(text, new RegExp(`:${port}\\s+WordPress · php`));
    assert.match(text, new RegExp(`→ trydash ${port} --rewrite --block /wp-admin,/wp-login.php`));
    assert.equal(formatScan([]), 'trydash: no web server is listening on this computer.');
  } finally {
    await new Promise((r) => site.close(r));
    for (const socket of sockets) socket.destroy();
    await new Promise((r) => silent.close(r));
  }
});

test('GET /api/ports?scan=1 runs the full scan; its findings stay on the port', async () => {
  let deepCalls = 0;
  const app = createApp({
    probe: async () => ({ present: true, version: 'test' }),
    spawn() { return quietProcess(); },
    scanPorts: async () => [
      { port: 8080, hint: null, origin: '8080', process: 'php' },
      { port: 45000, hint: null, origin: '45000', process: 'code', quiet: true },
      { port: 46000, hint: null, origin: '46000', process: 'node', quiet: true },
    ],
    deepScan: async ({ exclude }) => {
      deepCalls += 1;
      assert.ok(exclude.length >= 1);
      return [
        { port: 8080, origin: '8080', process: 'php', scan: { http: true, kind: 'wordpress', label: 'WordPress', suggest: { rewrite: true, preset: 'wordpress' } } },
        { port: 46000, origin: '46000', process: 'node', scan: { http: true, kind: 'vite', label: 'Vite', suggest: { rewrite: true, preset: null } } },
      ];
    },
  });
  await app.listen(0, '127.0.0.1');
  try {
    const before = await (await fetch(`${app.url}/api/ports`)).json();
    assert.deepEqual(before.ports.map((p) => p.port), [8080], 'quiet ports wait for a scan');
    const scanned = await (await fetch(`${app.url}/api/ports?scan=1`)).json();
    assert.equal(deepCalls, 1);
    assert.deepEqual(scanned.ports.map((p) => [p.port, p.scan && p.scan.label]), [[8080, 'WordPress'], [46000, 'Vite']]);
    const after = await (await fetch(`${app.url}/api/ports`)).json();
    assert.deepEqual(after.ports.map((p) => [p.port, p.scan && p.scan.label]), [[8080, 'WordPress'], [46000, 'Vite']]);
    assert.equal(after.ports[0].quiet, undefined);
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
