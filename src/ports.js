// Servers listening on this machine, for the suggestions under the form and `trydash --scan`.
//
// The list comes from the operating system (/proc on Linux, lsof on macOS, netstat on
// Windows): no connection is made, so nothing shows up in the servers' logs. Where that
// list can't be read, the well-known development ports are tried with a plain TCP connect.
// `identify()` goes one step further, only when asked: one `GET /` to tell what answers.

import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

export const COMMON_PORTS = [
  { port: 3000, hint: 'Next.js, React, Express, Rails' },
  { port: 3001, hint: null },
  { port: 3333, hint: 'AdonisJS' },
  { port: 4000, hint: 'Phoenix, Gatsby' },
  { port: 4173, hint: 'Vite preview' },
  { port: 4200, hint: 'Angular' },
  { port: 4321, hint: 'Astro' },
  { port: 5000, hint: 'Flask' },
  { port: 5173, hint: 'Vite' },
  { port: 5174, hint: 'Vite' },
  { port: 5500, hint: 'Live Server' },
  { port: 6006, hint: 'Storybook' },
  { port: 7860, hint: 'Gradio' },
  { port: 8000, hint: 'Django, Laravel, http.server' },
  { port: 8080, hint: null },
  { port: 8081, hint: null },
  { port: 8501, hint: 'Streamlit' },
  { port: 8888, hint: 'Jupyter, MAMP' },
  { port: 9000, hint: null },
  { port: 1313, hint: 'Hugo' },
  { port: 19006, hint: 'Expo' },
];
const HINTS = new Map(COMMON_PORTS.map((item) => [item.port, item.hint]));

// Not web servers, or not yours to share: databases, mail, system services.
const NOT_WEB_PORTS = new Set([21, 22, 23, 25, 53, 110, 111, 135, 139, 143, 445, 465, 587, 631, 993, 995, 1433, 1521,
  2049, 3306, 3389, 5353, 5432, 5900, 6379, 9042, 11211, 27017, 27018, 33060]);
const NOT_WEB_PROCESSES = /^(sshd|systemd.*|cupsd|mysqld|mariadbd|postgres|redis-server|mongod|memcached|dnsmasq|rpcbind|avahi-daemon|cloudflared|rapportd|controlce(nter)?|sharingd|launchd|airplayxpchelper|smbd|nmbd|exim4?|master|chronyd|dockerd|containerd|kdeconnectd?)$/i;
// Ports from here on are mostly picked at random by editors and helpers; only a scan that
// gets an HTTP answer keeps them.
export const EPHEMERAL_FROM = 32768;

export function isListening(port, host, timeoutMs = 250) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    let settled = false;
    const done = (open) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(open);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

// ---- What the operating system says -------------------------------------------------

function hexToIPv4(hex) {
  // /proc writes the address in the machine's byte order: little-endian on the usual CPUs.
  const n = parseInt(hex, 16);
  return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255].join('.');
}

function hexToIPv6(hex) {
  const words = [];
  for (let i = 0; i < 32; i += 8) {
    const w = hex.slice(i, i + 8);
    // Each 32-bit word is little-endian too.
    words.push(w.slice(6, 8) + w.slice(4, 6), w.slice(2, 4) + w.slice(0, 2));
  }
  const groups = words.map((g) => parseInt(g, 16).toString(16));
  const full = groups.join(':');
  if (full === '0:0:0:0:0:0:0:0') return '::';
  if (full === '0:0:0:0:0:0:0:1') return '::1';
  if (/^0:0:0:0:0:ffff:/.test(full)) {
    const v4 = words.slice(6).join('');
    return `::ffff:${parseInt(v4.slice(0, 2), 16)}.${parseInt(v4.slice(2, 4), 16)}.${parseInt(v4.slice(4, 6), 16)}.${parseInt(v4.slice(6, 8), 16)}`;
  }
  return full;
}

