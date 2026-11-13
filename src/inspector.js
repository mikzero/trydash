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
import { isListening } from './ports.js';
import { readAsset } from './assets.js';
import {
  KEY_PARAM, COOKIE, RESERVED, PIN_TRIES, PIN_LOCK_MS, cookieValue, cookieLinkId, readCookie, withoutCookie,
  withoutKey, setCookie, gatePage, safeBack, pinMatches,
} from './links.js';
import {
  MODIFY_CAP, NOINDEX, REWRITE_TYPE, HTML_TYPE, createRewriter, localHostOf, localLinkIn, hostCheckIn,
  blockedBy, blockedPage, injectExtras, publicCookie, isPageRequest, wantsExtras,
} from './preview.js';

export const KEEP = 200;
export const REQUEST_BODY_CAP = 256 * 1024;
export const RESPONSE_BODY_CAP = 64 * 1024;
const DECODED_CAP = 1024 * 1024;
const REPLAY_TIMEOUT_MS = 30000;
export const REPLAY_HEADER = 'x-trydash-replay';
// The waiting line for requests that found the origin down.
export const QUEUE_MAX = 100;
export const QUEUE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const QUEUE_CHECK_MS = 1500;
const QUEUED_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const ORIGIN_DOWN = new Set(['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH']);
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
    queued: rec.queued || null,
    deliveredAs: rec.deliveredAs || null,
    delivery: !!rec.delivery,
    client: rec.client || null,
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
  // Called after a client left a comment, or first opened their link (the server saves then).
  onComment = () => {},
  onFirstVisit = () => {},
  commentRateMax = 5000,
} = {}) {
  const proxies = new Map();
  const token = crypto.randomBytes(16).toString('hex');
  // Signs the personal-link cookies; a new one at each start.
  const linkSecret = crypto.randomBytes(32);
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
      client: req.trydashLink && req.trydashLink.id !== 'owner' ? req.trydashLink.name : null,
    };
    if (mine) {
      entry.replays.set(marker[2], rec);
      const meta = pendingSends.get(marker[2]) || {};
      rec.edited = !!meta.edited;
      rec.saved = meta.saved || null;
      rec.delivery = !!meta.delivery;
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
    const prefs = { rewriter: null, blocked: o.blocked || [], badge: !!o.badge, noindex: !!o.noindex, queue: !!o.queue && !entry.folder, comments: !!o.comments, watch: false };
    // Something goes into the pages: the label, the comments widget.
    prefs.inject = prefs.badge || prefs.comments;
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
    if (r || prefs.inject) {
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
    if (!(prefs.rewriter && REWRITE_TYPE.test(type)) && !(prefs.inject && HTML_TYPE.test(type))) return false;
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
    const inject = prefs.inject && HTML_TYPE.test(String(pres.headers['content-type'] || '')) && pres.statusCode < 300
      && wantsExtras(req.headers, text);
    // Nothing to change: the origin's bytes go out as they came, encoding and all.
    if (!prefs.rewriter && !inject) return null;
    if (prefs.rewriter) text = prefs.rewriter.toPublic(text);
    if (inject) text = injectExtras(text, req.headers['accept-language'], prefs);
    return Buffer.from(text, 'latin1');
  }

  // ---- Personal links ------------------------------------------------------------------

  function sendPage(res, status, html, headers = {}) {
    const body = Buffer.from(html);
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': String(body.length), 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', ...headers });
    res.end(body);
  }

  function linkFinder(session) {
    return (id) => {
      if (id === 'owner') return session.ownerKey ? { id: 'owner', name: null, key: session.ownerKey, pinHash: null } : null;
      return session.links.find((link) => link.id === id && !link.revoked) || null;
    };
  }

  // trydash's own cookie goes before anything is recorded or forwarded.
  function stripLinkCookie(req) {
    if (!req.headers.cookie || !req.headers.cookie.includes(`${COOKIE}=`)) return;
    const kept = withoutCookie(req.headers.cookie, COOKIE);
    if (kept == null) delete req.headers.cookie;
    else req.headers.cookie = kept;
    const raw = [];
    for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
      if (req.rawHeaders[i].toLowerCase() === 'cookie') {
        const value = withoutCookie(req.rawHeaders[i + 1], COOKIE);
        if (value != null) raw.push(req.rawHeaders[i], value);
      } else raw.push(req.rawHeaders[i], req.rawHeaders[i + 1]);
    }
    req.rawHeaders = raw;
  }

  function isPageView(req) {
    if (req.method !== 'GET') return false;
    const dest = req.headers['sec-fetch-dest'];
    return dest ? dest === 'document' : /text\/html/.test(String(req.headers.accept || ''));
  }

  // Who is visiting: a personal link turns into a cookie, a PIN is asked for, and with
  // "personal links only" nobody else gets in. True when it answered the request itself.
  function gate(entry, req, res) {
    const session = store.get(entry.id);
    if (!session) return false;
    const lang = req.headers['accept-language'];
    const pathname = String(req.url || '/').split('?')[0];
    if (pathname === `${RESERVED}pin`) {
      handlePin(entry, session, req, res);
      return true;
    }
    if (isReplay(req)) {
      stripLinkCookie(req);
      return false;
    }
    const find = linkFinder(session);
    let key = null;
    try { key = new URL(req.url || '/', 'http://x').searchParams.get(KEY_PARAM); } catch { key = null; }
    if (key) {
      const link = session.ownerKey && key === session.ownerKey ? find('owner') : session.links.find((item) => item.key === key) || null;
      if (!link || link.revoked) {
        sendPage(res, 403, gatePage('invalid', lang), { 'Set-Cookie': setCookie('', { clear: true }) });
        return true;
      }
      const already = cookieLinkId(linkSecret, readCookie(req.headers.cookie, COOKIE), find);
      if (link.pinHash && !(already && already.id === link.id)) {
        sendPage(res, 200, gatePage('pin', lang, { key, back: withoutKey(req.url) }));
        return true;
      }
      res.writeHead(302, { Location: withoutKey(req.url), 'Set-Cookie': setCookie(cookieValue(linkSecret, link)), 'Cache-Control': 'no-store', 'Content-Length': '0' });
      res.end();
      return true;
    }
    const cookie = readCookie(req.headers.cookie, COOKIE);
    const link = cookie ? cookieLinkId(linkSecret, cookie, find) : null;
    stripLinkCookie(req);
    if (!link && session.options.linksOnly) {
      sendPage(res, 403, gatePage(cookie ? 'invalid' : 'required', lang), cookie ? { 'Set-Cookie': setCookie('', { clear: true }) } : {});
      return true;
    }
    req.trydashLink = link;
    if (link && link.id !== 'owner' && isPageView(req)) {
      const first = !link.firstSeen;
      store.recordVisit(entry.id, link.id);
      if (first) {
        try { onFirstVisit(entry.id, link); } catch { /* saving is best effort */ }
      }
    }
    return false;
  }

  function clientAddress(req) {
    return headerValue(pairs(req.rawHeaders), 'cf-connecting-ip') || req.socket?.remoteAddress || '?';
  }

  function handlePin(entry, session, req, res) {
    const lang = req.headers['accept-language'];
    if (req.method !== 'POST') {
      sendPage(res, 405, gatePage('invalid', lang), { Allow: 'POST' });
      return;
    }
    const chunks = [];
    let size = 0;
    let tooBig = false;
    const rejectBig = () => {
      if (tooBig) return;
      tooBig = true;
      if (!res.headersSent) sendPage(res, 413, gatePage('invalid', lang));
      req.destroy();
    };
    req.on('data', (chunk) => {
      if (tooBig) return;
      size += chunk.length;
      if (size > 4096) {
        rejectBig();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooBig || res.headersSent) return;
      const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      const key = form.get('key') || '';
      const back = safeBack(form.get('back'));
      const link = session.links.find((item) => item.key === key && !item.revoked);
      if (!link || !link.pinHash) {
        sendPage(res, 403, gatePage('invalid', lang));
        return;
      }
      // One visitor's wrong guesses lock only that visitor.
      const who = `${link.id}\n${clientAddress(req)}`;
      const tries = entry.pinTries.get(who) || { count: 0, until: 0 };
      const now = clock();
      if (tries.until > now) {
        sendPage(res, 429, gatePage('pin', lang, { key, back, error: 'pinLocked' }));
        return;
      }
      if (pinMatches(link, form.get('pin'))) {
        entry.pinTries.delete(who);
        try {
          res.writeHead(303, { Location: back, 'Set-Cookie': setCookie(cookieValue(linkSecret, link)), 'Cache-Control': 'no-store', 'Content-Length': '0' });
          res.end();
        } catch {
          if (!res.headersSent) sendPage(res, 400, gatePage('invalid', lang));
        }
        return;
      }
      tries.count += 1;
      if (tries.count >= PIN_TRIES) {
        tries.count = 0;
        tries.until = now + PIN_LOCK_MS;
      }
      entry.pinTries.set(who, tries);
      sendPage(res, tries.until > now ? 429 : 401, gatePage('pin', lang, { key, back, error: tries.until > now ? 'pinLocked' : 'pinWrong' }));
    });
  }

  // ---- Comments -------------------------------------------------------------------

  const COMMENT_RATE = 30;
  const COMMENT_WINDOW_MS = 10 * 60 * 1000;

  function sendJsonReply(res, status, data) {
    const body = Buffer.from(JSON.stringify(data));
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(body.length), 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
    res.end(body);
  }

  function shortText(value, max) {
    return String(value == null ? '' : value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);
  }

  function unit(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
  }

  function coord(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(1e6, Math.max(0, Math.round(n))) : 0;
  }

  // Who sees which comments on the page: a client their own, the owner all, others the anonymous ones.
  function visibleTo(link) {
    return (comment) => !comment.resolved && (link && link.id === 'owner' ? true : link ? comment.linkId === link.id : !comment.linkId);
  }

  // A comment's author may change or delete it: the same personal link, the owner, or the
  // browser that holds its edit key (only a hash of it is kept).
  function editKeyHash(key) {
    return crypto.createHash('sha256').update(String(key)).digest('hex');
  }

  function mayEdit(comment, link, key) {
    if (link && link.id === 'owner') return true;
    if (link && comment.linkId === link.id) return true;
    if (!key || !comment.editHash) return false;
    const a = Buffer.from(editKeyHash(key), 'hex');
    const b = Buffer.from(comment.editHash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  function pinView(comment, link) {
    return {
      id: comment.id, at: comment.at, editedAt: comment.editedAt || null, text: comment.text, author: comment.author,
      selector: comment.selector, x: comment.x, y: comment.y, docX: comment.docX, docY: comment.docY,
      mine: mayEdit(comment, link, null),
    };
  }

  function readSmallJson(req, done) {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= 16 * 1024) chunks.push(chunk);
      if (size > 64 * 1024) req.destroy();
    });
    req.on('end', () => {
      let body = null;
      // A DELETE may come without a body: that is an empty object, not an error.
      if (size === 0) body = {};
      else if (size <= 16 * 1024) {
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
      }
      done(body && typeof body === 'object' && !Array.isArray(body) ? body : null);
    });
  }

  // PATCH (new text) or DELETE of one comment, by its author.
  function changeComment(entry, req, res, commentId) {
    const session = store.get(entry.id);
    const link = req.trydashLink || null;
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) {
      sendJsonReply(res, 415, { error: 'application/json expected' });
      return;
    }
    readSmallJson(req, (body) => {
      const comment = (session.comments || []).find((c) => c.id === commentId);
      if (!body || !comment) {
        sendJsonReply(res, comment ? 400 : 404, { error: comment ? 'bad request' : 'not found' });
        return;
      }
      if (!mayEdit(comment, link, body.editKey)) {
        sendJsonReply(res, 403, { error: 'not yours' });
        return;
      }
      if (req.method === 'DELETE') {
        store.removeComment(entry.id, comment.id);
      } else {
        const text = shortText(body.text, 2000);
        if (!text) {
          sendJsonReply(res, 400, { error: 'bad comment' });
          return;
        }
        store.editComment(entry.id, comment.id, text);
      }
      try { onComment(entry.id, comment, req.method === 'DELETE' ? 'delete' : 'edit'); } catch { /* saving is best effort */ }
      sendJsonReply(res, 200, req.method === 'DELETE' ? { ok: true } : { comment: { ...pinView(comment, link), mine: true } });
    });
  }

  // trydash's own paths on the tunnel: /__trydash/…. They never reach the site.
  function handleReserved(entry, req, res, prefs) {
    const url = new URL(req.url, 'http://x');
    const route = url.pathname.slice(RESERVED.length);
    if (!prefs.comments) {
      sendPage(res, 404, '<!doctype html><title>404</title><p>Not found.</p>');
      return;
    }
    if (route === 'comments.js' && (req.method === 'GET' || req.method === 'HEAD')) {
      const code = readAsset('public/widget/comments.js') || Buffer.alloc(0);
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Content-Length': String(code.length), 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : code);
      return;
    }
    const one = /^comments\/(c[0-9a-f]{10})$/.exec(route);
    if (one && (req.method === 'PATCH' || req.method === 'DELETE')) {
      changeComment(entry, req, res, one[1]);
      return;
    }
    if (route !== 'comments') {
      sendPage(res, 404, '<!doctype html><title>404</title><p>Not found.</p>');
      return;
    }
    const session = store.get(entry.id);
    const link = req.trydashLink || null;
    if (req.method === 'GET') {
      const page = url.searchParams.get('page') || '/';
      const list = (session.comments || []).filter((c) => c.page === page).filter(visibleTo(link)).map((c) => pinView(c, link));
      sendJsonReply(res, 200, { me: link && link.id !== 'owner' ? { name: link.name } : null, comments: list });
      return;
    }
    if (req.method !== 'POST') {
      sendJsonReply(res, 405, { error: 'method not allowed' });
      return;
    }
    // JSON only: another site can't post here without a CORS preflight, which gets no answer.
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) {
      sendJsonReply(res, 415, { error: 'application/json expected' });
      return;
    }
    const who = clientAddress(req);
    const now = clock();
    const rate = entry.commentRate.get(who) || { count: 0, since: now };
    if (now - rate.since > COMMENT_WINDOW_MS) { rate.count = 0; rate.since = now; }
    if (rate.count >= COMMENT_RATE) {
      sendJsonReply(res, 429, { error: 'too many comments, try again later' });
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= 16 * 1024) chunks.push(chunk);
      // Way past any real comment: stop reading.
      if (size > 64 * 1024) req.destroy();
    });
    req.on('end', () => {
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
      const text = body && shortText(body.text, 2000);
      const page = body && shortText(body.page, 500);
      if (size > 16 * 1024 || !body || !text || !page.startsWith('/')) {
        sendJsonReply(res, 400, { error: 'bad comment' });
        return;
      }
      rate.count += 1;
      // A full map drops visitors whose window has passed. It never wipes the
      // counters still in force: a new visitor is refused instead.
      if (!entry.commentRate.has(who) && entry.commentRate.size >= commentRateMax) {
        for (const [key, value] of entry.commentRate) {
          if (now - value.since > COMMENT_WINDOW_MS) entry.commentRate.delete(key);
        }
      }
      if (!entry.commentRate.has(who) && entry.commentRate.size >= commentRateMax) {
        rate.count -= 1;
        sendJsonReply(res, 429, { error: 'too many comments, try again later' });
        return;
      }
      entry.commentRate.set(who, rate);
      const viewport = body.viewport && typeof body.viewport === 'object' ? body.viewport : {};
      // Only this browser gets the key: it can change or delete the comment later.
      const editKey = crypto.randomBytes(16).toString('base64url');
      const comment = {
        id: `c${crypto.randomBytes(5).toString('hex')}`,
        at: new Date(now).toISOString(),
        page,
        title: shortText(body.title, 200),
        text,
        author: link && link.id !== 'owner' ? link.name : shortText(body.name, 60) || (link ? 'trydash' : null),
        linkId: link ? link.id : null,
        selector: shortText(body.selector, 600),
        x: unit(body.x),
        y: unit(body.y),
        docX: coord(body.docX),
        docY: coord(body.docY),
        element: body.element && typeof body.element === 'object'
          ? { tag: shortText(body.element.tag, 20), text: shortText(body.element.text, 120) } : null,
        viewport: { w: coord(viewport.w), h: coord(viewport.h), dpr: Math.min(8, Math.max(0, Number(viewport.dpr) || 1)) },
        userAgent: shortText(req.headers['user-agent'], 300),
        lang: /^\s*([a-z]{2})\b/i.test(String(req.headers['accept-language'] || '')) ? /^\s*([a-z]{2})/i.exec(req.headers['accept-language'])[1].toLowerCase() : null,
        errors: Array.isArray(body.errors) ? body.errors.slice(0, 10).map((e) => shortText(e, 300)).filter(Boolean) : [],
        resolved: false,
        resolvedAt: null,
        editHash: editKeyHash(editKey),
        editedAt: null,
      };
      try {
        store.addComment(entry.id, comment);
      } catch {
        sendJsonReply(res, 507, { error: 'this preview has too many comments' });
        return;
      }
      try { onComment(entry.id, comment, 'add'); } catch { /* saving is best effort */ }
      sendJsonReply(res, 201, { comment: { ...pinView(comment, link), mine: true }, editKey });
    });
  }

  // WebSockets: the cookie must be valid with "personal links only", and never reaches the origin.
  function gateUpgrade(entry, req) {
    const session = store.get(entry.id);
    if (!session || isReplay(req)) return true;
    const cookie = readCookie(req.headers.cookie, COOKIE);
    const link = cookie ? cookieLinkId(linkSecret, cookie, linkFinder(session)) : null;
    stripLinkCookie(req);
    req.trydashLink = link;
    return !!link || !session.options.linksOnly;
  }

  function onRequest(entry, req, res) {
    if (refuseStopped(entry, req)) return refuse(res);
    if (gate(entry, req, res)) return;
    const prefs = previewOf(entry);
    if (String(req.url || '').startsWith(RESERVED)) return handleReserved(entry, req, res, prefs);
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
      const live = store.get(entry.id);
      if (live && live.lastOriginError) store.recordOriginBack(entry.id);
      const location = pres.headers.location;
      if (location) {
        // The site's own address, learned from its redirects: the next requests carry it as Host.
        const host = localHostOf(location, entry.originUrl, entry.hostHeader);
        if (host && prefs.rewriter && host !== prefs.rewriter.localHost) entry.siteHost = host;
        if (host && prefs.watch) noticeLocal(entry, location, 'redirect');
      }
      const headers = responseHeaders(pres, prefs);
      // A redirect to the local address must not stay in the visitor's cache: a 301 kept from
      // before rewriting was on, or the one-off redirect that teaches the site's Host, would
      // send them to the wrong place for good.
      if (location && pres.statusCode >= 300 && pres.statusCode < 400 && localHostOf(location, entry.originUrl, entry.hostHeader)) {
        headers['cache-control'] = 'no-store';
        delete headers.expires;
      }
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
      if (prefs.queue && QUEUED_METHODS.has(req.method) && ORIGIN_DOWN.has(error.code) && !isReplay(req)) {
        // The whole body is needed to deliver it later: wait for it, then decide.
        const decide = () => (queueRequest(entry, rec, req) ? answerQueued(entry, rec, res, error) : answerDown(entry, rec, res, error));
        if (req.complete || req.readableEnded) decide();
        else {
          req.once('end', decide);
          req.once('aborted', () => answerDown(entry, rec, res, error));
        }
        return;
      }
      answerDown(entry, rec, res, error);
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

  function answerDown(entry, rec, res, error) {
    if (res.headersSent) return;
    rec.status = 502;
    const body = `trydash: the origin ${entry.origin} is not responding (${error.code || error.message})\n`;
    rec.responseHeaders = [['Content-Type', 'text/plain; charset=utf-8']];
    take(rec.responseBody, Buffer.from(body));
    originFailed(entry, rec, error);
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  }

  // The sender gets a 202: the request is kept and goes to the origin once it is back.
  function answerQueued(entry, rec, res, error) {
    if (res.headersSent) return;
    const body = JSON.stringify({ queued: true, by: 'trydash', message: 'Your server is down: this request will be delivered when it is back.' });
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(Buffer.byteLength(body)), 'X-Trydash-Queued': String(rec.seq) };
    rec.status = 202;
    rec.statusText = 'Accepted';
    rec.responseHeaders = Object.entries(headers);
    take(rec.responseBody, Buffer.from(body));
    if (store.get(entry.id)) store.recordOriginError(entry.id, `Unable to reach the origin ${entry.origin}: ${error.code || error.message} (request #${rec.seq} queued)`);
    res.writeHead(202, headers);
    res.end(body);
    finish(entry, rec, 'done');
    bump(entry);
  }

  // Kept with its own copy of the request, so it survives the records list being trimmed.
  function queueRequest(entry, rec, req) {
    if (rec.requestBody.size > rec.requestBody.kept) return false;
    dropExpired(entry);
    if (entry.queue.length >= QUEUE_MAX) return false;
    const allowed = new Set(Object.keys(rec.forward));
    entry.queue.push({
      seq: rec.seq,
      rec,
      at: clock(),
      request: {
        method: rec.method,
        path: rec.path,
        headers: rec.requestHeaders.filter(([name]) => allowed.has(name.toLowerCase())),
        body: Buffer.concat(rec.requestBody.chunks),
      },
    });
    rec.queued = 'waiting';
    scheduleDelivery(entry);
    return true;
  }

  function dropExpired(entry) {
    const now = clock();
    entry.queue = entry.queue.filter((item) => {
      if (now - item.at <= QUEUE_MAX_AGE_MS) return true;
      item.rec.queued = 'dropped';
      return false;
    });
  }

  function scheduleDelivery(entry) {
    if (entry.queueTimer || !entry.queue.length || entry.closed) return;
    entry.queueTimer = setTimeout(() => {
      entry.queueTimer = null;
      deliverQueue(entry).catch(() => {}).finally(() => scheduleDelivery(entry));
    }, QUEUE_CHECK_MS);
    entry.queueTimer.unref?.();
  }

  // In arrival order, once the origin's port answers; it stops at the first one the origin
  // still can't take.
  async function deliverQueue(entry) {
    if (entry.delivering || !entry.queue.length) return { delivered: 0, left: entry.queue.length };
    entry.delivering = true;
    let delivered = 0;
    try {
      dropExpired(entry);
      const host = hostnameFor(entry.originUrl);
      const port = Number(entry.originUrl.port || (entry.originUrl.protocol === 'https:' ? 443 : 80));
      if (!(await isListening(port, host, 500))) return { delivered, left: entry.queue.length };
      while (entry.queue.length && !entry.closed) {
        const item = entry.queue[0];
        let result;
        try {
          result = await dispatch(entry, item.request, { replayOf: item.seq, delivery: true });
        } catch {
          break;
        }
        if (result.status === 502 || result.status == null) break;
        entry.queue.shift();
        item.rec.queued = 'delivered';
        item.rec.deliveredAs = result.seq;
        delivered += 1;
        bump(entry);
      }
    } finally {
      entry.delivering = false;
    }
    return { delivered, left: entry.queue.length };
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
    if ((rec.status === 400 || rec.status === 403) && hostCheckIn(view.text)) return noticeLocal(entry, rec.path, 'host');
    if (!HTML_TYPE.test(type)) return;
    const link = localLinkIn(view.text, entry.originUrl, entry.hostHeader);
    if (link) noticeLocal(entry, link, 'links');
  }

  // A folder tunnel: trydash itself answers, from the files in the folder.
  function onFolderRequest(entry, req, res) {
    if (refuseStopped(entry, req)) return refuse(res);
    if (gate(entry, req, res)) return;
    const prefs = previewOf(entry);
    if (String(req.url || '').startsWith(RESERVED)) return handleReserved(entry, req, res, prefs);
    if (refuseBlocked(entry, req, res, prefs)) return;
    const rec = startRecord(entry, req);
    // The label changes the page, so a copy cached without it must not come back as a 304.
    if (prefs.inject) delete req.headers['if-none-match'];
    req.on('data', (chunk) => take(rec.requestBody, chunk));
    req.on('end', () => {
      planStatic(entry.folder, req).then(async (plan) => {
        if (prefs.noindex) plan.headers['X-Robots-Tag'] = NOINDEX;
        const page = prefs.inject && req.method === 'GET' && plan.status === 200 && plan.file && HTML_TYPE.test(plan.headers['Content-Type'] || '')
          && Number(plan.headers['Content-Length']) <= MODIFY_CAP && isPageRequest(req.headers);
        const source = page ? (await fs.promises.readFile(plan.file)).toString('latin1') : null;
        if (source != null && wantsExtras(req.headers, source)) {
          const html = injectExtras(source, req.headers['accept-language'], prefs);
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
    if (!gateUpgrade(entry, req)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
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
      queue: [],
      pinTries: new Map(),
      commentRate: new Map(),
      queueTimer: null,
      delivering: false,
      closed: false,
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
    entry.closed = true;
    if (entry.queueTimer) clearTimeout(entry.queueTimer);
    for (const item of entry.queue) item.rec.queued = 'dropped';
    entry.queue = [];
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
      return { count: entry.records.length, total: entry.total, version: entry.version, port: entry.port, target: entry.target, queued: entry.queue.length };
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
    // Delivers the waiting requests now, if the origin is back, without waiting for the next check.
    async deliverQueue(id) {
      return deliverQueue(entryFor(id));
    },
    dropQueue(id) {
      const entry = entryFor(id);
      for (const item of entry.queue) item.rec.queued = 'dropped';
      const dropped = entry.queue.length;
      entry.queue = [];
      bump(entry);
      return { dropped };
    },
    details,
    captured,
    // The cookie the screenshot browser sends, so the owner key never sits in the URL.
    ownerCookie(id) {
      const session = store.get(id);
      if (!session || !session.ownerKey) return null;
      return cookieValue(linkSecret, { id: 'owner', key: session.ownerKey, pinHash: null });
    },
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
