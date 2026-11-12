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
import {
  MODIFY_CAP, NOINDEX, REWRITE_TYPE, HTML_TYPE, createRewriter, localHostOf, localLinkIn, hostCheckIn,
  blockedBy, blockedPage, injectBadge, publicCookie,
} from './preview.js';

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

function decompress(buffer, encoding, cap = DECODED_CAP) {
  const opts = { maxOutputLength: cap };
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
    saved: rec.saved || null,
    blocked: rec.blocked || null,
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

function flatHeaders(headers) {
  const list = [];
  for (const [name, value] of Object.entries(headers)) {
    for (const item of [].concat(value)) list.push(name, String(item));
  }
  return list;
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
  // Requests trydash itself sent (replays and saved ones), by the nonce in their marker.
  const pendingSends = new Map();

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
    const mine = marker[0] === token && !!marker[2];
    const replayOf = mine && /^\d+$/.test(marker[1] || '') ? Number(marker[1]) : null;
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
    if (mine) {
      entry.replays.set(marker[2], rec);
      const meta = pendingSends.get(marker[2]) || {};
      rec.edited = !!meta.edited;
      rec.saved = meta.saved || null;
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

  function upstreamOptions(entry, req, headers, path = req.url) {
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
        path,
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

  // The preview options, read on every request: they change on a running tunnel.
  function previewOf(entry) {
    const session = store.get(entry.id);
    const o = (session && session.options) || {};
    const prefs = { rewriter: null, blocked: o.blocked || [], badge: !!o.badge, noindex: !!o.noindex, watch: false };
    if (entry.folder) return prefs;
    if (o.rewrite && session.url) {
      const key = `${session.url} ${entry.siteHost || ''}`;
      if (entry.rewriterKey !== key) {
        entry.rewriter = createRewriter({ originUrl: entry.originUrl, hostHeader: entry.hostHeader, publicUrl: session.url, siteHost: entry.siteHost });
        entry.rewriterKey = key;
      }
      prefs.rewriter = entry.rewriter;
    }
    // Without rewriting, look out for a site that sends visitors to localhost (once is enough).
    prefs.watch = !o.rewrite && !session.localRedirect;
    return prefs;
  }

  function noticeLocal(entry, location, kind) {
    const session = store.get(entry.id);
    if (session && !session.localRedirect && !session.options.rewrite) store.recordLocalRedirect(entry.id, location, kind);
  }

  // A blocked path: the visitor gets a 403 page, the dashboard a record of it. Replays go through.
  function refuseBlocked(entry, req, res, prefs) {
    if (isReplay(req)) return false;
    const hit = blockedBy(req.url, prefs.blocked);
    if (!hit) return false;
    const rec = startRecord(entry, req);
    rec.blocked = hit;
    const body = Buffer.from(blockedPage(req.headers['accept-language']));
    const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': String(body.length), 'Cache-Control': 'no-store', 'X-Robots-Tag': NOINDEX };
    rec.status = 403;
    rec.statusText = 'Forbidden';
    rec.responseHeaders = Object.entries(headers);
    take(rec.responseBody, body);
    req.on('data', (chunk) => take(rec.requestBody, chunk));
    req.resume();
    res.writeHead(403, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
    finish(entry, rec, 'done');
    return true;
  }

  // What goes to the origin when rewriting: its own Host, Origin and Referer, and the
  // public URL turned back into the local one in the query. Plain bodies, so they can be rewritten.
  function requestFor(entry, req, rec, prefs) {
    const headers = { ...rec.forward };
    let path = req.url;
    const r = prefs.rewriter;
    if (r) {
      headers.host = r.localHost;
      for (const name of ['origin', 'referer']) if (headers[name]) headers[name] = r.toLocal(headers[name]);
      path = r.toLocal(path);
    }
    if (r || prefs.badge) {
      delete headers['accept-encoding'];
      // A copy cached before the change must not come back as a 304.
      delete headers['if-none-match'];
      delete headers['if-modified-since'];
    }
    return { headers, path };
  }

  function responseHeaders(pres, prefs) {
    const headers = forwardHeaders(pres.headers);
    const r = prefs.rewriter;
    if (r) {
      for (const [name, value] of Object.entries(headers)) {
        if (name === 'set-cookie') headers[name] = [].concat(value).map((v) => publicCookie(v, r));
        else headers[name] = Array.isArray(value) ? value.map((v) => r.toPublic(v)) : r.toPublic(value);
      }
    }
    if (prefs.noindex) headers['x-robots-tag'] = NOINDEX;
    return headers;
  }

  function wantsChange(req, pres, prefs) {
    if (req.method === 'HEAD' || [204, 206, 304].includes(pres.statusCode) || pres.statusCode < 200) return false;
    const type = String(pres.headers['content-type'] || '');
    if (!(prefs.rewriter && REWRITE_TYPE.test(type)) && !(prefs.badge && HTML_TYPE.test(type))) return false;
    const length = Number(pres.headers['content-length']);
    return !(length > MODIFY_CAP);
  }

  // Rewritten or labelled body. Bytes are read as latin1, so any charset comes back as it was.
  function changedBody(raw, pres, prefs, req) {
    const encoding = String(pres.headers['content-encoding'] || '').trim().toLowerCase();
    let buffer = raw;
    if (encoding && encoding !== 'identity') {
      buffer = null;
      try { buffer = decompress(raw, encoding, MODIFY_CAP); } catch { buffer = null; }
      if (!buffer) return null;
    }
    let text = buffer.toString('latin1');
    if (prefs.rewriter) text = prefs.rewriter.toPublic(text);
    if (prefs.badge && HTML_TYPE.test(String(pres.headers['content-type'] || '')) && pres.statusCode < 300) {
      text = injectBadge(text, req.headers['accept-language']);
    }
    return Buffer.from(text, 'latin1');
  }

  function onRequest(entry, req, res) {
    if (refuseStopped(entry, req)) return refuse(res);
    const prefs = previewOf(entry);
    if (refuseBlocked(entry, req, res, prefs)) return;
    const rec = startRecord(entry, req);
    const sent = requestFor(entry, req, rec, prefs);
    const { lib, options } = upstreamOptions(entry, req, sent.headers, sent.path);
    const upstream = lib.request(options);
    upstream.on('response', (pres) => {
      rec.status = pres.statusCode;
      rec.statusText = pres.statusMessage || null;
      rec.responseHeaders = pairs(pres.rawHeaders);
      bump(entry);
      const location = pres.headers.location;
      if (location) {
        // The site's own address, learned from its redirects: the next requests carry it as Host.
        const host = localHostOf(location, entry.originUrl, entry.hostHeader);
        if (host && prefs.rewriter && host !== prefs.rewriter.localHost) entry.siteHost = host;
        if (host && prefs.watch) noticeLocal(entry, location, 'redirect');
      }
      const headers = responseHeaders(pres, prefs);
      const drop = () => {
        finish(entry, rec, 'error', 'response');
        if (!res.writableEnded) res.destroy();
      };
      pres.on('error', drop);
      pres.on('aborted', drop);
      pres.on('close', () => {
        if (!pres.complete) drop();
      });
      pres.on('end', () => {
        finish(entry, rec, 'done');
        if (prefs.watch) watchBody(entry, rec);
      });
      if (!wantsChange(req, pres, prefs)) {
        res.writeHead(pres.statusCode, pres.statusMessage, headers);
        pres.on('data', (chunk) => take(rec.responseBody, chunk));
        pres.pipe(res);
        return;
      }
      // Buffered, changed, then sent with its new length. Past MODIFY_CAP it goes out as it came.
      const chunks = [];
      let size = 0;
      let streaming = false;
      pres.on('data', (chunk) => {
        take(rec.responseBody, chunk);
        if (streaming) return;
        chunks.push(chunk);
        size += chunk.length;
        if (size <= MODIFY_CAP) return;
        streaming = true;
        res.writeHead(pres.statusCode, pres.statusMessage, headers);
        for (const part of chunks) res.write(part);
        chunks.length = 0;
        pres.pipe(res);
      });
      pres.on('end', () => {
        if (streaming) return;
        const raw = Buffer.concat(chunks);
        const body = changedBody(raw, pres, prefs, req);
        if (!body) {
          res.writeHead(pres.statusCode, pres.statusMessage, headers);
          res.end(raw);
          return;
        }
        for (const name of ['content-encoding', 'etag', 'last-modified', 'content-md5', 'digest']) delete headers[name];
        headers['content-length'] = String(body.length);
        res.writeHead(pres.statusCode, pres.statusMessage, headers);
        res.end(body);
      });
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
    if (prefs.rewriter && rewritableRequest(req)) {
      // A small form or JSON body may carry the public URL (WordPress' redirect_to): back to local.
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.from(prefs.rewriter.toLocal(Buffer.concat(chunks).toString('latin1')), 'latin1');
        upstream.setHeader('content-length', String(body.length));
        upstream.end(body);
      });
      return;
    }
    req.pipe(upstream);
  }

  function rewritableRequest(req) {
    const length = Number(req.headers['content-length']);
    const type = String(req.headers['content-type'] || '');
    return Number.isFinite(length) && length > 0 && length <= requestBodyCap && !req.headers['transfer-encoding']
      && /^(application\/(x-www-form-urlencoded|json|[\w.+-]*\+json)|text\/plain)\b/i.test(type);
  }

  // Local links in a page, or a dev server refusing the public Host: a hint for the dashboard.
  function watchBody(entry, rec) {
    const type = headerValue(rec.responseHeaders, 'content-type');
    if (!HTML_TYPE.test(type) && !/^text\/plain/i.test(type)) return;
    const view = describeBody(rec.responseBody, rec.responseHeaders);
    if (!view.text) return;
    if (rec.status === 403 && hostCheckIn(view.text)) return noticeLocal(entry, rec.path, 'host');
    if (!HTML_TYPE.test(type)) return;
    const link = localLinkIn(view.text, entry.originUrl, entry.hostHeader);
    if (link) noticeLocal(entry, link, 'links');
  }

  // A folder tunnel: trydash itself answers, from the files in the folder.
  function onFolderRequest(entry, req, res) {
    if (refuseStopped(entry, req)) return refuse(res);
    const prefs = previewOf(entry);
    if (refuseBlocked(entry, req, res, prefs)) return;
    const rec = startRecord(entry, req);
    // The label changes the page, so a copy cached without it must not come back as a 304.
    if (prefs.badge) delete req.headers['if-none-match'];
    req.on('data', (chunk) => take(rec.requestBody, chunk));
    req.on('end', () => {
      planStatic(entry.folder, req).then(async (plan) => {
        if (prefs.noindex) plan.headers['X-Robots-Tag'] = NOINDEX;
        if (prefs.badge && req.method === 'GET' && plan.status === 200 && plan.file && HTML_TYPE.test(plan.headers['Content-Type'] || '')
          && Number(plan.headers['Content-Length']) <= MODIFY_CAP) {
          const html = injectBadge((await fs.promises.readFile(plan.file)).toString('latin1'), req.headers['accept-language']);
          plan.body = Buffer.from(html, 'latin1');
          plan.file = null;
          delete plan.headers.ETag;
          delete plan.headers['Last-Modified'];
          delete plan.headers['Accept-Ranges'];
          plan.headers['Content-Length'] = String(plan.body.length);
        }
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
    const prefs = previewOf(entry);
    if (!isReplay(req) && blockedBy(req.url, prefs.blocked)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const rec = startRecord(entry, req, { websocket: true });
    const headers = { ...rec.forward };
    let path = req.url;
    if (prefs.rewriter) {
      headers.host = prefs.rewriter.localHost;
      if (headers.origin) headers.origin = prefs.rewriter.toLocal(headers.origin);
      path = prefs.rewriter.toLocal(path);
    }
    const { lib, options } = upstreamOptions(entry, req, headers, path);
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
      // The stream is already decoded, so the origin's chunked framing must not be copied through.
      const headers = forwardHeaders(pres.headers);
      headers.connection = 'close';
      writeHead(socket, pres.statusCode, pres.statusMessage, flatHeaders(headers));
      const drop = () => {
        finish(entry, rec, 'error', 'response');
        socket.destroy();
      };
      pres.on('data', (chunk) => take(rec.responseBody, chunk));
      pres.on('end', () => { finish(entry, rec, 'done'); socket.end(); });
      pres.on('error', drop);
      pres.on('aborted', drop);
      pres.on('close', () => {
        if (!pres.complete) drop();
      });
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
      hostHeader: session.options.hostHeader || '',
      siteHost: '',
      rewriter: null,
      rewriterKey: '',
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

  // Sends a request through the tunnel's own proxy, so it is recorded like the rest
  // and reaches only that tunnel's origin. `meta`: { replayOf, edited, saved }.
  function dispatch(entry, { method, path, headers: list, body }, meta = {}) {
    const nonce = crypto.randomBytes(8).toString('hex');
    const headers = {};
    for (const [name, value] of list) {
      const key = name.toLowerCase();
      if (key === 'content-length' || key === REPLAY_HEADER || HOP_BY_HOP.has(key)) continue;
      const existing = Object.keys(headers).find((k) => k.toLowerCase() === key);
      if (existing) headers[existing] = [].concat(headers[existing], value);
      else headers[name] = value;
    }
    if (body.length || !['GET', 'HEAD', 'DELETE', 'OPTIONS'].includes(method)) headers['content-length'] = String(body.length);
    headers[REPLAY_HEADER] = `${token}:${meta.replayOf == null ? 'send' : meta.replayOf}:${nonce}`;
    pendingSends.set(nonce, meta);
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: entry.port,
        method,
        path,
        headers,
        agent: false,
      });
      const done = () => {
        const created = entry.replays.get(nonce);
        entry.replays.delete(nonce);
        pendingSends.delete(nonce);
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

  async function replay(id, seq, edits = null) {
    const entry = entryFor(id);
    const rec = findRecord(entry, seq);
    if (rec.websocket) throw appError('CONFLICT', 'inspect.replayWebsocket');
    const change = edits ? checkEdits(edits) : {};
    if (!change.body && rec.requestBody.size > rec.requestBody.kept) throw appError('CONFLICT', 'inspect.replayTruncated');
    // Original spelling and order of the header names, minus the hop-by-hop ones.
    const allowed = change.headers ? null : new Set(Object.keys(rec.forward));
    const list = (change.headers || rec.requestHeaders).filter(([name]) => !allowed || allowed.has(name.toLowerCase()));
    return dispatch(entry, {
      method: change.method || rec.method,
      path: change.path || rec.path,
      headers: list,
      body: change.body || Buffer.concat(rec.requestBody.chunks),
    }, { replayOf: rec.seq, edited: !!edits });
  }

  // A saved request (already checked by formats.checkRequest), sent to this tunnel's origin.
  async function send(id, request, name) {
    const entry = entryFor(id);
    return dispatch(entry, {
      method: request.method,
      path: request.path,
      headers: request.headers || [],
      body: request.bodyBase64 ? Buffer.from(request.bodyBase64, 'base64') : Buffer.from(request.body || '', 'utf8'),
    }, { saved: name || `${request.method} ${request.path}` });
  }

  // A recorded request as it arrived (raw body, no hop-by-hop headers), to save it.
  function captured(id, seq) {
    const rec = findRecord(entryFor(id), seq);
    if (rec.websocket) throw appError('CONFLICT', 'inspect.replayWebsocket');
    if (rec.requestBody.size > rec.requestBody.kept) throw appError('CONFLICT', 'inspect.replayTruncated');
    const allowed = new Set(Object.keys(rec.forward));
    const body = Buffer.concat(rec.requestBody.chunks);
    let text = null;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(body); } catch { text = null; }
    return {
      method: rec.method,
      path: rec.path,
      headers: rec.requestHeaders.filter(([name]) => allowed.has(name.toLowerCase())),
      body: text != null && text !== '' ? text : null,
      bodyBase64: text == null && body.length ? body.toString('base64') : null,
    };
  }

  // The full records a HAR or Postman export needs, oldest first.
  function details(id, seqs) {
    const entry = entryFor(id);
    const wanted = seqs ? new Set(seqs) : null;
    return entry.records.filter((rec) => !wanted || wanted.has(rec.seq)).map(detailOf);
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
    send,
    details,
    captured,
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
