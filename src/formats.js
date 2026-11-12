// Warnings are { key, params }: the server words them in the caller's language.
// Requests in and out of trydash: Postman collections (v2.0 and v2.1), HAR 1.2
// and pasted curl commands come in as saved requests; saved and captured
// requests go out as Postman or HAR. A request here is only method, path,
// headers and body: the host of an imported URL is dropped, because trydash only
// ever sends to the origin of a tunnel. Postman scripts are never run.

import { Buffer } from 'node:buffer';

export const MAX_IMPORT = 500;
export const MAX_BODY = 256 * 1024;
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
// Headers that describe a hop or a past run, not the request itself.
const SKIP_ON_EXPORT = /^(host|content-length|connection|transfer-encoding|cdn-loop|cf-[\w-]+)$/i;
const SKIP_ON_IMPORT = /^(content-length|connection|keep-alive|transfer-encoding|upgrade|te|trailer|proxy-[\w-]+)$/i;

function appError(key, params) {
  return Object.assign(new Error(key), { code: 'BAD_REQUEST', key, params: params || {} });
}

// Method, path, headers and body as trydash will send them; throws with the field at fault.
export function checkRequest(input) {
  const bad = (field) => appError('collection.invalid', { field });
  const request = input || {};
  const method = String(request.method || 'GET').toUpperCase();
  if (!/^[A-Z][A-Z0-9-]{0,15}$/.test(method)) throw bad('method');
  // Control characters are refused before any clean-up could hide them.
  if (/[\u0000-\u001f\u007f]/.test(String(request.path == null ? '' : request.path))) throw bad('path');
  const path = pathOf(request.path == null ? '/' : request.path);
  if (path == null || path.length > 8192 || /[\s\u0000-\u001f\u007f]/.test(path)) throw bad('path');
  const list = request.headers == null ? [] : request.headers;
  if (!Array.isArray(list) || list.length > 100) throw bad('headers');
  const headers = list.map((pair) => {
    if (!Array.isArray(pair) || pair.length !== 2) throw bad('headers');
    const name = String(pair[0]).trim();
    const value = String(pair[1] == null ? '' : pair[1]);
    if (!HEADER_NAME_RE.test(name) || /[\r\n\u0000]/.test(value) || value.length > 8192) throw bad('headers');
    return [name, value];
  });
  let body = null;
  let bodyBase64 = null;
  if (request.bodyBase64 != null && request.bodyBase64 !== '') {
    bodyBase64 = String(request.bodyBase64);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(bodyBase64) || Buffer.from(bodyBase64, 'base64').length > MAX_BODY) throw bad('body');
  } else if (request.body != null && request.body !== '') {
    body = String(request.body);
    if (Buffer.byteLength(body) > MAX_BODY) throw bad('body');
  }
  const name = String(request.name == null || request.name === '' ? `${method} ${path}` : request.name).replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
  return { name, method, path, headers, body, bodyBase64 };
}

export function bodyBytes(request) {
  if (request.bodyBase64) return Buffer.from(request.bodyBase64, 'base64');
  return Buffer.from(request.body || '', 'utf8');
}

// `https://api.x.com/v1/a?b=1`, `{{baseUrl}}/v1/a`, `api.x.com/v1/a` or `/v1/a` → `/v1/a?b=1`.
export function pathOf(url) {
  let raw = String(url == null ? '' : url).trim();
  if (!raw) return '/';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      return (parsed.pathname || '/') + parsed.search;
    } catch {
      raw = raw.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '');
    }
  } else if (raw.startsWith('{{')) {
    // An unresolved host variable: everything after it is the path.
    raw = raw.replace(/^\{\{[^}]*\}\}/, '');
  } else if (!raw.startsWith('/') && !raw.startsWith('?')) {
    // `api.x.com/v1` or `localhost:3000/v1` start with a host; `users/7` is a path.
    const slash = raw.search(/[/?]/);
    const first = slash < 0 ? raw : raw.slice(0, slash);
    if (/[.:]/.test(first)) raw = slash < 0 ? '/' : raw.slice(slash);
  }
  raw = raw.split('#')[0];
  if (raw.startsWith('?')) raw = `/${raw}`;
  if (!raw.startsWith('/')) raw = `/${raw}`;
  return raw;
}