// /proc/net/tcp and tcp6: the sockets in LISTEN (state 0A).
export function parseProcNet(text, v6 = false) {
  const out = [];
  for (const line of String(text).split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 10 || cols[3] !== '0A') continue;
    const [addr, port] = cols[1].split(':');
    out.push({ address: v6 ? hexToIPv6(addr) : hexToIPv4(addr), port: parseInt(port, 16), inode: cols[9] });
  }
  return out;
}

// `lsof -nP -iTCP -sTCP:LISTEN -F pcn`: p<pid>, c<command>, n<address:port> lines.
export function parseLsof(text) {
  const out = [];
  let pid = null;
  let command = null;
  for (const line of String(text).split('\n')) {
    const tag = line[0];
    const value = line.slice(1);
    if (tag === 'p') pid = Number(value);
    else if (tag === 'c') command = value;
    else if (tag === 'n') {
      const m = /^(.*):(\d+)$/.exec(value);
      if (!m) continue;
      const address = m[1] === '*' ? '0.0.0.0' : m[1].replace(/^\[|\]$/g, '');
      out.push({ address, port: Number(m[2]), pid, process: command });
    }
  }
  return out;
}

// `netstat -ano -p TCP` (and TCPv6) on Windows.
export function parseNetstat(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(line);
    if (m) out.push({ address: m[1].replace(/^\[|\]$/g, ''), port: Number(m[2]), pid: Number(m[3]) });
  }
  return out;
}

// `tasklist /fo csv /nh`: "name","pid",…
export function parseTasklist(text) {
  const names = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^"([^"]+)","(\d+)"/.exec(line);
    if (m) names.set(Number(m[2]), m[1].replace(/\.exe$/i, ''));
  }
  return names;
}

function run(file, args, timeoutMs = 3000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      resolve(error && !stdout ? null : String(stdout || ''));
    });
  });
}

// Which process owns each socket: only our own processes can be read, which is what we want.
function linuxOwners(inodes, procRoot) {
  const owners = new Map();
  if (!inodes.size) return owners;
  let pids = [];
  try { pids = fs.readdirSync(procRoot).filter((name) => /^\d+$/.test(name)); } catch { return owners; }
  for (const pid of pids) {
    let fds;
    try { fds = fs.readdirSync(path.join(procRoot, pid, 'fd')); } catch { continue; }
    for (const fd of fds) {
      let link;
      try { link = fs.readlinkSync(path.join(procRoot, pid, 'fd', fd)); } catch { continue; }
      const m = /^socket:\[(\d+)\]$/.exec(link);
      if (!m || !inodes.has(m[1]) || owners.has(m[1])) continue;
      let name = null;
      try { name = fs.readFileSync(path.join(procRoot, pid, 'comm'), 'utf8').trim(); } catch { name = null; }
      owners.set(m[1], { pid: Number(pid), process: name });
    }
    if (owners.size === inodes.size) break;
  }
  return owners;
}

// Every listening TCP socket, or null when the system won't say.
export async function systemListeners({ platform = process.platform, procRoot = '/proc', exec = run } = {}) {
  if (platform === 'linux') {
    let v4 = null;
    let v6 = null;
    try { v4 = fs.readFileSync(path.join(procRoot, 'net', 'tcp'), 'utf8'); } catch { v4 = null; }
    try { v6 = fs.readFileSync(path.join(procRoot, 'net', 'tcp6'), 'utf8'); } catch { v6 = null; }
    if (v4 == null && v6 == null) return null;
    const list = [...parseProcNet(v4 || ''), ...parseProcNet(v6 || '', true)];
    const owners = linuxOwners(new Set(list.map((item) => item.inode)), procRoot);
    return list.map(({ inode, ...item }) => ({ ...item, ...(owners.get(inode) || { pid: null, process: null }) }));
  }
  if (platform === 'darwin') {
    const out = await exec('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn']);
    return out == null ? null : parseLsof(out);
  }
  if (platform === 'win32') {
    const out = await exec('netstat', ['-ano', '-p', 'TCP']);
    if (out == null) return null;
    const v6 = await exec('netstat', ['-ano', '-p', 'TCPv6']);
    const list = parseNetstat(out + '\n' + (v6 || ''));
    const names = parseTasklist((await exec('tasklist', ['/fo', 'csv', '/nh'])) || '');
    return list.map((item) => ({ ...item, process: names.get(item.pid) || null }));
  }
  return null;
}

