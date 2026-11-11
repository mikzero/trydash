// Request inspector: a small HTTP proxy on 127.0.0.1 for each tunnel. cloudflared
// connects to it instead of the origin; it forwards every request unchanged and
// keeps a copy of the latest ones (headers and the first bytes of each body) so
// the dashboard can show and replay them. Nothing is written to disk.

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { planStatic } from './static.js';

export const KEEP = 200;
export const REQUEST_BODY_CAP = 256 * 1024;
export const RESPONSE_BODY_CAP = 64 * 1024;
const DECODED_CAP = 1024 * 1024;
const REPLAY_TIMEOUT_MS = 30000;
export const REPLAY_HEADER = 'x-trydash-replay';
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

function appError(code, key) {
  return Object.assign(new Error(key), { code, key, params: {} });
}

// Headers for the next hop: hop-by-hop ones (and those Connection names) stay behind.
export function forwardHeaders(headers, { upgrade = false } = {}) {
  const named = String(headers.connection || '').toLowerCase().split(',').map((v) => v.trim()).filter(Boolean);
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (key === REPLAY_HEADER) continue;
    if (HOP_BY_HOP.has(key) || named.includes(key)) continue;
    out[key] = value;
  }
  if (upgrade && headers.upgrade) {
    out.connection = 'Upgrade';
    out.upgrade = headers.upgrade;
  }
  return out;
}

function pairs(rawHeaders) {
  const list = [];
  for (let i = 0; i + 1 < (rawHeaders || []).length; i += 2) {
    if (rawHeaders[i].toLowerCase() === REPLAY_HEADER) continue;
    list.push([rawHeaders[i], rawHeaders[i + 1]]);
  }
  return list;
}

function headerValue(list, name) {
  const wanted = name.toLowerCase();
  const found = list.find(([key]) => key.toLowerCase() === wanted);
  return found ? found[1] : '';
}

function newBody(cap) {
  return { chunks: [], size: 0, kept: 0, cap };
}

function take(body, chunk) {
  body.size += chunk.length;
  if (body.kept >= body.cap) return;
  const room = body.cap - body.kept;
  const part = chunk.length <= room ? Buffer.from(chunk) : Buffer.from(chunk.subarray(0, room));
  body.chunks.push(part);
  body.kept += part.length;
}

const TEXT_TYPE = /^(text\/|application\/([\w.+-]*\+)?(json|xml|javascript|ecmascript|x-www-form-urlencoded|graphql|x-ndjson|yaml|x-yaml)\b)|^image\/svg\+xml/i;
const BINARY_TYPE = /^(image|audio|video|font)\/|^application\/(octet-stream|pdf|zip|gzip|x-protobuf|protobuf|wasm|grpc)/i;

function decompress(buffer, encoding) {
  const opts = { maxOutputLength: DECODED_CAP };
  if (encoding === 'gzip' || encoding === 'x-gzip') return zlib.gunzipSync(buffer, opts);
  if (encoding === 'br') return zlib.brotliDecompressSync(buffer, opts);
  if (encoding === 'deflate') {
    try {
      return zlib.inflateSync(buffer, opts);
    } catch {
      return zlib.inflateRawSync(buffer, opts);
    }
  }
  if (encoding === 'zstd' && typeof zlib.zstdDecompressSync === 'function') return zlib.zstdDecompressSync(buffer, opts);
  return null;
}

// What the dashboard shows of a body: text when it reads as text, otherwise only its size.
export function describeBody(body, headers) {
  const type = headerValue(headers, 'content-type');
  const encoding = headerValue(headers, 'content-encoding').trim().toLowerCase();
  const truncated = body.size > body.kept;
  const view = { size: body.size, truncated, contentType: type || null, text: null, binary: false, decoded: null };
  if (body.size === 0) return view;
  let buffer = Buffer.concat(body.chunks);
  if (encoding && encoding !== 'identity') {
    let plain = null;
    if (!truncated) {
      try { plain = decompress(buffer, encoding); } catch { plain = null; }
    }
    if (!plain) {
      view.binary = true;
      view.encoding = encoding;
      return view;
    }
    buffer = plain;
    view.decoded = encoding;
  }
  if (BINARY_TYPE.test(type)) {
    view.binary = true;
    return view;
  }
  if (TEXT_TYPE.test(type)) {
    view.text = new TextDecoder('utf-8').decode(buffer);
    return view;
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    if (/[\u0000-\u0008\u000e-\u001f]/.test(text)) view.binary = true;
    else view.text = text;
  } catch {
    // A cut body can end inside a multi-byte character.
    if (truncated) view.text = new TextDecoder('utf-8').decode(buffer);
    else view.binary = true;
  }
  return view;
}