function hasHeader(headers, name) {
  const wanted = name.toLowerCase();
  return headers.some(([key]) => key.toLowerCase() === wanted);
}

function cleanHeaders(headers) {
  return headers.filter(([name]) => !SKIP_ON_IMPORT.test(name) && !name.startsWith(':'));
}

// ---- Postman

function substitute(text, vars, missing) {
  return String(text == null ? '' : text).replace(/\{\{\s*([\w.$-]+)\s*\}\}/g, (hole, key) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) return String(vars[key]);
    missing.add(key);
    return hole;
  });
}

function variablesOf(list) {
  const vars = {};
  for (const item of Array.isArray(list) ? list : []) {
    if (item && item.key != null && !item.disabled) vars[item.key] = item.value == null ? '' : item.value;
  }
  return vars;
}

// v2.1 stores auth fields as [{ key, value }], v2.0 as an object.
function authField(auth, type, key) {
  const fields = auth[type];
  if (Array.isArray(fields)) {
    const found = fields.find((f) => f && f.key === key);
    return found ? found.value : undefined;
  }
  return fields && typeof fields === 'object' ? fields[key] : undefined;
}

function applyAuth(auth, request, vars, missing, warnings) {
  if (!auth || !auth.type || auth.type === 'noauth') return;
  const v = (key) => substitute(authField(auth, auth.type, key), vars, missing);
  if (auth.type === 'bearer') {
    if (!hasHeader(request.headers, 'authorization')) request.headers.push(['Authorization', `Bearer ${v('token')}`]);
  } else if (auth.type === 'basic') {
    const pair = `${v('username')}:${v('password')}`;
    if (!hasHeader(request.headers, 'authorization')) request.headers.push(['Authorization', `Basic ${Buffer.from(pair).toString('base64')}`]);
  } else if (auth.type === 'apikey') {
    const key = v('key') || 'x-api-key';
    const value = v('value');
    if ((authField(auth, 'apikey', 'in') || 'header') === 'query') {
      request.path += `${request.path.includes('?') ? '&' : '?'}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
    } else if (!hasHeader(request.headers, key)) {
      request.headers.push([key, value]);
    }
  } else {
    warnings.push({ key: 'import.authSkipped', params: { type: auth.type, name: request.name } });
  }
}

function postmanUrl(url, vars, missing) {
  if (url == null) return '/';
  if (typeof url === 'string') return pathOf(substitute(url, vars, missing));
  if (url.raw != null) {
    let path = pathOf(substitute(url.raw, vars, missing));
    // An object URL may list query parameters that are switched off.
    if (Array.isArray(url.query) && url.query.some((q) => q && q.disabled)) {
      const base = path.split('?')[0];
      const on = url.query.filter((q) => q && !q.disabled && q.key != null)
        .map((q) => `${encodeURIComponent(substitute(q.key, vars, missing))}=${encodeURIComponent(substitute(q.value, vars, missing))}`);
      path = on.length ? `${base}?${on.join('&')}` : base;
    }
    return path;
  }
  const segments = Array.isArray(url.path) ? url.path : String(url.path || '').split('/');
  let path = `/${segments.map((s) => substitute(typeof s === 'object' && s ? s.value : s, vars, missing)).filter((s) => s !== '').join('/')}`;
  const query = (Array.isArray(url.query) ? url.query : []).filter((q) => q && !q.disabled && q.key != null);
  if (query.length) path += `?${query.map((q) => `${encodeURIComponent(substitute(q.key, vars, missing))}=${encodeURIComponent(substitute(q.value, vars, missing))}`).join('&')}`;
  return path;
}

function postmanBody(body, request, vars, missing, warnings) {
  if (!body || !body.mode || body.disabled) return;
  const setType = (type) => { if (!hasHeader(request.headers, 'content-type')) request.headers.push(['Content-Type', type]); };
  if (body.mode === 'raw') {
    request.body = substitute(body.raw, vars, missing);
    const language = body.options && body.options.raw && body.options.raw.language;
    if (language === 'json') setType('application/json');
    else if (language === 'xml') setType('application/xml');
  } else if (body.mode === 'urlencoded') {
    const fields = (body.urlencoded || []).filter((f) => f && !f.disabled && f.key != null);
    request.body = fields.map((f) => `${encodeURIComponent(substitute(f.key, vars, missing))}=${encodeURIComponent(substitute(f.value, vars, missing))}`).join('&');
    setType('application/x-www-form-urlencoded');
  } else if (body.mode === 'formdata') {
    const fields = (body.formdata || []).filter((f) => f && !f.disabled && f.key != null);
    const files = fields.filter((f) => f.type === 'file');
    if (files.length) warnings.push({ key: 'import.fileFields', params: { n: files.length, name: request.name } });
    const boundary = `----trydash${Buffer.from(request.name).toString('hex').slice(0, 16)}`;
    const parts = fields.filter((f) => f.type !== 'file').map((f) => `--${boundary}\r\nContent-Disposition: form-data; name="${substitute(f.key, vars, missing).replace(/"/g, '%22')}"\r\n\r\n${substitute(f.value, vars, missing)}\r\n`);
    request.body = `${parts.join('')}--${boundary}--\r\n`;
    setType(`multipart/form-data; boundary=${boundary}`);
  } else if (body.mode === 'graphql') {
    const graphql = body.graphql || {};
    let variables = {};
    try { variables = graphql.variables ? JSON.parse(substitute(graphql.variables, vars, missing)) : {}; } catch { variables = {}; }
    request.body = JSON.stringify({ query: substitute(graphql.query, vars, missing), variables });
    setType('application/json');
  } else {
    warnings.push({ key: 'import.bodySkipped', params: { mode: body.mode, name: request.name } });
  }
}