function isLoopbackOrAny(address) {
  return ['0.0.0.0', '127.0.0.1', '::', '::1', '::ffff:127.0.0.1', '::ffff:0.0.0.0'].includes(address) || /^127\./.test(address);
}

// One entry per port, with the origin that reaches it from trydash.
export function candidates(listeners, { exclude = [], all = false } = {}) {
  const skip = new Set(exclude.map(Number));
  const byPort = new Map();
  for (const item of listeners) {
    if (!item.port || skip.has(item.port)) continue;
    if (item.process && NOT_WEB_PROCESSES.test(item.process)) continue;
    // High and non-web ports: left out, or with `all` kept and marked `quiet`.
    const quiet = item.port >= EPHEMERAL_FROM || NOT_WEB_PORTS.has(item.port);
    if (quiet && !all) continue;
    const entry = byPort.get(item.port) || { port: item.port, addresses: new Set(), process: null, quiet };
    entry.addresses.add(item.address);
    entry.process = entry.process || item.process || null;
    byPort.set(item.port, entry);
  }
  const out = [];
  for (const entry of byPort.values()) {
    const addrs = Array.from(entry.addresses);
    let origin = null;
    if (addrs.some((a) => ['0.0.0.0', '127.0.0.1', '::ffff:127.0.0.1', '::ffff:0.0.0.0', '::'].includes(a) || /^127\./.test(a))) origin = String(entry.port);
    else if (addrs.includes('::1')) origin = `http://[::1]:${entry.port}`;
    else {
      // Bound to one address of the machine only (a LAN IP, a Docker bridge): use that one.
      const v4 = addrs.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
      if (!v4) continue;
      origin = `http://${v4}:${entry.port}`;
    }
    const found = { port: entry.port, hint: HINTS.get(entry.port) || null, origin, process: entry.process, local: addrs.some(isLoopbackOrAny) };
    if (entry.quiet) found.quiet = true;
    out.push(found);
  }
  return out.sort((a, b) => a.port - b.port);
}

// The listening servers, from the system when possible, else the well-known ports.
// IPv4 first; a server only on ::1 (Vite on some systems) gets an [::1] origin,
// because the 127.0.0.1 one would not reach it.
export async function scanPorts({ ports = COMMON_PORTS, exclude = [], timeoutMs = 250, all = false, listeners = systemListeners } = {}) {
  const fromSystem = listeners ? await listeners().catch(() => null) : null;
  if (fromSystem) return candidates(fromSystem, { exclude, all });
  const skip = new Set(exclude.map(Number));
  const checks = ports.filter((item) => !skip.has(item.port)).map(async (item) => {
    if (await isListening(item.port, '127.0.0.1', timeoutMs)) return { ...item, origin: String(item.port), process: null, local: true };
    if (await isListening(item.port, '::1', timeoutMs)) return { ...item, origin: `http://[::1]:${item.port}`, process: null, local: true };
    return null;
  });
  return (await Promise.all(checks)).filter(Boolean).sort((a, b) => a.port - b.port);
}

// ---- What answers ---------------------------------------------------------------------

