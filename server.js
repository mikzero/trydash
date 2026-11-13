import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadDashboard } from './src/load-dashboard.js';
import { spawnForSession, stopProcess, signalProcess, KILL_AFTER_MS } from './src/runtime.js';
import { createTrafficSampler } from './src/traffic.js';
import { createInspector } from './src/inspector.js';
import { resolveFolder, bareFolder } from './src/static.js';
import { parseArgs, helpText, envValue, openBrowser, announceUrl } from './src/cli.js';
import { createConfigFile, defaultConfigPath, tunnelKey } from './src/config.js';
import { scanPorts, deepScan, formatScan } from './src/ports.js';
import { createCollection } from './src/collection.js';
import { parseImport, toPostman, toHar } from './src/formats.js';
import { readAsset } from './src/assets.js';
import { newKey, newId, checkPin, pinHash, publicLink, savedLink } from './src/links.js';
import { createShooter } from './src/shots.js';


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

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
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
// TRYDASH_CHROME_ARGS: more flags for the screenshot browser, as a JSON array or space-separated.
export function chromeArgs(text) {
  const value = String(text || '').trim();
  if (!value) return [];
  if (value.startsWith('[')) {
    try {
      const list = JSON.parse(value);
      return Array.isArray(list) ? list.map(String) : [];
    } catch {
      return [];
    }
  }
  return value.split(/\s+/);
}

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
  if (info) return { enabled: true, count: info.count, total: info.total, version: info.version, target: info.target, queued: info.queued || 0 };
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
    expiresAt: session.expiresAt,
    localRedirect: session.localRedirect,
    expired: session.expired,
    links: (session.links || []).map(publicLink),
    comments: {
      open: (session.comments || []).filter((c) => !c.resolved).length,
      total: (session.comments || []).length,
      version: session.commentsVersion || 0,
    },
    ownerKey: session.ownerKey || null,
    inspect: inspectState(session, inspector),
  };
}