export function parsePostman(data) {
  const warnings = [];
  const missing = new Set();
  const vars = variablesOf(data.variable);
  const out = [];
  let scripts = 0;
  const countScripts = (node) => {
    if (Array.isArray(node && node.event)) scripts += node.event.filter((e) => e && e.script).length;
  };
  countScripts(data);
  const walk = (items, folder, inheritedAuth) => {
    for (const item of Array.isArray(items) ? items : []) {
      if (!item || typeof item !== 'object') continue;
      countScripts(item);
      const name = folder ? `${folder} / ${item.name || ''}` : String(item.name || '');
      if (Array.isArray(item.item)) {
        walk(item.item, name, item.auth || inheritedAuth);
        continue;
      }
      const raw = item.request;
      if (!raw) continue;
      const req = typeof raw === 'string' ? { method: 'GET', url: raw } : raw;
      const request = {
        name: name || undefined,
        method: req.method || 'GET',
        path: postmanUrl(req.url, vars, missing),
        headers: [],
        body: null,
      };
      const headerList = Array.isArray(req.header) ? req.header : [];
      for (const h of headerList) {
        if (h && !h.disabled && h.key != null) request.headers.push([substitute(h.key, vars, missing).trim(), substitute(h.value, vars, missing)]);
      }
      request.name = request.name || `${request.method} ${request.path}`;
      applyAuth(req.auth || inheritedAuth, request, vars, missing, warnings);
      postmanBody(req.body, request, vars, missing, warnings);
      request.headers = cleanHeaders(request.headers);
      out.push(request);
    }
  };
  walk(data.item, '', data.auth || null);
  if (scripts) warnings.push({ key: 'import.scripts', params: { n: scripts } });
  if (missing.size) warnings.push({ key: 'import.missingVars', params: { names: Array.from(missing).sort().join(', ') } });
  return { requests: out, warnings };
}

