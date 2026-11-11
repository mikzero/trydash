// Static folder for "folder" tunnels: answers GET and HEAD from files under one
// directory. Hidden entries (a path segment starting with ".") are never served,
// so a project folder does not leak .env or .git, and nothing outside the folder
// is reachable, symlinks included.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.wasm': 'application/wasm',
};

export function contentType(file) {
  return TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

function appError(code, key, params) {
  return Object.assign(new Error(key), { code, key, params: params || {} });
}

// `~` is the home folder; relative paths start from where trydash runs.
export function resolveFolder(input, cwd = process.cwd()) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) throw appError('BAD_OPTIONS', 'folder.empty');
  const expanded = raw === '~' ? os.homedir() : /^~[\\/]/.test(raw) ? path.join(os.homedir(), raw.slice(2)) : raw;
  const full = path.resolve(cwd, expanded);
  let stat;
  try {
    stat = fs.statSync(full);
  } catch {
    throw appError('BAD_OPTIONS', 'folder.notFound', { path: full });
  }
  if (!stat.isDirectory()) throw appError('BAD_OPTIONS', 'folder.notDirectory', { path: full });
  return fs.realpathSync(full);
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function textPlan(status, text, extra) {
  const body = Buffer.from(text);
  return {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': String(body.length), ...(extra || {}) },
    body,
  };
}

function inside(root, file) {
  const rel = path.relative(root, file);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function listing(dir, urlPath) {
  const entries = (await fsp.readdir(dir, { withFileTypes: true }))
    .filter((entry) => !entry.name.startsWith('.'))
    .sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
  const title = decodeURIComponent(urlPath);
  const items = entries.map((entry) => {
    const name = entry.name + (entry.isDirectory() ? '/' : '');
    return `<li><a href="${escapeHtml(encodeURIComponent(entry.name) + (entry.isDirectory() ? '/' : ''))}">${escapeHtml(name)}</a></li>`;
  });
  if (urlPath !== '/') items.unshift('<li><a href="../">../</a></li>');
  const html = `<!doctype html>
<html lang="it">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{font:15px/1.6 system-ui,sans-serif;max-width:720px;margin:32px auto;padding:0 16px;color:#1c1c1a;background:#f7f7f5}h1{font-size:18px}ul{list-style:none;padding:0}li{border-bottom:1px solid #e4e4df}a{display:block;padding:6px 2px;color:#c2410c;text-decoration:none;font-family:ui-monospace,Menlo,monospace}@media (prefers-color-scheme:dark){body{color:#ecece6;background:#161614}li{border-color:#2e2e2a}a{color:#fb923c}}</style>
<h1>${escapeHtml(title)}</h1>
<ul>
${items.join('\n')}
</ul>
`;
  const body = Buffer.from(html);
  return { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': String(body.length), 'Cache-Control': 'no-cache' }, body };
}

// One `bytes=` range, enough for video seeking; anything else gets the whole file.
function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!match || (match[1] === '' && match[2] === '')) return null;
  let start;
  let end;
  if (match[1] === '') {
    start = Math.max(0, size - Number(match[2]));
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (start > end || start >= size) return { invalid: true };
  return { start, end };
}

// What to answer: { status, headers, body (Buffer) | file + start/end }.
export async function planStatic(root, req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return textPlan(405, 'Metodo non consentito: questa cartella si può solo leggere.\n', { Allow: 'GET, HEAD' });
  }
  const urlPath = String(req.url || '/').split('?')[0].split('#')[0] || '/';
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return textPlan(400, 'Percorso non valido.\n');
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return textPlan(400, 'Percorso non valido.\n');
  const segments = decoded.split('/').filter(Boolean);
  if (segments.some((segment) => segment.startsWith('.'))) return textPlan(404, 'Non trovato.\n');
  const target = path.join(root, ...segments);
  if (!inside(root, target)) return textPlan(404, 'Non trovato.\n');
  let real;
  let stat;
  try {
    real = await fsp.realpath(target);
    stat = await fsp.stat(real);
  } catch {
    return textPlan(404, 'Non trovato.\n');
  }
  if (!inside(root, real)) return textPlan(404, 'Non trovato.\n');

  let file = real;
  if (stat.isDirectory()) {
    if (!urlPath.endsWith('/')) {
      const query = String(req.url || '').includes('?') ? String(req.url).slice(String(req.url).indexOf('?')) : '';
      return { status: 301, headers: { Location: urlPath + '/' + query, 'Content-Length': '0' }, body: Buffer.alloc(0) };
    }
    const index = path.join(real, 'index.html');
    try {
      const indexStat = await fsp.stat(index);
      if (!indexStat.isFile()) throw new Error('not a file');
      file = index;
      stat = indexStat;
    } catch {
      return listing(real, urlPath);
    }
  }
  if (!stat.isFile()) return textPlan(404, 'Non trovato.\n');

  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const headers = {
    'Content-Type': contentType(file),
    'Last-Modified': stat.mtime.toUTCString(),
    ETag: etag,
    'Cache-Control': 'no-cache',
    'Accept-Ranges': 'bytes',
  };
  if (req.headers['if-none-match'] === etag) return { status: 304, headers: { ETag: etag, 'Cache-Control': 'no-cache' }, body: Buffer.alloc(0) };
  const range = req.headers.range ? parseRange(req.headers.range, stat.size) : null;
  if (range && range.invalid) {
    return { status: 416, headers: { 'Content-Range': `bytes */${stat.size}`, 'Content-Length': '0' }, body: Buffer.alloc(0) };
  }
  if (range) {
    return {
      status: 206,
      headers: { ...headers, 'Content-Range': `bytes ${range.start}-${range.end}/${stat.size}`, 'Content-Length': String(range.end - range.start + 1) },
      file,
      start: range.start,
      end: range.end,
    };
  }
  if (stat.size === 0) return { status: 200, headers: { ...headers, 'Content-Length': '0' }, body: Buffer.alloc(0) };
  return { status: 200, headers: { ...headers, 'Content-Length': String(stat.size) }, file, start: 0, end: stat.size - 1 };
}
