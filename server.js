import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadDashboard } from './src/load-dashboard.js';
import { spawnForSession, stopProcess, KILL_AFTER_MS } from './src/runtime.js';
import { createTrafficSampler } from './src/traffic.js';
import { createInspector } from './src/inspector.js';
import { resolveFolder } from './src/static.js';
import { parseArgs, helpText, envValue, openBrowser, announceUrl } from './src/cli.js';
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
// API calls must also come from the dashboard itself: a page on another port of
// 127.0.0.1 is "same-site" for the browser, and a GET can still have effects
// (a fresh probe starts a process), so only same-origin or direct requests pass.
export function isAllowedRequest(method, headers, { api = false } = {}) {
  const host = String(headers.host || '');
  if (!LOCAL_HOSTNAMES.has(hostnameOf(host))) return false;
  const site = headers['sec-fetch-site'];
  if (api && site && site !== 'same-origin' && site !== 'none') return false;
  if (method === 'GET' || method === 'HEAD') return true;
  if (headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = headers.origin;
  if (origin == null) return true;
  return origin === `http://${host}`;
}

// Sent with every dashboard response: no framing (clickjacking), no inline code,
// no MIME sniffing, no referrer leaking the token or a tunnel URL.
export const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; "
    + "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function cookieValue(header, name) {
  for (const part of String(header || '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return null;
}

export function newToken() {
  return crypto.randomBytes(18).toString('base64url');
}

export const MAX_SESSIONS = 50;

function sendJson(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

// Why a tunnel has no inspector: Hello World, HTTP/2 origin, or turned off at creation.
function inspectState(session, inspector) {
  const info = inspector ? inspector.info(session.id) : null;
  if (info) return { enabled: true, count: info.count, total: info.total, version: info.version, target: info.target };
  const options = session.options || {};
  const reason = session.mode === 'hello' ? 'hello' : options.http2Origin ? 'http2' : 'off';
  return { enabled: false, reason };
}

function summary(session, inspector) {
  return {
    id: session.id,
    origin: session.origin,
    mode: session.mode,
    options: session.options,
    status: session.status,
    active: session.active,
    url: session.url,
    entryCount: session.entries.length,
    droppedEntries: session.droppedEntries,
    equivalent: session.invocation.equivalent,
    equivalentWindows: session.invocation.equivalentWindows,
    exitCode: session.exitCode,
    startedAt: session.startedAt,
    stoppedAt: session.stoppedAt,
    restarts: session.restarts,
    counts: session.counts,
    traffic: session.traffic,
    lastOriginError: session.lastOriginError,
    inspect: inspectState(session, inspector),
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

// Example requests for DASHBOARD_SEED, so the Requests tab has something to show.
export async function seedInspector(inspector, session) {
  await inspector.open(session);
  const samples = JSON.parse(readAsset('test/fixtures/requests.json').toString('utf8'));
  const base = Date.now() - 90_000;
  for (const sample of samples) {
    inspector.inject(session.id, { ...sample, startedAt: new Date(base + sample.offsetS * 1000).toISOString() });
  }
}

export function createApp(options = {}) {
  const dash = options.dashboard || loadDashboard();
  const store = options.store || dash.createSessionStore();
  const spawnImpl = options.spawn || spawn;
  const processes = new Map();
  // A stopped tunnel's proxy turns traffic away at once, even before cloudflared has exited.
  const inspector = options.inspector || createInspector({ store, isLive: (id) => !!(store.get(id) && store.get(id).active) });
  const sampler = createTrafficSampler({
    store,
    fetchImpl: options.fetch || fetch,
    intervalMs: options.trafficIntervalMs || 2000,
  });
  let probeCache = null;
  let probeInflight = null;
  // With a token, every /api call needs it: as the cookie set by `/?token=…`,
  // or as `Authorization: Bearer …` for scripts. Without one (tests, embedding), no check.
  const token = options.token || null;
  let cookieName = 'trydash';

  function authorized(req) {
    if (!token) return true;
    const auth = String(req.headers.authorization || '');
    if (auth.startsWith('Bearer ') && safeEqual(auth.slice(7).trim(), token)) return true;
    const cookie = cookieValue(req.headers.cookie, cookieName);
    return cookie != null && safeEqual(cookie, token);
  }

  // Error bodies are { error, key, params }, with error in the caller's language.
  function sendError(res, req, status, errOrKey, params, extra) {
    const err = typeof errOrKey === 'string' ? { key: errOrKey, params: params || {} } : errOrKey;
    const lang = dash.pickLang(req && req.headers ? req.headers['accept-language'] : '');
    sendJson(res, status, { ...dash.errorBody(err, lang), ...(extra || {}) });
  }

  // One probe at a time: a burst of refreshes shares the running one.
  async function readProbe({ fresh = false } = {}) {
    if (probeCache && !fresh) return probeCache;
    if (!probeInflight) {
      probeInflight = probeOnce().then((result) => {
        probeCache = result;
        return result;
      }).finally(() => { probeInflight = null; });
    }
    return probeInflight;
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
        message: `cloudflared did not start: ${error.message}`,
      }));
      store.markExited(id, null);
    });
    proc.on?.('exit', (code) => {
      if (!store.get(id) || processes.get(id) !== proc) return;
      store.markExited(id, code);
    });
    done.catch(() => {});
  }

  function withStatus(error, status, extra) {
    return Object.assign(error, { status, extra });
  }

  // Creates and starts a tunnel: from POST /api/sessions and from the command line.
  // Errors carry the HTTP status they map to.
  async function openTunnel(origin, rawOptions) {
    const probe = await readProbe();
    if (dash.viewForProbe(probe).phase !== 'workspace') {
      throw withStatus(dash.appError('UNAVAILABLE', 'cloudflared.unavailable'), 409, { phase: 'install' });
    }
    if (store.list().length >= MAX_SESSIONS) {
      throw withStatus(dash.appError('LIMIT', 'session.tooMany', { max: MAX_SESSIONS }), 429);
    }
    let session;
    try {
      const wanted = rawOptions && typeof rawOptions === 'object' ? rawOptions : {};
      // A folder must exist now; the stored path is absolute, with `~` and symlinks resolved.
      const options = wanted.mode === 'folder' ? { ...wanted, folder: resolveFolder(wanted.folder) } : wanted;
      session = store.create(origin, options);
    } catch (error) {
      throw withStatus(error, error.code === 'BAD_ORIGIN' || error.code === 'BAD_OPTIONS' ? 400 : 500);
    }
    let spawned;
    try {
      if (session.options.inspect) store.setTarget(session.id, await inspector.open(session));
      spawned = spawnForSession(store, session, spawnImpl, isCurrent);
    } catch (error) {
      await inspector.close(session.id);
      store.remove(session.id);
      throw withStatus(error, 500);
    }
    attach(session.id, spawned.proc, spawned.done);
    return session;
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
    const fakeProbe = envValue(process.env, 'TRYDASH_PROBE');
    if (fakeProbe === 'missing') {
      return { present: false, binary: 'cloudflared', platform: process.platform, arch: process.arch };
    }
    if (fakeProbe === 'present') {
      return {
        present: true,
        binary: 'cloudflared',
        version: envValue(process.env, 'TRYDASH_PROBE_VERSION') || 'cloudflared present',
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
    const isApi = url.pathname.startsWith('/api/');
    if (!isAllowedRequest(req.method, req.headers, { api: isApi })) {
      sendError(res, req, 403, 'request.forbidden');
      return;
    }
    // `/?token=…` from the terminal: keep it in an HttpOnly cookie and drop it from the address bar.
    if (token && req.method === 'GET' && !isApi && url.searchParams.has('token')) {
      const ok = safeEqual(url.searchParams.get('token'), token);
      url.searchParams.delete('token');
      const headers = { Location: url.pathname + url.search, 'Cache-Control': 'no-store' };
      if (ok) headers['Set-Cookie'] = `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/`;
      res.writeHead(303, headers);
      res.end();
      return;
    }
    if (isApi && !authorized(req)) {
      sendError(res, req, 401, 'request.unauthorized');
      return;
    }
    try {
      if (req.method === 'GET' && (url.pathname === '/api/state' || url.pathname === '/api/probe')) {
        const probe = await readProbe({ fresh: url.pathname === '/api/probe' && url.searchParams.get('fresh') === '1' });
        if (url.pathname === '/api/probe') {
          sendJson(res, 200, probe);
          return;
        }
        sendJson(res, 200, { probe, sessions: store.list().map((session) => summary(session, inspector)) });
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
        const position = Number(entryMatch[2]) - session.droppedEntries;
        const resolved = position < 0 ? {} : dash.resolveWindowEntry(session.entries, position);
        if (!resolved.detail) return sendError(res, req, 404, 'entry.notFound');
        sendJson(res, 200, { detail: resolved.detail });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/sessions') {
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
        try {
          const session = await openTunnel(payload.origin, payload.options);
          sendJson(res, 201, { session: summary(session, inspector) });
        } catch (error) {
          sendError(res, req, error.status || 500, error, null, error.extra);
        }
        return;
      }

      const requestsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/requests(?:\/(\d+)(\/replay)?)?$/);
      if (requestsMatch) {
        const id = decodeURIComponent(requestsMatch[1]);
        const seq = requestsMatch[2] == null ? null : Number(requestsMatch[2]);
        const replay = !!requestsMatch[3];
        if (!store.get(id)) return sendError(res, req, 404, 'session.notFound');
        if (!inspector.has(id)) return sendError(res, req, 409, 'inspect.disabled');
        if (req.method === 'GET' && seq == null) {
          const since = url.searchParams.get('version');
          const version = inspector.info(id).version;
          if (since != null && Number(since) === version) return sendJson(res, 200, { version, unchanged: true });
          return sendJson(res, 200, inspector.list(id));
        }
        if (req.method === 'DELETE' && seq == null) {
          inspector.clear(id);
          return sendJson(res, 200, { ok: true });
        }
        try {
          if (req.method === 'GET' && !replay) return sendJson(res, 200, { request: inspector.get(id, seq) });
          if (req.method === 'POST' && replay) return sendJson(res, 201, { request: await inspector.replay(id, seq) });
        } catch (error) {
          const status = error.code === 'NOT_FOUND' ? 404 : error.code === 'CONFLICT' ? 409 : 500;
          return sendError(res, req, status, error);
        }
        return sendError(res, req, 405, 'request.methodNotAllowed');
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
        sendJson(res, 200, { session: summary(session, inspector) });
        return;
      }

      const stopMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/stop$/);
      if (req.method === 'POST' && stopMatch) {
        const id = decodeURIComponent(stopMatch[1]);
        if (!store.get(id)) return sendError(res, req, 404, 'session.notFound');
        stopProcess(processes.get(id)).catch(() => {});
        processes.delete(id);
        const session = store.stop(id);
        sendJson(res, 200, { ok: true, session: summary(session, inspector) });
        return;
      }

      const delMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
      if (req.method === 'DELETE' && delMatch) {
        const id = decodeURIComponent(delMatch[1]);
        if (!store.get(id)) return sendError(res, req, 404, 'session.notFound');
        stopProcess(processes.get(id)).catch(() => {});
        processes.delete(id);
        store.remove(id);
        await inspector.close(id);
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
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    handle(req, res).catch((error) => {
      if (!res.headersSent) sendError(res, req, 500, error);
    });
  });

  return {
    server,
    store,
    inspector,
    openTunnel,
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
      // Cookies ignore the port: two dashboards on one machine keep separate ones.
      cookieName = `trydash_${address.port}`;
      this.url = `http://${host}:${address.port}`;
      return this.url;
    },
    async close() {
      sampler.stop();
      // Real children get their SIGTERM, then SIGKILL; the dashboard waits for them, within a limit.
      const exits = Array.from(processes.values()).map((proc) => {
        const done = stopProcess(proc);
        return proc.spawnfile ? done : Promise.resolve();
      });
      processes.clear();
      let limit;
      await Promise.race([
        Promise.all(exits),
        new Promise((resolve) => { limit = setTimeout(resolve, KILL_AFTER_MS + 1000); }),
      ]);
      clearTimeout(limit);
      await inspector.closeAll();
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

export async function main(argv = process.argv.slice(2), env = process.env) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(`trydash: ${error.message}\n\n${helpText()}`);
    process.exitCode = 2;
    return null;
  }
  if (args.version) {
    console.log(`trydash ${appVersion()}`);
    return null;
  }
  if (args.help) {
    console.log(helpText());
    return null;
  }
  const token = env.TRYDASH_TOKEN || newToken();
  const app = createApp({ token });
  if (envValue(env, 'TRYDASH_SEED') === '1') await seedInspector(app.inspector, seedFixture(app.store));
  const port = args.port != null ? args.port : Number(envValue(env, 'TRYDASH_PORT') || 8787);
  const url = await app.listen(port, '127.0.0.1');
  const link = `${url}/?token=${token}`;
  console.log(`trydash ${appVersion()}  ${link}`);
  console.log(`probe ${envValue(env, 'TRYDASH_PROBE') || 'auto'}`);
  const shutdown = () => {
    app.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  if (args.target) {
    try {
      const session = await app.openTunnel(args.target.origin, args.target.options);
      announceUrl(app.store, session.id);
    } catch (error) {
      console.error(`trydash: ${error.message}`);
    }
  }
  // Only for a person at a terminal: CI and tests never get a browser window.
  const open = args.open != null ? args.open : !!process.stdout.isTTY && envValue(env, 'TRYDASH_OPEN') !== '0';
  if (open) openBrowser(link);
  return app;
}

if (isDirectRun()) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}