// ---- HAR

export function parseHar(data) {
  const warnings = [];
  const entries = data && data.log && Array.isArray(data.log.entries) ? data.log.entries : [];
  const requests = entries.map((entry) => entry && entry.request).filter(Boolean).map((req) => {
    const request = {
      method: req.method || 'GET',
      path: pathOf(req.url),
      headers: cleanHeaders((req.headers || []).filter((h) => h && h.name != null).map((h) => [String(h.name), String(h.value == null ? '' : h.value)])),
      body: null,
    };
    const post = req.postData;
    if (post) {
      if (post.text != null) request.body = String(post.text);
      else if (Array.isArray(post.params)) request.body = post.params.map((p) => `${encodeURIComponent(p.name)}=${encodeURIComponent(p.value || '')}`).join('&');
      if (post.mimeType && !hasHeader(request.headers, 'content-type')) request.headers.push(['Content-Type', post.mimeType]);
    }
    request.name = `${request.method} ${request.path}`;
    return request;
  });
  return { requests, warnings };
}

// ---- curl

// Shell words: '…' literal, "…" with \" \\ \$ \`, $'…' with the usual escapes, \ + newline joins lines.
export function shellWords(text) {
  const words = [];
  let word = null;
  const s = String(text || '');
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (c === '\\' && (s[i + 1] === '\n' || (s[i + 1] === '\r' && s[i + 2] === '\n'))) {
      i += s[i + 1] === '\r' ? 2 : 1;
      continue;
    }
    if (/\s/.test(c)) {
      if (word != null) { words.push(word); word = null; }
      if (c === '\n') words.push('\n');
      continue;
    }
    if (word == null) word = '';
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      word += s.slice(i + 1, end < 0 ? s.length : end);
      i = end < 0 ? s.length : end;
    } else if (c === '$' && s[i + 1] === "'") {
      let j = i + 2;
      for (; j < s.length && s[j] !== "'"; j += 1) {
        if (s[j] === '\\' && j + 1 < s.length) {
          const n = s[j + 1];
          word += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n;
          j += 1;
        } else {
          word += s[j];
        }
      }
      i = j;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < s.length && s[j] !== '"'; j += 1) {
        if (s[j] === '\\' && '"\\$`'.includes(s[j + 1])) { word += s[j + 1]; j += 1; } else word += s[j];
      }
      i = j;
    } else if (c === '\\' && i + 1 < s.length) {
      word += s[i + 1];
      i += 1;
    } else {
      word += c;
    }
  }
  if (word != null) words.push(word);
  return words;
}

const CURL_DATA = new Set(['-d', '--data', '--data-raw', '--data-binary', '--data-ascii', '--data-urlencode']);
const CURL_WITH_VALUE = new Set(['-o', '--output', '-m', '--max-time', '--connect-timeout', '-x', '--proxy', '-e', '--referer', '-A', '--user-agent', '-b', '--cookie', '--retry', '-w', '--write-out', '--cacert', '--cert', '--key', '-r', '--range', '-c', '--cookie-jar', '-T', '--upload-file', '-F', '--form']);

