// Local stand-ins that behave like WordPress, Vite and Laravel where it matters for a preview.
import http from 'node:http';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

export const hits = { wp: [], vite: [], laravel: [] };
// A 1×1 red PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');

function cookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(/;\s*/).filter(Boolean).map((c) => [c.split('=')[0], decodeURIComponent(c.slice(c.indexOf('=') + 1))]));
}

function body(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function gz(res, status, type, text, extra = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding', ...extra });
  res.end(zlib.gzipSync(Buffer.from(text)));
}

function html(res, text, extra = {}) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=UTF-8', ...extra });
  res.end(text);
}

// ---- WordPress: home http://localhost:18090, canonical redirects, wp_safe_redirect, cookies.
export function wordpress(port = 18090) {
  const home = `http://localhost:${port}`;
  const safe = (to, fallback) => {
    try {
      const u = new URL(to, home);
      return u.host === `localhost:${port}` ? u.href : fallback;
    } catch { return fallback; }
  };
  return http.createServer(async (req, res) => {
    const data = await body(req);
    const url = new URL(req.url, home);
    hits.wp.push({ method: req.method, url: req.url, host: req.headers.host, origin: req.headers.origin, referer: req.headers.referer, cookie: req.headers.cookie || '', body: data, ae: req.headers['accept-encoding'] });
    // redirect_canonical(): any other host goes to the home host.
    if (req.headers.host !== `localhost:${port}`) {
      res.writeHead(301, { Location: `${home}${req.url}`, 'X-Redirect-By': 'WordPress' });
      return res.end();
    }
    const c = cookies(req);
    const logged = c.wordpress_logged_in === 'admin|tok';
    if (url.pathname === '/') {
      return html(res, `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Bottega Rossi</title>
<link rel="stylesheet" href="${home}/wp-content/themes/bottega/style.css?ver=1.0">
<link rel="https://api.w.org/" href="${home}/wp-json/">
<script>var wpApiSettings = ${JSON.stringify({ root: `${home}/wp-json/`, nonce: 'abc' })};</script>
</head><body class="home">
<header><img id="logo" src="${home}/wp-content/uploads/logo.png" width="40" height="40" alt="logo"><h1>Bottega Rossi</h1></header>
<nav><a id="post" href="${home}/ciao-mondo/">Ciao mondo</a> · <a id="admin" href="${home}/wp-admin/">Accedi</a></nav>
<form id="search" action="${home}/" method="get"><input name="s" value="pane"><button>Cerca</button></form>
<p id="rest">…</p>
<script>fetch(wpApiSettings.root + 'wp/v2/posts').then(r => r.json()).then(p => { document.getElementById('rest').textContent = p.length + ' articolo: ' + p[0].link; });</script>
</body></html>`, { Link: `<${home}/wp-json/>; rel="https://api.w.org/"` });
    }
    if (url.pathname === '/wp-content/themes/bottega/style.css') {
      return gz(res, 200, 'text/css', `body{color:rgb(180, 83, 42)}header{background:url(${home}/wp-content/uploads/logo.png) no-repeat}`, { ETag: '"css-1"' });
    }
    if (url.pathname === '/wp-content/uploads/logo.png') {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': PNG.length });
      return res.end(PNG);
    }
    if (url.pathname === '/wp-json/wp/v2/posts') {
      return gz(res, 200, 'application/json; charset=UTF-8', JSON.stringify([{ id: 1, title: { rendered: 'Ciao mondo' }, link: `${home}/ciao-mondo/` }]));
    }
    if (url.pathname === '/ciao-mondo/') return html(res, `<title>Ciao mondo – Bottega Rossi</title><h1>Ciao mondo</h1><a href="${home}/">Home</a>`);
    if (url.pathname === '/wp-login.php' && req.method === 'GET') {
      const to = url.searchParams.get('redirect_to') || `${home}/wp-admin/`;
      return html(res, `<title>Accedi ‹ Bottega Rossi</title><form id="loginform" method="post" action="${home}/wp-login.php">
<input name="log" id="user_login"><input name="pwd" id="user_pass" type="password">
<input type="hidden" name="redirect_to" value="${to.replace(/"/g, '&quot;')}"><input type="hidden" name="testcookie" value="1">
<button id="wp-submit">Accedi</button></form>`, { 'Set-Cookie': 'wordpress_test_cookie=WP%20Cookie%20check; Domain=localhost; Path=/; HttpOnly' });
    }
    if (url.pathname === '/wp-login.php' && req.method === 'POST') {
      const form = new URLSearchParams(data);
      if (!c.wordpress_test_cookie) return html(res, '<p id="login_error">I cookie sono bloccati o non supportati dal tuo browser.</p>');
      if (form.get('log') !== 'admin' || form.get('pwd') !== 'password') return html(res, '<p id="login_error">Password errata.</p>');
      const to = safe(form.get('redirect_to') || '', `${home}/wp-admin/?fallback=1`);
      res.writeHead(302, { Location: to, 'Set-Cookie': ['wordpress_logged_in=admin%7Ctok; Path=/; HttpOnly', 'wp-settings-1=x; Path=/wp-admin'] });
      return res.end();
    }
    if (url.pathname.startsWith('/wp-admin')) {
      if (!logged) {
        res.writeHead(302, { Location: `${home}/wp-login.php?redirect_to=${encodeURIComponent(`${home}${req.url}`)}&reauth=1` });
        return res.end();
      }
      return html(res, `<title>Bacheca ‹ Bottega Rossi</title><h1 id="dash">Bacheca</h1><a href="${home}/wp-admin/edit.php">Articoli</a><script>var ajaxurl = '/wp-admin/admin-ajax.php';</script>`);
    }
    if (url.pathname === '/xmlrpc.php') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      return res.end('XML-RPC server accepts POST requests only.');
    }
    res.writeHead(404, { 'Content-Type': 'text/html' });
    res.end('<h1>Pagina non trovata</h1>');
  }).listen(port, '127.0.0.1');
}