// [kind, label, test]. The first that matches wins, so the specific ones come first.
const FINGERPRINTS = [
  ['wordpress', 'WordPress', (r) => /<meta[^>]+generator[^>]+WordPress/i.test(r.body) || /\/wp-(content|includes)\//.test(r.body) || /wordpress/i.test(r.headers['x-redirect-by'] || '') || /api\.w\.org/.test(r.headers.link || '')],
  ['vite', 'Vite', (r) => /\/@vite\/client/.test(r.body) || /Blocked request\. This host/.test(r.body)],
  ['next', 'Next.js', (r) => /next\.js/i.test(r.headers['x-powered-by'] || '') || /__NEXT_DATA__|\/_next\//.test(r.body)],
  ['nuxt', 'Nuxt', (r) => /__NUXT__|\/_nuxt\//.test(r.body)],
  ['sveltekit', 'SvelteKit', (r) => /__sveltekit|data-sveltekit/.test(r.body)],
  ['astro', 'Astro', (r) => /<meta[^>]+generator[^>]+Astro/i.test(r.body)],
  ['gatsby', 'Gatsby', (r) => /<meta[^>]+generator[^>]+Gatsby/i.test(r.body) || /___gatsby/.test(r.body)],
  ['hugo', 'Hugo', (r) => /<meta[^>]+generator[^>]+Hugo/i.test(r.body)],
  ['angular', 'Angular', (r) => /ng-version=|<app-root/.test(r.body)],
  ['storybook', 'Storybook', (r) => /storybook/i.test(r.title || '') || /sb-show-main|storybook-preview/.test(r.body)],
  ['jupyter', 'Jupyter', (r) => /jupyter/i.test(r.title || '') || /jupyter/i.test(r.headers.location || '')],
  ['streamlit', 'Streamlit', (r) => /streamlit/i.test(r.title || '') || /streamlit/i.test(r.body.slice(0, 4000))],
  ['gradio', 'Gradio', (r) => /gradio/i.test(r.body.slice(0, 8000))],
  ['laravel', 'Laravel', (r) => /laravel_session=/i.test(cookieText(r)) || /laravel/i.test(r.body.slice(0, 8000))],
  ['django', 'Django', (r) => /csrftoken=/i.test(cookieText(r)) || /DisallowedHost|Django/.test(r.body.slice(0, 8000)) || /WSGIServer/i.test(r.headers.server || '')],
  ['rails', 'Rails', (r) => /Ruby on Rails|Blocked hosts?:/.test(r.body.slice(0, 8000)) || (r.headers['x-runtime'] && /_session=/.test(cookieText(r)))],
  ['flask', 'Flask', (r) => /werkzeug/i.test(r.headers.server || '')],
  ['fastapi', 'FastAPI', (r) => /uvicorn/i.test(r.headers.server || '') || /swagger-ui|\/docs/.test(r.body.slice(0, 2000)) && /fastapi/i.test(r.body)],
  ['express', 'Express', (r) => /express/i.test(r.headers['x-powered-by'] || '')],
  ['php', 'PHP', (r) => /php/i.test(r.headers['x-powered-by'] || '') || /php/i.test(r.headers.server || '')],
  ['webpack', 'webpack', (r) => /Invalid Host header/.test(r.body)],
  ['nginx', 'nginx', (r) => /nginx/i.test(r.headers.server || '')],
  ['apache', 'Apache', (r) => /apache/i.test(r.headers.server || '')],
  ['caddy', 'Caddy', (r) => /caddy/i.test(r.headers.server || '')],
];

function cookieText(r) {
  return [].concat(r.headers['set-cookie'] || []).join('; ');
}

// Preview options that usually make this kind of site work for a client.
const SUGGEST = {
  wordpress: { rewrite: true, preset: 'wordpress' },
  laravel: { rewrite: true, preset: 'laravel' },
  django: { rewrite: true, preset: 'django' },
  vite: { rewrite: true, preset: null },
  angular: { rewrite: true, preset: null },
  webpack: { rewrite: true, preset: null },
  rails: { rewrite: true, preset: null },
};

const LOCAL_URL = /(?:https?:)?\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?![\w.-])/i;

// What a `GET /` answer says about the server behind it.
export function fingerprint({ status, headers = {}, body = '' }) {
  const title = (/<title[^>]*>([^<]{0,200})<\/title>/i.exec(body) || [])[1];
  const r = { status, headers, body, title: title ? title.replace(/\s+/g, ' ').trim() : null };
  const found = FINGERPRINTS.find(([, , test]) => {
    try { return test(r); } catch { return false; }
  });
  const kind = found ? found[0] : null;
  const suggest = { ...(SUGGEST[kind] || { rewrite: false, preset: null }) };
  // A redirect to localhost, or a host check, means rewriting whatever the framework.
  if (LOCAL_URL.test(headers.location || '') || /Blocked request\. This host|Invalid Host header|DisallowedHost|Invalid HTTP_HOST|Blocked hosts?:/.test(body)) suggest.rewrite = true;
  return { http: true, status, kind, label: found ? found[1] : null, title: r.title, server: headers.server || null, suggest };
}

function getOnce(lib, { host, port, timeoutMs, extra = {} }) {
  return new Promise((resolve) => {
    let done = false;
    let req = null;
    // The socket goes too: a server that hangs up early must not be left half open.
    const finish = (value) => {
      if (done) return;
      done = true;
      if (req) req.destroy();
      resolve(value);
    };
    req = lib.request({
      host, port, method: 'GET', path: '/', agent: false, ...extra,
      headers: { Host: `localhost:${port}`, 'User-Agent': 'trydash-scan', Accept: 'text/html,*/*;q=0.8', 'Accept-Encoding': 'identity', Connection: 'close' },
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        if (size < 128 * 1024) chunks.push(chunk);
        size += chunk.length;
        if (size >= 128 * 1024) res.destroy();
      });
      const end = () => finish({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
      res.on('end', end);
      res.on('close', end);
      res.on('error', end);
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); finish(null); });
    req.on('error', () => finish(null));
    req.end();
  });
}

function hostOf(origin) {
  if (/^\d+$/.test(origin)) return '127.0.0.1';
  try { return new URL(origin).hostname.replace(/^\[|\]$/g, ''); } catch { return '127.0.0.1'; }
}

// One `GET /` (plain HTTP, then HTTPS with any certificate): what kind of server it is.
export async function identify(item, { timeoutMs = 1500 } = {}) {
  const host = hostOf(item.origin);
  const plain = await getOnce(http, { host, port: item.port, timeoutMs });
  if (plain) return { ...fingerprint(plain), tls: false };
  const secure = await getOnce(https, { host, port: item.port, timeoutMs, extra: { rejectUnauthorized: false, servername: 'localhost' } });
  if (secure) return { ...fingerprint(secure), tls: true };
  return { http: false, status: null, kind: null, label: null, title: null, server: null, suggest: { rewrite: false, preset: null }, tls: false };
}

// The full scan: every listening port (high ones too), each asked once, a few at a time.
export async function deepScan({ exclude = [], timeoutMs = 1500, listeners = systemListeners, identifyImpl = identify, concurrency = 8 } = {}) {
  const found = await scanPorts({ exclude, all: true, listeners });
  const out = new Array(found.length);
  let next = 0;
  async function worker() {
    while (next < found.length) {
      const i = next;
      next += 1;
      const scan = await identifyImpl(found[i], { timeoutMs });
      out[i] = { ...found[i], scan };
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, found.length) }, worker));
  // Quiet ports (high, or usually not web) stay only when they speak HTTP; the others stay
  // anyway, they may just be slow to answer.
  return out.filter((item) => item.scan.http || !item.quiet).map(({ quiet, ...item }) => item);
}

// `trydash --scan`: one line per server, with the command to share it.
export function formatScan(list, presets = {}) {
  if (!list.length) return 'trydash: no web server is listening on this computer.';
  const lines = ['Listening on this computer:', ''];
  for (const item of list) {
    const scan = item.scan || {};
    const what = [scan.label || (scan.http ? `HTTP ${scan.status}` : 'no HTTP answer'), scan.title ? `“${scan.title}”` : null, item.process].filter(Boolean).join(' · ');
    const args = [item.origin];
    if (scan.tls && /^\d+$/.test(item.origin)) args[0] = `https://localhost:${item.port} --no-tls-verify`;
    if (scan.suggest && scan.suggest.rewrite) args.push('--rewrite');
    if (scan.suggest && scan.suggest.preset && presets[scan.suggest.preset]) args.push('--block', presets[scan.suggest.preset].join(','));
    lines.push(`  :${String(item.port).padEnd(6)} ${what}`);
    if (scan.http) lines.push(`          → trydash ${args.join(' ')}`);
  }
  return lines.join('\n');
}