export function seedFixture(store, file) {
  const text = file ? fs.readFileSync(file, 'utf8') : readAsset('test/fixtures/quick-tunnel.log').toString('utf8');
  const session = store.create('http://127.0.0.1:8080');
  store.appendChunk(session.id, text);
  // Sample traffic so the strip and sparkline show without a real tunnel.
  // As many samples as the sparkline holds, so it is drawn end to end.
  for (let i = 0; i < 150; i += 1) {
    store.recordTraffic(session.id, {
      inflight: Math.round(8 + 6 * Math.sin(i / 6) + 3 * Math.sin(i / 2.3)),
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
  // Where relative folders start: the folder trydash was started from.
  const cwd = options.cwd || process.cwd();
  const processes = new Map();
  let shuttingDown = false;
  let closePromise = null;
  const trackedChildren = [];
  // A stopped tunnel's proxy turns traffic away at once, even before cloudflared has exited.
  const inspector = options.inspector || createInspector({
    store,
    isLive: (id) => !!(store.get(id) && store.get(id).active),
    onComment: (id, comment, kind) => {
      if (kind === 'add') shootComment(id, comment.id);
      if (kind === 'delete') dropShot(comment.id);
      saveTunnels();
    },
    onFirstVisit: () => saveTunnels(),
  });
  const sampler = createTrafficSampler({
    store,
    fetchImpl: options.fetch || fetch,
    intervalMs: options.trafficIntervalMs || 2000,
  });
  let probeCache = null;
  const scan = options.scanPorts || scanPorts;
  const deep = options.deepScan || deepScan;
  // What the last scan found on each port, kept while the same process holds it.
  const identified = new Map();
  let deepInflight = null;
  // Saved requests; main() gives them a file next to the saved tunnels.
  const collection = options.collection || createCollection();
  // Screenshots of the commented pages: next to the saved tunnels, or in a temporary folder.
  const shooter = options.shooter || createShooter({ extraArgs: chromeArgs(process.env.TRYDASH_CHROME_ARGS) });
  const shotsDir = options.shotsDir || (options.persist && options.persist.file
    ? path.join(path.dirname(options.persist.file), 'shots')
    : path.join(os.tmpdir(), `trydash-shots-${process.pid}`));

  function shotFile(commentId) {
    return /^c[0-9a-f]{10}$/.test(commentId) ? path.join(shotsDir, `${commentId}.png`) : null;
  }

  function dropShot(commentId) {
    const file = shotFile(commentId);
    if (file) {
      try { fs.rmSync(file, { force: true }); } catch { /* already gone */ }
    }
  }

  // The page as the client saw it: their screen size, the pin and its bubble open. Through the
  // public URL with the owner's key, so it is what anyone with the link gets.
  function shootComment(id, commentId) {
    const session = store.get(id);
    if (!session) return Promise.resolve(null);
    const comment = session.comments.find((c) => c.id === commentId);
    if (!comment) return Promise.resolve(null);
    if (!shooter.available) {
      store.setCommentShot(id, commentId, { state: 'off', at: new Date().toISOString() });
      return Promise.resolve(null);
    }
    if (!session.url || !session.active) {
      store.setCommentShot(id, commentId, { state: 'failed', reason: 'no-url', at: new Date().toISOString() });
      return Promise.resolve(null);
    }
    const sep = comment.page.includes('?') ? '&' : '?';
    const key = session.ownerKey ? `${sep}tdk=${encodeURIComponent(session.ownerKey)}` : '';
    const lang = comment.lang ? `&trydash-lang=${comment.lang}` : '';
    const url = `${session.url.replace(/\/+$/, '')}${comment.page}${key}#trydash-comment=${comment.id}&trydash-shot=1${lang}`;
    store.setCommentShot(id, commentId, { state: 'pending', at: new Date().toISOString() });
    return shooter.take({ url, viewport: comment.viewport, file: shotFile(commentId) }).then((size) => {
      store.setCommentShot(id, commentId, { state: 'ready', at: new Date().toISOString(), width: size.width, height: size.height });
      saveTunnels();
    }, (error) => {
      store.setCommentShot(id, commentId, { state: 'failed', reason: 'browser', detail: String(error.message || error).slice(0, 200), at: new Date().toISOString() });
    });
  }
  let portsCache = null;
  let portsInflight = null;

  // Ports of dev servers on this machine: cached a few seconds, one scan at a time.
  function ownPorts() {
    return [server.address() && server.address().port].concat(store.list().map((s) => inspector.info(s.id)).filter(Boolean).map((i) => i.port)).filter(Boolean);
  }

  // A full scan: every port asked `GET /` once. Only on request, one at a time.
  async function scanAll() {
    if (!deepInflight) {
      deepInflight = deep({ exclude: ownPorts() }).then((list) => {
        identified.clear();
        for (const item of list) identified.set(item.port, { process: item.process, scan: item.scan });
        portsCache = null;
        return list;
      }).finally(() => { deepInflight = null; });
    }
    await deepInflight;
    return listeningPorts();
  }

  async function listeningPorts() {
    if (portsCache && Date.now() - portsCache.at < 3000) return withBusy(portsCache.ports);
    if (!portsInflight) {
      const own = ownPorts();
      portsInflight = scan({ exclude: own, all: true }).then((ports) => {
        portsCache = { at: Date.now(), ports };
        return ports;
      }).finally(() => { portsInflight = null; });
    }
    return withBusy(await portsInflight);
  }

  function withBusy(found) {
    // Scan results stay on their port while the same process listens there. A quiet port
    // (high, or usually not web) shows only once a scan found a web server on it.
    const ports = [];
    for (const { quiet, ...item } of found) {
      const known = identified.get(item.port);
      const scanned = known && known.process === item.process ? known.scan : null;
      if (quiet && !(scanned && scanned.http)) continue;
      ports.push(scanned ? { ...item, scan: scanned } : item);
    }
    // A port an active tunnel already points at is marked, not hidden.
    const busy = new Set(store.list().filter((s) => s.active && s.origin).map((s) => {
      try {
        const u = new URL(s.origin);
        return Number(u.port || (u.protocol === 'https:' ? 443 : 80));
      } catch {
        return null;
      }
    }));
    return ports.map((item) => ({ ...item, busy: busy.has(item.port) }));
  }
  let expiryTimer = null;

  // Stops the tunnels whose expiry has come, like the Stop button.
  function expireDue(nowMs = Date.now()) {
    for (const session of store.dueToExpire(nowMs)) {
      stopProcess(processes.get(session.id)).catch(() => {});
      processes.delete(session.id);
      store.expire(session.id);
    }
  }
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

  // Saved tunnels (createConfigFile): written when one is created or removed.
  const persist = options.persist || null;

  function saveTunnels() {
    if (persist) {
      persist.save(store.list().map((session) => ({
        origin: session.origin,
        options: session.options,
        ownerKey: session.ownerKey || null,
        links: (session.links || []).map(savedLink),
        comments: session.comments || [],
      })));
    }
  }

  // What a tunnel is once normalized: the same shape as a saved one.
  function describeTunnel(origin, rawOptions) {
    let wanted = rawOptions && typeof rawOptions === 'object' ? rawOptions : {};
    // `site` in the origin field is the folder ./site when that exists, not http://site.
    const bare = !wanted.mode || wanted.mode === 'origin' ? bareFolder(origin, cwd) : null;
    if (bare) {
      wanted = { ...wanted, mode: 'folder', folder: bare };
      origin = '';
    }
    // A folder must exist now; the stored path is absolute, with `~` and symlinks resolved.
    const resolved = wanted.mode === 'folder' ? { ...wanted, folder: resolveFolder(wanted.folder, cwd) } : wanted;
    const invocation = dash.buildQuickTunnelCommand(origin, resolved);
    return { origin: invocation.origin, options: invocation.options };
  }

  // Saved tunnels come back stopped: nothing turns public without a click.
  function restoreTunnels(list) {
    const restored = [];
    for (const item of list || []) {
      if (store.list().length >= MAX_SESSIONS) break;
      let session;
      try {
        const wanted = describeTunnel(item.origin, item.options);
        session = store.create(wanted.origin, wanted.options);
      } catch (error) {
        console.error(`trydash: saved tunnel skipped (${error.message})`);
        continue;
      }
      // The personal links keep their keys: the same ?tdk= works on the new URL.
      store.setOwnerKey(session.id, typeof item.ownerKey === 'string' && item.ownerKey ? item.ownerKey : newKey());
      for (const link of Array.isArray(item.links) ? item.links : []) {
        try { store.addLink(session.id, link); } catch { /* a broken entry is left out */ }
      }
      for (const comment of Array.isArray(item.comments) ? item.comments : []) {
        if (!comment || typeof comment !== 'object' || !/^c[0-9a-f]{10}$/.test(String(comment.id)) || typeof comment.text !== 'string') continue;
        try { store.addComment(session.id, comment); } catch { break; }
      }
      store.stop(session.id);
      store.appendChunk(session.id, JSON.stringify({ level: 'info', message: 'restored from the saved tunnels: Restart starts it' }));
      restored.push(session);
    }
    return restored;
  }

  // Restarts a stopped or exited tunnel; a restored one gets its inspector here.
  function stillUp(id) {
    const current = store.get(id);
    return !shuttingDown && current && current.active;
  }

  // Why a tunnel that was starting must not go on: trydash is closing (503), it was
  // removed (404), or it was stopped meanwhile (409).
  function startAborted(id) {
    if (shuttingDown) return withStatus(dash.appError('UNAVAILABLE', 'server.closing'), 503);
    if (!store.get(id)) return withStatus(dash.appError('NOT_FOUND', 'session.removedWhileStarting'), 404);
    return withStatus(dash.appError('CONFLICT', 'session.stoppedWhileStarting'), 409);
  }

  async function restartTunnel(id) {
    if (shuttingDown) throw withStatus(dash.appError('UNAVAILABLE', 'server.closing'), 503);
    if (!store.get(id)) throw withStatus(dash.appError('NOT_FOUND', 'session.notFound'), 404);
    let session;
    try {
      session = store.restart(id);
    } catch (error) {
      throw withStatus(error, error.code === 'CONFLICT' ? 409 : 500);
    }
    let spawned;
    let openedInspector = false;
    try {
      // Stop or delete can win while the inspector is opening. Nothing may spawn after that.
      if (session.options.inspect && !inspector.has(id)) {
        const target = await inspector.open(session);
        openedInspector = true;
        if (!stillUp(id)) throw startAborted(id);
        store.setTarget(id, target);
      }
      if (!stillUp(id)) throw startAborted(id);
      spawned = spawnForSession(store, session, spawnImpl, isCurrent);
      if (!stillUp(id)) {
        stopProcess(spawned.proc).catch(() => {});
        throw startAborted(id);
      }
    } catch (error) {
      if (openedInspector && !stillUp(id)) await inspector.close(id);
      if (store.get(id)?.active) store.markExited(id, null);
      throw error.status ? error : withStatus(error, 500);
    }
    attach(id, spawned.proc, spawned.done);
    return session;
  }

  // Creates and starts a tunnel: from POST /api/sessions and from the command line.
  // Errors carry the HTTP status they map to.
  async function openTunnel(origin, rawOptions) {
    if (shuttingDown) throw withStatus(dash.appError('UNAVAILABLE', 'server.closing'), 503);
    const probe = await readProbe();
    if (shuttingDown) throw withStatus(dash.appError('UNAVAILABLE', 'server.closing'), 503);
    if (dash.viewForProbe(probe).phase !== 'workspace') {
      throw withStatus(dash.appError('UNAVAILABLE', 'cloudflared.unavailable'), 409, { phase: 'install' });
    }
    if (store.list().length >= MAX_SESSIONS) {
      throw withStatus(dash.appError('LIMIT', 'session.tooMany', { max: MAX_SESSIONS }), 429);
    }
    let session;
    try {
      const wanted = describeTunnel(origin, rawOptions);
      session = store.create(wanted.origin, wanted.options);
      store.setOwnerKey(session.id, newKey());
    } catch (error) {
      throw withStatus(error, error.code === 'BAD_ORIGIN' || error.code === 'BAD_OPTIONS' ? 400 : 500);
    }
    let spawned;
    try {
      if (session.options.inspect) {
        const target = await inspector.open(session);
        if (shuttingDown || !store.get(session.id)) throw startAborted(session.id);
        store.setTarget(session.id, target);
      }
      if (shuttingDown || !store.get(session.id)) throw startAborted(session.id);
      spawned = spawnForSession(store, session, spawnImpl, isCurrent);
      if (shuttingDown || !store.get(session.id)) {
        stopProcess(spawned.proc).catch(() => {});
        throw startAborted(session.id);
      }
    } catch (error) {
      await inspector.close(session.id);
      if (store.get(session.id)) store.remove(session.id);
      throw error.status ? error : withStatus(error, 500);
    }
    attach(session.id, spawned.proc, spawned.done);
    saveTunnels();
    return session;
  }

  // The address a saved request is shown against: the public URL, else the local one.
  function baseUrlOf(session) {
    if (!session) return 'http://127.0.0.1:3000';
    if (session.url) return session.url;
    if (session.origin) {
      const u = new URL(session.origin);
      return `${u.protocol}//${u.host}`;
    }
    const info = inspector.info(session.id);
    return info ? info.target : 'http://127.0.0.1:3000';
  }

  function sendDownload(res, name, data) {
    const payload = `${JSON.stringify(data, null, 2)}\n`;
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
  }

  function savedSummary(item) {
    return {
      id: item.id,
      name: item.name,
      method: item.method,
      path: item.path,
      source: item.source,
      createdAt: item.createdAt,
      headerCount: item.headers.length,
      bodySize: item.bodyBase64 ? Buffer.from(item.bodyBase64, 'base64').length : Buffer.byteLength(item.body || ''),
    };
  }

  async function readJson(req, limit) {
    let text;
    try {
      text = await readBody(req, limit);
    } catch (error) {
      throw withStatus(error, error.status || 400);
    }
    try {
      const data = JSON.parse(text || '{}');
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('shape');
      return data;
    } catch {
      throw withStatus(dash.appError('BAD_REQUEST', 'request.badJson'), 400);
    }
  }

  function statusFor(error) {
    if (error.status) return error.status;
    if (error.code === 'NOT_FOUND') return 404;
    if (error.code === 'CONFLICT') return 409;
    if (error.code === 'LIMIT') return 429;
    if (error.code === 'BAD_REQUEST') return 400;
    return 500;
  }

  // /api/collection…: saved requests, import, export, send; and a tunnel's export.
  async function handleCollection(req, res, url) {
    try {
      const exportMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/requests\/export$/);
      if (exportMatch) {
        if (req.method !== 'GET') return sendError(res, req, 405, 'request.methodNotAllowed');
        const session = store.get(decodeURIComponent(exportMatch[1]));
        if (!session) return sendError(res, req, 404, 'session.notFound');
        if (!inspector.has(session.id)) return sendError(res, req, 409, 'inspect.disabled');
        const details = inspector.details(session.id);
        const baseUrl = baseUrlOf(session);
        if (url.searchParams.get('format') === 'har') {
          return sendDownload(res, `trydash-${session.id}.har`, toHar(details, { baseUrl, version: appVersion() }));
        }
        const requests = details.filter((d) => !d.websocket).map((d) => ({
          name: `${d.method} ${d.path}`,
          method: d.method,
          path: d.path,
          headers: d.requestHeaders,
          body: d.requestBody && d.requestBody.text != null && !d.requestBody.truncated ? d.requestBody.text : null,
        }));
        return sendDownload(res, `trydash-${session.id}.postman_collection.json`, toPostman(requests, { name: `trydash ${session.id}`, baseUrl }));
      }
      if (url.pathname === '/api/collection') {
        if (req.method === 'GET') return sendJson(res, 200, { requests: collection.list().map(savedSummary), file: collection.file || null });
        if (req.method !== 'POST') return sendError(res, req, 405, 'request.methodNotAllowed');
        const data = await readJson(req);
        let item;
        if (data.session != null) {
          // Pin a captured request from a tunnel's Requests tab.
          const session = store.get(String(data.session));
          if (!session) return sendError(res, req, 404, 'session.notFound');
          if (!inspector.has(session.id)) return sendError(res, req, 409, 'inspect.disabled');
          const request = inspector.captured(session.id, Number(data.seq));
          item = collection.add({ ...request, name: data.name }, 'captured');
        } else {
          item = collection.add(data.request || {}, 'manual');
        }
        return sendJson(res, 201, { request: item });
      }
      if (url.pathname === '/api/collection/import') {
        if (req.method !== 'POST') return sendError(res, req, 405, 'request.methodNotAllowed');
        const data = await readJson(req, 5_000_000);
        const parsed = parseImport(data.text, data.format || 'auto');
        const lang = dash.pickLang(req.headers['accept-language']);
        const warnings = parsed.warnings.map((w) => dash.t(w.key, w.params, lang));
        if (!parsed.requests.length) return sendError(res, req, 400, 'collection.empty', {}, { warnings });
        const added = collection.addMany(parsed.requests, parsed.format);
        return sendJson(res, 201, { format: parsed.format, added: added.length, warnings, requests: added.map(savedSummary) });
      }
      if (url.pathname === '/api/collection/export') {
        if (req.method !== 'GET') return sendError(res, req, 405, 'request.methodNotAllowed');
        const session = url.searchParams.get('session') ? store.get(url.searchParams.get('session')) : null;
        return sendDownload(res, 'trydash.postman_collection.json', toPostman(collection.list(), { name: 'trydash', baseUrl: baseUrlOf(session) }));
      }
      const itemMatch = url.pathname.match(/^\/api\/collection\/([^/]+)(\/send)?$/);
      if (!itemMatch) return sendError(res, req, 404, 'collection.notFound');
      const id = decodeURIComponent(itemMatch[1]);
      if (itemMatch[2]) {
        if (req.method !== 'POST') return sendError(res, req, 405, 'request.methodNotAllowed');
        const data = await readJson(req);
        const item = collection.get(id);
        const session = store.get(String(data.session || ''));
        if (!session) return sendError(res, req, 404, 'session.notFound');
        if (!inspector.has(session.id)) return sendError(res, req, 409, 'inspect.disabled');
        return sendJson(res, 201, { request: await inspector.send(session.id, item, item.name) });
      }
      if (req.method === 'GET') return sendJson(res, 200, { request: collection.get(id) });
      if (req.method === 'PATCH') return sendJson(res, 200, { request: collection.update(id, await readJson(req)) });
      if (req.method === 'DELETE') {
        collection.remove(id);
        return sendJson(res, 200, { ok: true });
      }
      return sendError(res, req, 405, 'request.methodNotAllowed');
    } catch (error) {
      return sendError(res, req, statusFor(error), error);
    }
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

      if (url.pathname === '/api/collection' || url.pathname.startsWith('/api/collection/')
        || /^\/api\/sessions\/[^/]+\/requests\/export$/.test(url.pathname)) {
        await handleCollection(req, res, url);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/ports') {
        sendJson(res, 200, { ports: url.searchParams.get('scan') === '1' ? await scanAll() : await listeningPorts() });
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

      // A comment's screenshot: the PNG, or POST to take it again.
      const shotMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/comments\/(c[0-9a-f]{10})\/screenshot$/);
      if (shotMatch) {
        const id = decodeURIComponent(shotMatch[1]);
        const session = store.get(id);
        const comment = session && session.comments.find((c) => c.id === shotMatch[2]);
        if (!comment) return sendError(res, req, 404, 'comments.notFound');
        if (req.method === 'POST') {
          shootComment(id, comment.id);
          return sendJson(res, 202, { shot: comment.shot || null });
        }
        if (req.method !== 'GET') return sendError(res, req, 405, 'request.methodNotAllowed');
        let png;
        try { png = fs.readFileSync(shotFile(comment.id)); } catch { return sendError(res, req, 404, 'comments.noShot'); }
        res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'image/png', 'Content-Length': png.length, 'Cache-Control': 'private, no-cache' });
        res.end(png);
        return;
      }

      // Comments clients left on the pages: list, resolve or reopen, delete.
      const commentsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/comments(?:\/([^/]+))?$/);
      if (commentsMatch) {
        const id = decodeURIComponent(commentsMatch[1]);
        const commentId = commentsMatch[2] == null ? null : decodeURIComponent(commentsMatch[2]);
        const session = store.get(id);
        if (!session) return sendError(res, req, 404, 'session.notFound');
        try {
          if (req.method === 'GET' && !commentId) {
            const since = url.searchParams.get('version');
            if (since != null && Number(since) === session.commentsVersion) return sendJson(res, 200, { version: session.commentsVersion, unchanged: true });
            const shown = session.comments.slice().reverse().map(({ editHash, ...comment }) => comment);
            return sendJson(res, 200, { version: session.commentsVersion, comments: shown });
          }
          if (req.method === 'PATCH' && commentId) {
            const body = await readJson(req);
            const comment = store.setCommentResolved(id, commentId, !!body.resolved);
            saveTunnels();
            return sendJson(res, 200, { comment });
          }
          if (req.method === 'DELETE' && commentId) {
            store.removeComment(id, commentId);
            dropShot(commentId);
            saveTunnels();
            return sendJson(res, 200, { ok: true });
          }
        } catch (error) {
          return sendError(res, req, error.status || (error.code === 'NOT_FOUND' ? 404 : error.code === 'BAD_REQUEST' ? 400 : 500), error);
        }
        return sendError(res, req, 405, 'request.methodNotAllowed');
      }

      // Personal links: create, rename, revoke, set or clear the PIN, delete.
      const linksMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/links(?:\/([^/]+))?$/);
      if (linksMatch) {
        const id = decodeURIComponent(linksMatch[1]);
        const linkId = linksMatch[2] == null ? null : decodeURIComponent(linksMatch[2]);
        if (!store.get(id)) return sendError(res, req, 404, 'session.notFound');
        const fail = (error) => sendError(res, req, error.status || (error.code === 'NOT_FOUND' ? 404 : error.code === 'LIMIT' ? 429 : error.code === 'BAD_REQUEST' ? 400 : 500), error);
        try {
          if (req.method === 'GET' && !linkId) return sendJson(res, 200, { links: store.get(id).links.map(publicLink) });
          if (req.method === 'POST' && !linkId) {
            const body = await readJson(req);
            const pin = checkPin(body.pin);
            const key = newKey();
            const link = store.addLink(id, { id: newId(), name: body.name, key, pinHash: pin ? pinHash(key, pin) : null });
            saveTunnels();
            return sendJson(res, 201, { link: publicLink(link) });
          }
          if (req.method === 'PATCH' && linkId) {
            const body = await readJson(req);
            const patch = {};
            if (body.name != null) patch.name = body.name;
            if (body.revoked != null) patch.revoked = !!body.revoked;
            if (Object.prototype.hasOwnProperty.call(body, 'pin')) {
              const pin = checkPin(body.pin);
              patch.pinHash = pin ? pinHash(store.getLink(id, linkId).key, pin) : null;
            }
            const link = store.updateLink(id, linkId, patch);
            saveTunnels();
            return sendJson(res, 200, { link: publicLink(link) });
          }
          if (req.method === 'DELETE' && linkId) {
            store.removeLink(id, linkId);
            saveTunnels();
            return sendJson(res, 200, { ok: true });
          }
        } catch (error) {
          return fail(error);
        }
        return sendError(res, req, 405, 'request.methodNotAllowed');
      }

      // The requests waiting for the origin: deliver now, or drop them.
      const queueMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/queue(\/deliver)?$/);
      if (queueMatch) {
        const id = decodeURIComponent(queueMatch[1]);
        if (!store.get(id)) return sendError(res, req, 404, 'session.notFound');
        if (!inspector.has(id)) return sendError(res, req, 409, 'inspect.disabled');
        if (req.method === 'POST' && queueMatch[2]) return sendJson(res, 200, await inspector.deliverQueue(id));
        if (req.method === 'DELETE' && !queueMatch[2]) return sendJson(res, 200, inspector.dropQueue(id));
        return sendError(res, req, 405, 'request.methodNotAllowed');
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
          if (req.method === 'POST' && replay) {
            // An optional body edits the request before it goes: { method, path, headers, body }.
            let edits = null;
            const text = await readBody(req);
            if (text.trim()) {
              try {
                edits = JSON.parse(text);
              } catch {
                return sendError(res, req, 400, 'request.badJson');
              }
              if (!edits || typeof edits !== 'object' || Array.isArray(edits)) return sendError(res, req, 400, 'request.badJson');
            }
            return sendJson(res, 201, { request: await inspector.replay(id, seq, edits) });
          }
        } catch (error) {
          const status = error.status || (error.code === 'NOT_FOUND' ? 404 : error.code === 'CONFLICT' ? 409 : error.code === 'BAD_REQUEST' ? 400 : 500);
          return sendError(res, req, status, error);
        }
        return sendError(res, req, 405, 'request.methodNotAllowed');
      }

      const optionsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/options$/);
      if (optionsMatch) {
        if (req.method !== 'PATCH') return sendError(res, req, 405, 'request.methodNotAllowed');
        const id = decodeURIComponent(optionsMatch[1]);
        if (!store.get(id)) return sendError(res, req, 404, 'session.notFound');
        let patch;
        try {
          patch = await readJson(req);
        } catch (error) {
          return sendError(res, req, statusFor(error), error);
        }
        try {
          const session = store.updatePreview(id, patch);
          saveTunnels();
          return sendJson(res, 200, { session: summary(session, inspector) });
        } catch (error) {
          return sendError(res, req, error.code === 'CONFLICT' ? 409 : error.code === 'BAD_OPTIONS' ? 400 : 500, error);
        }
      }

      const restartMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/restart$/);
      if (req.method === 'POST' && restartMatch) {
        try {
          const session = await restartTunnel(decodeURIComponent(restartMatch[1]));
          sendJson(res, 200, { session: summary(session, inspector) });
        } catch (error) {
          sendError(res, req, error.status || 500, error);
        }
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
        for (const comment of store.get(id).comments || []) dropShot(comment.id);
        store.remove(id);
        await inspector.close(id);
        saveTunnels();
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
    collection,
    restartTunnel,
    restoreTunnels,
    describeTunnel,
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
      expiryTimer = setInterval(() => expireDue(), options.expiryIntervalMs || 1000);
      expiryTimer.unref?.();
      const address = server.address();
      // Cookies ignore the port: two dashboards on one machine keep separate ones.
      cookieName = `trydash_${address.port}`;
      this.url = `http://${host}:${address.port}`;
      return this.url;
    },
    expireDue,
    async close() {
      // A second call must not resolve early: it kills the children now and waits for the same shutdown.
      if (closePromise) {
        for (const proc of trackedChildren) {
          if (proc.exitCode == null && proc.signalCode == null && !proc.killed) signalProcess(proc, 'SIGKILL');
        }
        for (const proc of processes.values()) {
          if (proc.exitCode == null && proc.signalCode == null && !proc.killed) signalProcess(proc, 'SIGKILL');
        }
        return closePromise;
      }
      shuttingDown = true;
      trackedChildren.push(...processes.values());
      closePromise = (async () => {
        sampler.stop();
        clearInterval(expiryTimer);
        const waitFor = (list) => {
          const exits = list.map((proc) => {
            const done = stopProcess(proc);
            return proc.spawnfile ? done : Promise.resolve();
          });
          let limit;
          return Promise.race([
            Promise.all(exits),
            new Promise((resolve) => { limit = setTimeout(resolve, KILL_AFTER_MS + 1000); }),
          ]).finally(() => clearTimeout(limit));
        };
        const first = trackedChildren.slice();
        processes.clear();
        await waitFor(first);
        const late = Array.from(processes.values());
        processes.clear();
        trackedChildren.push(...late);
        if (late.length) await waitFor(late);
        await inspector.closeAll();
        if (!server.listening) return;
        await new Promise((resolve) => server.close(resolve));
      })();
      return closePromise;
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
  if (args.scan) {
    console.log(formatScan(await deepScan(), loadDashboard().BLOCK_PRESETS));
    return null;
  }
  const token = env.TRYDASH_TOKEN || newToken();
  const seed = envValue(env, 'TRYDASH_SEED') === '1';
  // The sample session of TRYDASH_SEED must not end up in the saved tunnels.
  const saving = args.save !== false && env.TRYDASH_CONFIG !== 'off' && !seed;
  const persist = saving ? createConfigFile(env.TRYDASH_CONFIG || defaultConfigPath({ env })) : null;
  // Saved requests sit next to the saved tunnels, and are off when those are.
  const collection = createCollection({ file: persist ? path.join(path.dirname(persist.file), 'requests.json') : null });
  const app = createApp({ token, persist, collection });
  if (seed) await seedInspector(app.inspector, seedFixture(app.store));
  const restored = persist ? app.restoreTunnels(persist.load()) : [];
  const port = args.port != null ? args.port : Number(envValue(env, 'TRYDASH_PORT') || 8787);
  const url = await app.listen(port, '127.0.0.1');
  const link = `${url}/?token=${token}`;
  console.log(`trydash ${appVersion()}  ${link}`);
  console.log(`probe ${envValue(env, 'TRYDASH_PROBE') || 'auto'}`);
  if (restored.length) console.log(`${restored.length} saved tunnel(s) restored, stopped: ${persist.file}`);
  const shutdown = () => {
    app.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  if (args.target) {
    try {
      // The same tunnel saved from an earlier run is restarted instead of doubled.
      const key = tunnelKey(app.describeTunnel(args.target.origin, args.target.options));
      const same = restored.find((item) => tunnelKey(item) === key);
      const session = same
        ? await app.restartTunnel(same.id)
        : await app.openTunnel(args.target.origin, args.target.options);
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