function summaryOf(rec) {
  return {
    seq: rec.seq,
    startedAt: rec.startedAt,
    method: rec.method,
    path: rec.path,
    status: rec.status,
    durationMs: rec.durationMs,
    state: rec.state,
    error: rec.error,
    replayOf: rec.replayOf,
    edited: !!rec.edited,
    websocket: rec.websocket,
    requestSize: rec.requestBody.size,
    responseSize: rec.responseBody.size,
    contentType: headerValue(rec.responseHeaders, 'content-type') || null,
  };
}

function detailOf(rec) {
  return {
    ...summaryOf(rec),
    remote: rec.remote,
    statusText: rec.statusText,
    requestHeaders: rec.requestHeaders,
    responseHeaders: rec.responseHeaders,
    requestBody: describeBody(rec.requestBody, rec.requestHeaders),
    responseBody: describeBody(rec.responseBody, rec.responseHeaders),
    replayable: !rec.websocket && rec.requestBody.size === rec.requestBody.kept,
  };
}

function hostnameFor(url) {
  return url.hostname.replace(/^\[|\]$/g, '');
}

function writeHead(socket, statusCode, statusMessage, rawHeaders) {
  let head = `HTTP/1.1 ${statusCode} ${statusMessage || ''}\r\n`;
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) head += `${rawHeaders[i]}: ${rawHeaders[i + 1]}\r\n`;
  socket.write(head + '\r\n');
}