export function parseCurl(text) {
  const warnings = [];
  const words = shellWords(text);
  const commands = [];
  let current = null;
  for (const word of words) {
    if (word === '\n') continue;
    if (word === 'curl' || word.endsWith('/curl')) {
      current = [];
      commands.push(current);
    } else if (current) {
      current.push(word);
    }
  }
  const requests = commands.map((args) => {
    let method = null;
    let url = null;
    const headers = [];
    const data = [];
    let get = false;
    let form = false;
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, null];
      const value = () => (inline != null ? inline : args[(i += 1)]);
      if (flag === '-X' || flag === '--request') method = String(value() || '').toUpperCase();
      else if (arg.startsWith('-X') && arg.length > 2) method = arg.slice(2).toUpperCase();
      else if (flag === '-H' || flag === '--header') {
        const h = String(value() || '');
        const at = h.indexOf(':');
        if (at > 0) headers.push([h.slice(0, at).trim(), h.slice(at + 1).trim()]);
      } else if (CURL_DATA.has(flag)) {
        const raw = value();
        let d = String(raw == null ? '' : raw);
        if (flag === '--data-urlencode') {
          const eq = d.indexOf('=');
          d = eq < 0 ? encodeURIComponent(d) : `${d.slice(0, eq + 1)}${encodeURIComponent(d.slice(eq + 1))}`;
        }
        if (d.startsWith('@')) warnings.push({ key: 'import.fileBody', params: { file: d.slice(1) } });
        else data.push(d);
      } else if (flag === '--json') {
        data.push(String(value() || ''));
        if (!hasHeader(headers, 'content-type')) headers.push(['Content-Type', 'application/json']);
        if (!hasHeader(headers, 'accept')) headers.push(['Accept', 'application/json']);
      } else if (flag === '-u' || flag === '--user') {
        headers.push(['Authorization', `Basic ${Buffer.from(String(value() || '')).toString('base64')}`]);
      } else if (flag === '-I' || flag === '--head') method = 'HEAD';
      else if (flag === '-G' || flag === '--get') get = true;
      else if (flag === '--url') url = value();
      else if (flag === '-A' || flag === '--user-agent') headers.push(['User-Agent', String(value() || '')]);
      else if (flag === '-b' || flag === '--cookie') headers.push(['Cookie', String(value() || '')]);
      else if (flag === '-e' || flag === '--referer') headers.push(['Referer', String(value() || '')]);
      else if (flag === '-F' || flag === '--form') {
        // curl sends a form as a POST; the fields themselves stay out.
        value();
        form = true;
        if (!warnings.some((w) => w.key === 'import.formSkipped')) warnings.push({ key: 'import.formSkipped', params: {} });
      }
      else if (CURL_WITH_VALUE.has(flag)) value();
      else if (!arg.startsWith('-') && url == null) url = arg;
    }
    let path = pathOf(url || '/');
    let body = data.length ? data.join('&') : null;
    if (get && body) {
      path += `${path.includes('?') ? '&' : '?'}${body}`;
      body = null;
    }
    if (body != null && !hasHeader(headers, 'content-type')) headers.push(['Content-Type', 'application/x-www-form-urlencoded']);
    const m = method || (body != null || form ? 'POST' : 'GET');
    return { name: `${m} ${path}`, method: m, path, headers: cleanHeaders(headers), body };
  });
  return { requests, warnings };
}

// Postman, HAR or curl, guessed from the text.
export function parseImport(text, format = 'auto') {
  const source = String(text || '').replace(/^﻿/, '');
  let kind = format;
  let data = null;
  if (kind === 'auto' || kind === 'postman' || kind === 'har') {
    try { data = JSON.parse(source); } catch { data = null; }
    // A Postman API export wraps the collection: { collection: { … } }.
    if (data && data.collection && typeof data.collection === 'object' && !data.item) data = data.collection;
    if (kind === 'auto') {
      if (data && data.log && Array.isArray(data.log.entries)) kind = 'har';
      else if (data && (Array.isArray(data.item) || (data.info && /postman/i.test(String(data.info.schema || ''))))) kind = 'postman';
      else if (/(^|\s)curl\s/.test(source)) kind = 'curl';
      else throw appError('collection.unknownFormat');
    }
    if ((kind === 'postman' || kind === 'har') && !data) throw appError('collection.badJson');
  }
  const parsed = kind === 'har' ? parseHar(data) : kind === 'postman' ? parsePostman(data) : parseCurl(source);
  const requests = [];
  const warnings = parsed.warnings.slice();
  for (const raw of parsed.requests) {
    if (requests.length >= MAX_IMPORT) {
      warnings.push({ key: 'import.tooMany', params: { max: MAX_IMPORT } });
      break;
    }
    try {
      requests.push(checkRequest(raw));
    } catch (error) {
      warnings.push({ key: 'import.skipped', params: { name: raw.name || raw.path, field: error.params.field } });
    }
  }
  return { format: kind, requests, warnings };
}

