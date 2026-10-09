import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadDashboard } from './src/load-dashboard.js';
import { openQuickTunnel, spawnForSession, stopProcess } from './src/runtime.js';
import { createTrafficSampler } from './src/traffic.js';
import { readAsset } from './src/assets.js';


const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};



function probeCloudflared() {
  return new Promise((resolve) => {
    execFile('cloudflared', ['--version'], { timeout: 4000 }, (error, stdout, stderr) => {
      if (error) {
        resolve({ present: false });
        return;
      }
      const version = String(stdout || stderr || '').trim().split('\n')[0];
      resolve({ present: true, version });
    });
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(Object.assign(new Error('body'), { key: 'request.bodyTooLarge', status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

function hostnameOf(host) {
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return '';
  }
}

// The dashboard can open public tunnels, so a page from another site must not
// drive it: a foreign Host means DNS rebinding, a foreign Origin a cross-site write.
// Requests without Origin (curl, scripts) stay allowed.
export function isAllowedRequest(method, headers) {
  const host = String(headers.host || '');
  if (!LOCAL_HOSTNAMES.has(hostnameOf(host))) return false;
  if (method === 'GET' || method === 'HEAD') return true;
  if (headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = headers.origin;
  if (origin == null) return true;
  return origin === `http://${host}`;
}

function sendJson(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function summary(session) {
  return {
    id: session.id,
    origin: session.origin,
    mode: session.mode,
    options: session.options,
    status: session.status,
    active: session.active,
    url: session.url,
    entryCount: session.entries.length,
    equivalent: session.invocation.equivalent,
    exitCode: session.exitCode,
    startedAt: session.startedAt,
    stoppedAt: session.stoppedAt,
    restarts: session.restarts,
    counts: session.counts,
    traffic: session.traffic,
    lastOriginError: session.lastOriginError,
  };
}

export function seedFixture(store, file) {
  const text = file ? fs.readFileSync(file, 'utf8') : readAsset('test/fixtures/quick-tunnel.log').toString('utf8');
  const session = store.create('http://127.0.0.1:8080');
  store.appendChunk(session.id, text);
  // Sample traffic so the strip and sparkline show without a real tunnel.
  for (let i = 0; i < 40; i += 1) {
    store.recordTraffic(session.id, {
      inflight: Math.round(6 + 6 * Math.sin(i / 4)),
      total: 30 + i * 7,
      errors: 3,
      connections: 4,
    });
  }
  return session;
}

export function createApp(options = {}) {
  const dash = options.dashboard || loadDashboard();
  const store = options.store || dash.createSessionStore();
  const spawnImpl = options.spawn || spawn;
  const processes = new Map();
  const sampler = createTrafficSampler({
    store,
    fetchImpl: options.fetch || fetch,
    intervalMs: options.trafficIntervalMs || 2000,
  });
  let probeCache = null;

  // Error bodies are { error, key, params }, with error in the caller's language.
  function sendError(res, req, status, errOrKey, params, extra) {
    const err = typeof errOrKey === 'string' ? { key: errOrKey, params: params || {} } : errOrKey;
    const lang = dash.pickLang(req && req.headers ? req.headers['accept-language'] : '');
    sendJson(res, status, { ...dash.errorBody(err, lang), ...(extra || {}) });
  }

  async function readProbe({ fresh = false } = {}) {
    if (!probeCache || fresh) probeCache = await probeOnce();
    return probeCache;
  }

  // A stopped session keeps its last process's shutdown lines; after a restart
  // only the new process may write.
  function isCurrent(id, proc) {
    const current = processes.get(id);
    return !current || current === proc;
  }

  // Only the latest process of a session may change its state.
  function attach(id, proc, done) {
    processes.set(id, proc);
    proc.on?.('error', (error) => {
      if (!store.get(id) || processes.get(id) !== proc) return;
      store.appendChunk(id, JSON.stringify({
        level: 'error',
        message: `cloudflared non parte: ${error.message}`,
      }));
      store.markExited(id, null);
    });
    proc.on?.('exit', (code) => {
      if (!store.get(id) || processes.get(id) !== proc) return;
      store.markExited(id, code);
    });
    done.catch(() => {});
  }

  async function probeOnce() {
    if (options.probe) {
      const result = await options.probe();
      return {
        binary: 'cloudflared',
        platform: process.platform,
        arch: process.arch,
        ...result,
      };
    }
    if (process.env.DASHBOARD_PROBE === 'missing') {
      return { present: false, binary: 'cloudflared', platform: process.platform, arch: process.arch };
    }
    if (process.env.DASHBOARD_PROBE === 'present') {
      return {
        present: true,
        binary: 'cloudflared',
        version: process.env.DASHBOARD_PROBE_VERSION || 'cloudflared present',
        platform: process.platform,
        arch: process.arch,
      };
    }
    const result = await probeCloudflared();
    return { binary: 'cloudflared', platform: process.platform, arch: process.arch, ...result };
  }

  function serveStatic(pathname, res) {
    if (pathname === '/favicon.ico') {
      pathname = '/favicon.png';
    }
    const rel = pathname === '/' ? '/index.html' : pathname;
    // readAsset refuses `..` and absolute paths, so nothing outside public/ is served.
    const data = readAsset('public' + rel);
    if (!data) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(rel)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  }

  async function handle(req, res) {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (!isAllowedRequest(req.method, req.headers)) {
      sendError(res, req, 403, 'request.forbidden');
      return;
    }
    try {
      if (req.method === 'GET' && (url.pathname === '/api/state' || url.pathname === '/api/probe')) {
        const probe = await readProbe({ fresh: url.pathname === '/api/probe' && url.searchParams.get('fresh') === '1' });
        if (url.pathname === '/api/probe') {
          sendJson(res, 200, probe);
          return;
        }
        sendJson(res, 200, { probe, sessions: store.list().map(summary) });
        return;
      }

      const logsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/logs$/);
      if (req.method === 'GET' && logsMatch) {
        const session = store.get(decodeURIComponent(logsMatch[1]));
        if (!session) return sendError(res, req, 404, 'session.notFound');
        const limitParam = url.searchParams.get('limit');
        const levels = (url.searchParams.get('levels') || '').split(',').map((level) => level.trim()).filter(Boolean);
        const filtered = dash.filterEntries(session.entries, { levels, q: url.searchParams.get('q') || '' });
        sendJson(res, 200, dash.logWindow(filtered, {
          offset: Number(url.searchParams.get('offset') || 0),
          limit: limitParam == null ? undefined : Number(limitParam),
        }));
        return;
      }

      const entryMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/entries\/(\d+)$/);
      if (req.method === 'GET' && entryMatch) {
        const session = store.get(decodeURIComponent(entryMatch[1]));
        if (!session) return sendError(res, req, 404, 'session.notFound');
        const resolved = dash.resolveWindowEntry(session.entries, Number(entryMatch[2]));
        if (!resolved.detail) return sendError(res, req, 404, 'entry.notFound');
        sendJson(res, 200, { detail: resolved.detail });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/sessions') {
        const probe = await readProbe();
        if (dash.viewForProbe(probe).phase !== 'workspace') {
          sendError(res, req, 409, 'cloudflared.unavailable', {}, { phase: 'install' });
          return;
        }
        let payload;
        let body;
        try {
          body = await readBody(req);
        } catch (error) {
          sendError(res, req, error.status || 400, error);
          return;
        }
        try {
          payload = JSON.parse(body || '{}');
        } catch {
          sendError(res, req, 400, 'request.badJson');
          return;
        }
        let opened;
        try {
          opened = openQuickTunnel(store, payload.origin, spawnImpl, payload.options, isCurrent);
        } catch (error) {
          const code = error.code === 'BAD_ORIGIN' || error.code === 'BAD_OPTIONS' ? 400 : 500;
          sendError(res, req, code, error);
          return;
        }
        attach(opened.session.id, opened.proc, opened.done);
        sendJson(res, 201, { session: summary(opened.session) });
        return;
      }

      const restartMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/restart$/);
      if (req.method === 'POST' && restartMatch) {
        const id = decodeURIComponent(restartMatch[1]);
        if (!store.get(id)) return sendError(res, req, 404, 'session.notFound');
        let session;
        try {
          session = store.restart(id);
        } catch (error) {
          if (error.code === 'CONFLICT') return sendError(res, req, 409, error);
          throw error;
        }
        let spawned;
        try {
          spawned = spawnForSession(store, session, spawnImpl, isCurrent);
        } catch (error) {
          store.markExited(id, null);
          return sendError(res, req, 500, error);
        }
        attach(id, spawned.proc, spawned.done);
        sendJson(res, 200, { session: summary(session) });
        return;
      }

      const stopMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/stop$/);
      if (req.method === 'POST' && stopMatch) {
        const id = decodeURIComponent(stopMatch[1]);
        if (!store.get(id)) return sendError(res, req, 404, 'session.notFound');
        stopProcess(processes.get(id));
        processes.delete(id);
        const session = store.stop(id);
        sendJson(res, 200, { ok: true, session: summary(session) });
        return;
      }

      const delMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
      if (req.method === 'DELETE' && delMatch) {
        const id = decodeURIComponent(delMatch[1]);
        if (!store.get(id)) return sendError(res, req, 404, 'session.notFound');
        stopProcess(processes.get(id));
        processes.delete(id);
        store.remove(id);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === 'GET') {
        serveStatic(url.pathname, res);
        return;
      }
      sendError(res, req, 405, 'request.methodNotAllowed');
    } catch (error) {
      if (!res.headersSent) sendError(res, req, 500, error);
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (!res.headersSent) sendError(res, req, 500, error);
    });
  });

  return {
    server,
    store,
    dashboard: dash,
    url: '',
    async listen(port = 0, host = '127.0.0.1') {
      // Without an error listener a busy port is an uncaught exception, not a rejection.
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve();
        });
      });
      sampler.start();
      const address = server.address();
      this.url = `http://${host}:${address.port}`;
      return this.url;
    },
    async close() {
      sampler.stop();
      for (const proc of processes.values()) stopProcess(proc);
      processes.clear();
      if (!server.listening) return;
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function isDirectRun() {
  // In a compiled binary everything is one module; build/entry.js starts main().
  if (globalThis.__TRYDASH_ASSETS__) return false;
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

// Set by the compiled binary's entry (scripts/build.js); `dev` when run from source.
export function appVersion() {
  return globalThis.__TRYDASH_VERSION__ || 'dev';
}

export async function main() {
  if (process.argv.includes('--version')) {
    console.log(`trydash ${appVersion()}`);
    return null;
  }
  const app = createApp();
  if (process.env.DASHBOARD_SEED === '1') seedFixture(app.store);
  const port = Number(process.env.PORT || 8787);
  const url = await app.listen(port, '127.0.0.1');
  const probe = process.env.DASHBOARD_PROBE || 'auto';
  console.log(`trydash ${appVersion()}  ${url}`);
  console.log(`probe ${probe}`);
  const shutdown = () => {
    app.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return app;
}

if (isDirectRun()) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}