export function createInspector({
  store,
  keep = KEEP,
  requestBodyCap = REQUEST_BODY_CAP,
  responseBodyCap = RESPONSE_BODY_CAP,
  clock = () => Date.now(),
  isLive = () => true,
} = {}) {
  const proxies = new Map();
  const token = crypto.randomBytes(16).toString('hex');
  const editedReplays = new Set();

  function isReplay(req) {
    return String(req.headers[REPLAY_HEADER] || '').split(':')[0] === token;
  }

  // Traffic for a tunnel the user stopped is refused, even if cloudflared still runs; replays still go.
  function refuseStopped(entry, req) {
    return !isLive(entry.id) && !isReplay(req);
  }

  function bump(entry) {
    entry.version += 1;
  }

  function startRecord(entry, req, extra = {}) {
    const requestHeaders = pairs(req.rawHeaders);
    const marker = String(req.headers[REPLAY_HEADER] || '').split(':');
    const replayOf = marker[0] === token && /^\d+$/.test(marker[1] || '') ? Number(marker[1]) : null;
    const rec = {
      seq: entry.seq += 1,
      startedAt: new Date(clock()).toISOString(),
      t0: clock(),
      method: req.method,
      path: req.url,
      remote: headerValue(requestHeaders, 'cf-connecting-ip') || req.socket?.remoteAddress || null,
      requestHeaders,
      forward: forwardHeaders(req.headers, { upgrade: !!extra.websocket }),
      requestBody: newBody(requestBodyCap),
      status: null,
      statusText: null,
      responseHeaders: [],
      responseBody: newBody(responseBodyCap),
      durationMs: null,
      state: 'pending',
      error: null,
      replayOf,
      websocket: !!extra.websocket,
    };
    if (replayOf != null && marker[2]) {
      entry.replays.set(marker[2], rec);
      if (editedReplays.has(marker[2])) rec.edited = true;
    }
    entry.records.push(rec);
    entry.total += 1;
    if (entry.records.length > keep) entry.records.splice(0, entry.records.length - keep);
    bump(entry);
    return rec;
  }

  function finish(entry, rec, state, error) {
    if (rec.state !== 'pending') return;
    rec.state = state;
    rec.error = error || null;
    rec.durationMs = Math.max(0, clock() - rec.t0);
    bump(entry);
  }

  function originFailed(entry, rec, error) {
    const reason = error.code || error.message;
    finish(entry, rec, 'error', reason);
    if (store.get(entry.id)) store.recordOriginError(entry.id, `Unable to reach the origin ${entry.origin}: ${reason}`);
  }

  function upstreamOptions(entry, req, headers) {
    const url = entry.originUrl;
    const secure = url.protocol === 'https:';
    const hostname = hostnameFor(url);
    return {
      lib: secure ? https : http,
      options: {
        protocol: url.protocol,
        hostname,
        port: url.port || (secure ? 443 : 80),
        method: req.method,
        path: req.url,
        headers,
        agent: secure ? entry.httpsAgent : entry.httpAgent,
        ...(secure ? {
          rejectUnauthorized: !entry.noTlsVerify,
          servername: net.isIP(hostname) ? undefined : hostname,
        } : {}),
      },
    };
  }

  function refuse(res) {
    const body = 'trydash: this tunnel is stopped.\n';
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(body), Connection: 'close' });
    res.end(body);
  }

  function onRequest(entry, req, res) {
    if (refuseStopped(entry, req)) return refuse(res);
    const rec = startRecord(entry, req);
    const { lib, options } = upstreamOptions(entry, req, rec.forward);
    const upstream = lib.request(options);
    upstream.on('response', (pres) => {
      rec.status = pres.statusCode;
      rec.statusText = pres.statusMessage || null;
      rec.responseHeaders = pairs(pres.rawHeaders);
      bump(entry);
      res.writeHead(pres.statusCode, pres.statusMessage, forwardHeaders(pres.headers));
      pres.on('data', (chunk) => {
        take(rec.responseBody, chunk);
      });
      pres.on('end', () => finish(entry, rec, 'done'));
      pres.on('error', () => finish(entry, rec, 'error', 'response'));
      pres.pipe(res);
    });
    upstream.on('error', (error) => {
      if (res.headersSent) {
        finish(entry, rec, 'error', error.code || error.message);
        res.destroy();
        return;
      }
      rec.status = 502;
      const body = `trydash: the origin ${entry.origin} is not responding (${error.code || error.message})\n`;
      rec.responseHeaders = [['Content-Type', 'text/plain; charset=utf-8']];
      take(rec.responseBody, Buffer.from(body));
      originFailed(entry, rec, error);
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
    });
    res.on('close', () => {
      if (!res.writableFinished) {
        upstream.destroy();
        finish(entry, rec, 'aborted', 'client');
      }
    });
    req.on('data', (chunk) => take(rec.requestBody, chunk));
    req.pipe(upstream);
  }

  // A folder tunnel: trydash itself answers, from the files in the folder.
  function onFolderRequest(entry, req, res) {
    if (refuseStopped(entry, req)) return refuse(res);
    const rec = startRecord(entry, req);
    req.on('data', (chunk) => take(rec.requestBody, chunk));
    req.on('end', () => {
      planStatic(entry.folder, req).then((plan) => {
        rec.status = plan.status;
        rec.statusText = http.STATUS_CODES[plan.status] || null;
        rec.responseHeaders = Object.entries(plan.headers);
        bump(entry);
        res.writeHead(plan.status, plan.headers);
        if (req.method === 'HEAD' || !plan.file) {
          if (req.method !== 'HEAD' && plan.body) take(rec.responseBody, plan.body);
          res.end(req.method === 'HEAD' ? undefined : plan.body);
          finish(entry, rec, 'done');
          return;
        }
        const stream = fs.createReadStream(plan.file, { start: plan.start, end: plan.end });
        stream.on('data', (chunk) => take(rec.responseBody, chunk));
        stream.on('error', (error) => {
          finish(entry, rec, 'error', error.code || error.message);
          res.destroy();
        });
        res.on('finish', () => finish(entry, rec, 'done'));
        res.on('close', () => {
          if (res.writableFinished) return;
          stream.destroy();
          finish(entry, rec, 'aborted', 'client');
        });
        stream.pipe(res);
      }, (error) => {
        rec.status = 500;
        finish(entry, rec, 'error', error.code || error.message);
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Server error.\n');
      });
    });
  }

  function onUpgrade(entry, req, socket, head) {
    if (refuseStopped(entry, req)) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    if (entry.folder) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const rec = startRecord(entry, req, { websocket: true });
    const { lib, options } = upstreamOptions(entry, req, rec.forward);
    const upstream = lib.request(options);
    socket.on('error', () => upstream.destroy());
    upstream.on('upgrade', (pres, psocket, phead) => {
      rec.status = pres.statusCode;
      rec.statusText = pres.statusMessage || null;
      rec.responseHeaders = pairs(pres.rawHeaders);
      bump(entry);
      writeHead(socket, pres.statusCode, pres.statusMessage, pres.rawHeaders);
      if (phead && phead.length) socket.write(phead);
      if (head && head.length) psocket.write(head);
      // Bun does not always emit 'close' on an upgraded socket, so 'end' also tears both down.
      const teardown = () => {
        socket.destroy();
        psocket.destroy();
        finish(entry, rec, 'done');
      };
      psocket.on('error', teardown);
      for (const side of [socket, psocket]) {
        side.on('end', teardown);
        side.on('close', teardown);
      }
      psocket.pipe(socket);
      socket.pipe(psocket);
    });
    upstream.on('response', (pres) => {
      rec.status = pres.statusCode;
      rec.statusText = pres.statusMessage || null;
      rec.responseHeaders = pairs(pres.rawHeaders);
      writeHead(socket, pres.statusCode, pres.statusMessage, pres.rawHeaders);
      pres.on('data', (chunk) => take(rec.responseBody, chunk));
      pres.on('end', () => { finish(entry, rec, 'done'); socket.end(); });
      pres.pipe(socket, { end: false });
    });
    upstream.on('error', (error) => {
      rec.status = 502;
      originFailed(entry, rec, error);
      socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    });
    upstream.end();
  }

  async function open(session) {
    if (proxies.has(session.id)) return proxies.get(session.id).target;
    const folder = session.mode === 'folder' ? session.options.folder : null;
    const originUrl = folder ? null : new URL(session.origin);
    const entry = {
      id: session.id,
      origin: session.origin,
      folder,
      originUrl,
      noTlsVerify: !!session.options.noTlsVerify,
      records: [],
      replays: new Map(),
      seq: 0,
      total: 0,
      version: 0,
      httpAgent: new http.Agent({ keepAlive: true }),
      httpsAgent: new https.Agent({ keepAlive: true }),
      server: null,
      sockets: new Set(),
      target: '',
      port: 0,
    };
    const server = http.createServer((req, res) => (folder ? onFolderRequest : onRequest)(entry, req, res));
    server.on('upgrade', (req, socket, head) => onUpgrade(entry, req, socket, head));
    server.on('connection', (socket) => {
      entry.sockets.add(socket);
      socket.on('close', () => entry.sockets.delete(socket));
    });
    server.on('clientError', (error, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    entry.server = server;
    entry.port = server.address().port;
    // The origin's path and query stay on the target, so cloudflared builds the same request paths.
    const rest = folder ? '' : session.origin.slice(`${originUrl.protocol}//${originUrl.host}`.length);
    entry.target = `http://127.0.0.1:${entry.port}${rest}`;
    proxies.set(session.id, entry);
    return entry.target;
  }

  async function close(id) {
    const entry = proxies.get(id);
    if (!entry) return;
    proxies.delete(id);
    for (const socket of entry.sockets) socket.destroy();
    entry.httpAgent.destroy();
    entry.httpsAgent.destroy();
    await new Promise((resolve) => entry.server.close(() => resolve()));
  }

  function entryFor(id) {
    const entry = proxies.get(id);
    if (!entry) throw appError('NOT_FOUND', 'inspect.disabled');
    return entry;
  }

  function findRecord(entry, seq) {
    const rec = entry.records.find((item) => item.seq === seq);
    if (!rec) throw appError('NOT_FOUND', 'inspect.requestNotFound');
    return rec;
  }

  // Changes for an edited replay: method, path, headers ([name, value] pairs) and body.
  // Header names and values are checked here, so no CR/LF can split the request.
  function checkEdits(edits) {
    const bad = (field) => appError('BAD_REQUEST', 'inspect.replayInvalid', { field });
    const out = {};
    if (edits.method != null) {
      if (!/^[A-Z][A-Z0-9-]{0,15}$/.test(String(edits.method))) throw bad('method');
      out.method = String(edits.method);
    }
    if (edits.path != null) {
      const p = String(edits.path);
      if (!p.startsWith('/') || p.length > 8192 || /[\s\u0000-\u001f\u007f]/.test(p)) throw bad('path');
      out.path = p;
    }
    if (edits.headers != null) {
      if (!Array.isArray(edits.headers) || edits.headers.length > 100) throw bad('headers');
      out.headers = edits.headers.map((pair) => {
        if (!Array.isArray(pair) || pair.length !== 2) throw bad('headers');
        const name = String(pair[0]);
        const value = String(pair[1]);
        if (!HEADER_NAME_RE.test(name) || /[\r\n\u0000]/.test(value) || value.length > 8192) throw bad('headers');
        return [name, value];
      });
    }
    if (edits.body != null) {
      const body = Buffer.from(String(edits.body), 'utf8');
      if (body.length > requestBodyCap) throw bad('body');
      out.body = body;
    }
    return out;
  }

  async function replay(id, seq, edits = null) {
    const entry = entryFor(id);
    const rec = findRecord(entry, seq);
    if (rec.websocket) throw appError('CONFLICT', 'inspect.replayWebsocket');
    const change = edits ? checkEdits(edits) : {};
    if (!change.body && rec.requestBody.size > rec.requestBody.kept) throw appError('CONFLICT', 'inspect.replayTruncated');
    const body = change.body || Buffer.concat(rec.requestBody.chunks);
    const method = change.method || rec.method;
    const nonce = crypto.randomBytes(8).toString('hex');
    // Original spelling and order of the header names, minus the hop-by-hop ones.
    const allowed = change.headers ? null : new Set(Object.keys(rec.forward));
    const source = change.headers || rec.requestHeaders;
    const headers = {};
    for (const [name, value] of source) {
      const key = name.toLowerCase();
      if (key === 'content-length' || key === REPLAY_HEADER || HOP_BY_HOP.has(key)) continue;
      if (allowed && !allowed.has(key)) continue;
      const existing = Object.keys(headers).find((k) => k.toLowerCase() === key);
      if (existing) headers[existing] = [].concat(headers[existing], value);
      else headers[name] = value;
    }
    if (body.length || !['GET', 'HEAD', 'DELETE', 'OPTIONS'].includes(method)) headers['content-length'] = String(body.length);
    headers[REPLAY_HEADER] = `${token}:${rec.seq}:${nonce}`;
    if (edits) editedReplays.add(nonce);
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: entry.port,
        method,
        path: change.path || rec.path,
        headers,
        agent: false,
      });
      const done = () => {
        const created = entry.replays.get(nonce);
        entry.replays.delete(nonce);
        editedReplays.delete(nonce);
        if (created) resolve(summaryOf(created));
        else reject(appError('SERVER', 'inspect.replayFailed'));
      };
      req.setTimeout(REPLAY_TIMEOUT_MS, () => req.destroy());
      req.on('response', (res) => {
        res.resume();
        res.on('end', done);
        res.on('error', done);
      });
      req.on('error', done);
      req.end(body);
    });
  }

  return {
    open,
    close,
    async closeAll() {
      await Promise.all(Array.from(proxies.keys()).map(close));
    },
    has(id) {
      return proxies.has(id);
    },
    info(id) {
      const entry = proxies.get(id);
      if (!entry) return null;
      return { count: entry.records.length, total: entry.total, version: entry.version, port: entry.port, target: entry.target };
    },
    list(id) {
      const entry = entryFor(id);
      return {
        version: entry.version,
        total: entry.total,
        requests: entry.records.map(summaryOf).reverse(),
      };
    },
    get(id, seq) {
      return detailOf(findRecord(entryFor(id), seq));
    },
    clear(id) {
      const entry = entryFor(id);
      entry.records = [];
      bump(entry);
    },
    replay,
    // For DASHBOARD_SEED: records that look like real traffic, without a socket.
    inject(id, sample) {
      const entry = entryFor(id);
      const fakeReq = {
        method: sample.method,
        url: sample.path,
        rawHeaders: sample.requestHeaders.flat(),
        headers: Object.fromEntries(sample.requestHeaders.map(([k, v]) => [k.toLowerCase(), v])),
        socket: { remoteAddress: '127.0.0.1' },
      };
      const rec = startRecord(entry, fakeReq);
      if (sample.requestBody) take(rec.requestBody, Buffer.from(sample.requestBody));
      rec.status = sample.status;
      rec.statusText = sample.statusText || null;
      rec.responseHeaders = sample.responseHeaders || [];
      if (sample.responseBody) take(rec.responseBody, Buffer.from(sample.responseBody));
      if (sample.startedAt) rec.startedAt = sample.startedAt;
      if (sample.replayOf) rec.replayOf = sample.replayOf;
      rec.t0 = clock() - (sample.durationMs || 0);
      finish(entry, rec, sample.state || 'done', sample.error);
      return rec.seq;
    },
  };
}