// ---- Export

function exportHeaders(headers) {
  return (headers || []).filter(([name]) => !SKIP_ON_EXPORT.test(name));
}

function splitPath(path) {
  const [pathname, search = ''] = String(path).split('?');
  const query = search ? search.split('&').filter(Boolean).map((pair) => {
    const eq = pair.indexOf('=');
    return eq < 0 ? { key: pair, value: '' } : { key: pair.slice(0, eq), value: pair.slice(eq + 1) };
  }) : [];
  return { segments: pathname.split('/').filter(Boolean), query };
}

// A Postman v2.1 collection; every URL starts with {{baseUrl}}, set to `baseUrl`.
export function toPostman(requests, { name = 'trydash', baseUrl = 'http://127.0.0.1:3000' } = {}) {
  return {
    info: {
      name,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      description: 'Exported by trydash',
    },
    item: requests.map((r) => {
      const { segments, query } = splitPath(r.path);
      const item = {
        name: r.name || `${r.method} ${r.path}`,
        request: {
          method: r.method,
          header: exportHeaders(r.headers).map(([key, value]) => ({ key, value })),
          url: { raw: `{{baseUrl}}${r.path}`, host: ['{{baseUrl}}'], path: segments, ...(query.length ? { query } : {}) },
        },
      };
      const text = r.bodyBase64 ? null : r.body;
      if (text) item.request.body = { mode: 'raw', raw: text };
      return item;
    }),
    variable: [{ key: 'baseUrl', value: baseUrl }],
  };
}

// HAR 1.2 from inspector details (with their responses).
export function toHar(details, { baseUrl = 'http://127.0.0.1:3000', version = 'dev' } = {}) {
  const base = String(baseUrl).replace(/\/$/, '');
  const pairs = (list) => exportHeaders(list).map(([name, value]) => ({ name, value }));
  const type = (list) => {
    const found = (list || []).find(([name]) => name.toLowerCase() === 'content-type');
    return found ? found[1] : '';
  };
  return {
    log: {
      version: '1.2',
      creator: { name: 'trydash', version },
      entries: details.map((d) => {
        const { query } = splitPath(d.path);
        const entry = {
          startedDateTime: d.startedAt,
          time: d.durationMs || 0,
          request: {
            method: d.method,
            url: base + d.path,
            httpVersion: 'HTTP/1.1',
            cookies: [],
            headers: pairs(d.requestHeaders),
            queryString: query.map((q) => ({ name: q.key, value: q.value })),
            headersSize: -1,
            bodySize: d.requestBody ? d.requestBody.size : 0,
          },
          response: {
            status: d.status || 0,
            statusText: d.statusText || '',
            httpVersion: 'HTTP/1.1',
            cookies: [],
            headers: pairs(d.responseHeaders),
            content: {
              size: d.responseBody ? d.responseBody.size : 0,
              mimeType: type(d.responseHeaders),
              ...(d.responseBody && d.responseBody.text != null ? { text: d.responseBody.text } : {}),
            },
            redirectURL: '',
            headersSize: -1,
            bodySize: d.responseBody ? d.responseBody.size : 0,
          },
          cache: {},
          timings: { send: 0, wait: d.durationMs || 0, receive: 0 },
        };
        if (d.requestBody && d.requestBody.text != null) {
          entry.request.postData = { mimeType: type(d.requestHeaders), text: d.requestBody.text };
        }
        return entry;
      }),
    },
  };
}