// ---- Vite: refuses unknown hosts (server.allowedHosts), HMR over a WebSocket.
const VITE_OK = (host) => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(String(host || ''));
export function vite(port = 15173) {
  const server = http.createServer((req, res) => {
    hits.vite.push({ url: req.url, host: req.headers.host });
    if (!VITE_OK(req.headers.host)) {
      const name = String(req.headers.host).replace(/:\d+$/, '');
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      return res.end(`Blocked request. This host ("${name}") is not allowed.\nTo allow this host, add "${name}" to \`server.allowedHosts\` in vite.config.js.`);
    }
    if (req.url === '/') return html(res, '<!doctype html><title>Vite App</title><div id="app"></div><script type="module" src="/@vite/client"></script><script type="module" src="/src/main.js"></script>');
    if (req.url === '/@vite/client') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      return res.end(`const ws = new WebSocket((location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + '/', 'vite-hmr');
ws.onmessage = (e) => { document.body.dataset.hmr = JSON.parse(e.data).type; };
ws.onerror = () => { document.body.dataset.hmr = 'error'; };`);
    }
    if (req.url === '/src/main.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      return res.end("document.querySelector('#app').textContent = 'Ciao da Vite';");
    }
    res.writeHead(404);
    res.end();
  });
  server.on('upgrade', (req, socket) => {
    hits.vite.push({ url: req.url, host: req.headers.host, ws: true });
    if (!VITE_OK(req.headers.host)) return socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    const accept = crypto.createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: vite-hmr\r\n\r\n`);
    const msg = Buffer.from('{"type":"connected"}');
    socket.write(Buffer.concat([Buffer.from([0x81, msg.length]), msg]));
    socket.on('error', () => {});
  });
  return server.listen(port, '127.0.0.1');
}

// ---- Laravel: APP_URL=http://localhost:18000, absolute url() everywhere, session login.
export function laravel(port = 18000) {
  const app = `http://localhost:${port}`;
  return http.createServer(async (req, res) => {
    const data = await body(req);
    const url = new URL(req.url, app);
    hits.laravel.push({ method: req.method, url: req.url, host: req.headers.host, body: data });
    const c = cookies(req);
    if (url.pathname === '/') return html(res, `<title>Officina</title><link rel="stylesheet" href="${app}/build/assets/app.css"><a id="login" href="${app}/login">Login</a>`);
    if (url.pathname === '/build/assets/app.css') {
      res.writeHead(200, { 'Content-Type': 'text/css' });
      return res.end('body{color:rgb(1, 2, 3)}');
    }
    if (url.pathname === '/login' && req.method === 'GET') {
      return html(res, `<title>Login</title><form id="f" method="POST" action="${app}/login"><input type="hidden" name="_token" value="csrf1"><input name="email"><button>Entra</button></form>`,
        { 'Set-Cookie': ['XSRF-TOKEN=csrf1; path=/; samesite=lax', 'laravel_session=guest; path=/; httponly; samesite=lax'] });
    }
    if (url.pathname === '/login' && req.method === 'POST') {
      if (new URLSearchParams(data).get('_token') !== 'csrf1' || c.laravel_session !== 'guest') {
        res.writeHead(419, { 'Content-Type': 'text/html' });
        return res.end('<h1>419 Page Expired</h1>');
      }
      res.writeHead(302, { Location: `${app}/dashboard`, 'Set-Cookie': 'laravel_session=user; path=/; httponly; samesite=lax' });
      return res.end();
    }
    if (url.pathname === '/dashboard') {
      if (c.laravel_session !== 'user') {
        res.writeHead(302, { Location: `${app}/login` });
        return res.end();
      }
      return html(res, '<title>Dashboard</title><h1 id="dash">Benvenuto</h1>');
    }
    if (url.pathname.startsWith('/telescope')) return html(res, '<h1>Telescope</h1>');
    res.writeHead(404);
    res.end();
  }).listen(port, '127.0.0.1');
}
