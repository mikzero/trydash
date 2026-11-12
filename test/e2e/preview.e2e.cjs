// End to end, optional: `npm run test:e2e` (needs Playwright with Chromium, and openssl).
// trydash starts from the command line with a fake cloudflared; a real Chromium is the
// client; a local HTTPS server plays Cloudflare's edge, with *.trycloudflare.com resolved
// to it. Stand-ins for WordPress, Vite and Laravel run on uncommon ports. The client can't
// reach the developer's localhost, so any request there counts as a leak.
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('test:e2e needs Playwright: npm i -D playwright && npx playwright install chromium');
  process.exit(2);
}
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

if (process.platform === 'win32') {
  console.error('test:e2e runs on macOS and Linux (the fake cloudflared is a shell script)');
  process.exit(2);
}
const HERE = __dirname;
const REPO = path.resolve(__dirname, '..', '..');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'trydash-e2e-'));
const SHOTS = process.env.E2E_SHOTS || path.join(WORK, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(path.join(WORK, 'bin'));
// Prints a URL of its own per tunnel, like the real one.
fs.writeFileSync(path.join(WORK, 'bin', 'cloudflared'), `#!/bin/sh
if [ "$1" = "--version" ]; then echo "cloudflared version 2026.10.0 (fake)"; exit 0; fi
echo '{"level":"info","message":"Requesting new quick Tunnel on trycloudflare.com..."}'
echo "{\\"level\\":\\"info\\",\\"message\\":\\"|  https://e2e-$$.trycloudflare.com |\\"}"
exec sleep 3600
`, { mode: 0o755 });
const cert = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(WORK, 'edge.key'), '-out', path.join(WORK, 'edge.crt'),
  '-days', '1', '-subj', '/CN=*.trycloudflare.com', '-addext', 'subjectAltName=DNS:*.trycloudflare.com'], { stdio: 'ignore' });
if (cert.status !== 0) {
  console.error('test:e2e needs openssl for the edge certificate');
  process.exit(2);
}
const BUN = process.env.BUN || 'bun';
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startDashboard(port, args) {
  const env = { ...process.env, PATH: `${WORK}/bin:${process.env.PATH}`, TRYDASH_TOKEN: 'tk', TRYDASH_CONFIG: 'off' };
  const proc = spawn(BUN, ['server.js', ...args, '--port', String(port), '--no-open'], { cwd: REPO, env });
  let out = '';
  proc.stdout.on('data', (c) => { out += c; });
  proc.stderr.on('data', (c) => { out += c; });
  return { proc, port, log: () => out };
}

async function api(port, method, p, body) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method, headers: { Authorization: 'Bearer tk', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try { return { status: res.status, json: JSON.parse(text) }; } catch { return { status: res.status, text }; }
}

const DASHBOARDS = [18799, 18798];
async function targetFor(host) {
  for (const port of DASHBOARDS) {
    const state = await api(port, 'GET', '/api/state').catch(() => null);
    const s = state && state.json && state.json.sessions.find((x) => x.url === `https://${host}`);
    if (s && s.active) return s.inspect && s.inspect.enabled ? s.inspect.target : null;
  }
  return null;
}

// What cloudflared does: same request, Host = the public name, plus Cloudflare's headers.
function forward(target, { method, pathAndQuery, headers, body }) {
  const t = new URL(target);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: t.hostname, port: t.port, method, path: pathAndQuery, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

// The edge: a real HTTPS server on 127.0.0.1:18443. Chromium resolves *.trycloudflare.com to it,
// so redirects, cookies and WebSockets go over the network as they would for a client.
const https = require('node:https');
const EDGE_PORT = 18443;
const edgeLog = [];
function startEdge() {
  const server = https.createServer({ key: fs.readFileSync(path.join(WORK, 'edge.key')), cert: fs.readFileSync(path.join(WORK, 'edge.crt')) }, async (req, res) => {
    const host = String(req.headers.host || '').replace(/:\d+$/, '');
    const target = await targetFor(host);
    if (!target) { res.writeHead(530); return res.end('Cloudflare: tunnel not found'); }
    const t = new URL(target);
    const headers = { ...req.headers, host, 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-proto': 'https' };
    const up = http.request({ hostname: t.hostname, port: t.port, method: req.method, path: req.url, headers, agent: false }, (pres) => {
      const chunks = [];
      pres.on('data', (c) => chunks.push(c));
      pres.on('end', () => {
        const body = Buffer.concat(chunks);
        edgeLog.push({ url: `https://${host}${req.url}`, method: req.method, status: pres.statusCode, headers: pres.headers, body });
        res.writeHead(pres.statusCode, pres.headers);
        res.end(body);
      });
    });
    up.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  server.on('upgrade', async (req, socket, head) => {
    const host = String(req.headers.host || '').replace(/:\d+$/, '');
    const t = new URL(await targetFor(host));
    const up = net.connect(Number(t.port), t.hostname, () => {
      let line = `${req.method} ${req.url} HTTP/1.1\r\n`;
      const headers = { ...req.headers, host, 'cf-connecting-ip': '203.0.113.7' };
      for (const [k, v] of Object.entries(headers)) line += `${k}: ${v}\r\n`;
      up.write(`${line}\r\n`);
      if (head && head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });
  return server.listen(EDGE_PORT, '127.0.0.1');
}

async function edgeContext(browser, opts = {}) {
  const context = await browser.newContext({ locale: 'it-IT', deviceScaleFactor: 2, viewport: { width: 1000, height: 640 }, ignoreHTTPSErrors: true, ...opts });
  context.leaks = [];
  // Every request the client makes to the developer's machine, redirects included.
  context.on('request', (r) => { if (/^(https?|wss?):\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//.test(r.url())) context.leaks.push(r.url()); });
  context.on('websocket', () => {});
  return context;
}

async function waitFor(fn, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const v = await fn();
    if (v) return v;
    await sleep(100);
  }
  return null;
}

(async () => {
  const origins = await import(path.join(HERE, 'origins.mjs'));
  const servers = [origins.wordpress(18090), origins.vite(15173), origins.laravel(18000)];
  const main = startDashboard(18799, []);
  // Laravel goes through the CLI flags.
  const cli = startDashboard(18798, ['18000', '--rewrite', '--block', '/telescope', '--badge']);
  await sleep(2000);
  const edge = startEdge();
  const noProxy = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(https?|all|no)_proxy$/i.test(k)));
  const browser = await chromium.launch({ env: noProxy, args: ['--no-proxy-server', `--host-resolver-rules=MAP *.trycloudflare.com:443 127.0.0.1:${EDGE_PORT}`] });
  try {
    // ---------------- WordPress, first without rewriting ----------------
    const wp = (await api(18799, 'POST', '/api/sessions', { origin: '18090' })).json.session;
    const wpUrl = await waitFor(async () => (await api(18799, 'GET', '/api/state')).json.sessions.find((s) => s.id === wp.id).url);
    check('WordPress tunnel up with noindex on by default', wpUrl && wp.options.noindex === true, wpUrl);

    const client = await edgeContext(browser);
    const page = await client.newPage();
    await page.goto(`${wpUrl}/`).catch(() => {});
    check('without rewriting the client is sent to localhost (what really happens)', client.leaks.some((l) => l.startsWith('http://localhost:18090/')), client.leaks[0]);
    const noticed = await waitFor(async () => (await api(18799, 'GET', '/api/state')).json.sessions.find((s) => s.id === wp.id).localRedirect);
    check('trydash notices the redirect to localhost', noticed && noticed.kind === 'redirect', noticed && noticed.location);

    const dash = await browser.newPage({ locale: 'it-IT', viewport: { width: 1280, height: 760 }, deviceScaleFactor: 2 });
    await dash.goto('http://127.0.0.1:18799/?token=tk');
    await dash.click(`[data-session="${wp.id}"]`);
    await dash.waitForSelector('[data-action="enable-rewrite"]', { timeout: 5000 });
    check('the dashboard shows the banner', /rimanda i visitatori a http:\/\/localhost:18090/.test(await dash.locator('#tunnel-warnings').innerText()));
    await dash.screenshot({ path: `${SHOTS}/1-banner.png` });
    await dash.click('[data-action="enable-rewrite"]');
    const on = await waitFor(async () => (await api(18799, 'GET', '/api/state')).json.sessions.find((s) => s.id === wp.id).options.rewrite);
    check('"Rewrite local URLs" turns rewriting on, same URL', on && (await api(18799, 'GET', '/api/state')).json.sessions.find((s) => s.id === wp.id).url === wpUrl);
    await dash.waitForTimeout(600);
    check('the banner goes away', (await dash.locator('.warning').count()) === 0);

    // ---------------- WordPress with rewriting ----------------
    client.leaks.length = 0;
    const hitsBefore = origins.hits.wp.length;
    await page.goto(`${wpUrl}/`);
    await page.waitForFunction(() => document.getElementById('rest') && document.getElementById('rest').textContent !== '…', null, { timeout: 5000 }).catch(() => {});
    check('home page loads on the public URL', page.url() === `${wpUrl}/` && (await page.title()) === 'Bottega Rossi', page.url());
    check('no request tries to reach localhost', client.leaks.length === 0, client.leaks.join(', '));
    check('WordPress got its own Host (localhost:18090)', origins.hits.wp.slice(hitsBefore).every((h) => h.host === 'localhost:18090' || h.url === '/'), [...new Set(origins.hits.wp.slice(hitsBefore).map((h) => h.host))].join(', '));
    check('gzip stylesheet rewritten and applied', (await page.evaluate(() => getComputedStyle(document.body).color)) === 'rgb(180, 83, 42)');
    check('background image in the CSS points to the public URL', (await page.evaluate(() => getComputedStyle(document.querySelector('header')).backgroundImage)).includes(wpUrl));
    check('logo image loads', await page.evaluate(() => document.getElementById('logo').naturalWidth === 1));
    check('REST API via JSON-escaped root works, links rewritten', (await page.locator('#rest').innerText()) === `1 articolo: ${wpUrl}/ciao-mondo/`, await page.locator('#rest').innerText());
    check('links in the page use the public URL', (await page.getAttribute('#post', 'href')) === `${wpUrl}/ciao-mondo/`);
    const homeRes = edgeLog.filter((r) => r.url === `${wpUrl}/` && r.status === 200).pop();
    check('X-Robots-Tag: noindex, nofollow', homeRes && homeRes.headers['x-robots-tag'] === 'noindex, nofollow');
    check('Link header rewritten', homeRes && String(homeRes.headers.link).includes(`<${wpUrl}/wp-json/>`), homeRes && homeRes.headers.link);
    await page.screenshot({ path: `${SHOTS}/2-wp-home.png` });
    await page.click('#post');
    check('following a link stays on the public URL', page.url() === `${wpUrl}/ciao-mondo/` && client.leaks.length === 0);

    // Login: redirect_to goes out public and must come back local for wp_safe_redirect.
    await page.goto(`${wpUrl}/`);
    await page.click('#admin');
    await page.waitForSelector('#loginform');
    check('wp-admin sends to the login page on the public URL', page.url().startsWith(`${wpUrl}/wp-login.php?redirect_to=`), page.url());
    check('login form posts to the public URL', (await page.getAttribute('#loginform', 'action')) === `${wpUrl}/wp-login.php`);
    const testCookie = (await client.cookies(wpUrl)).find((c) => c.name === 'wordpress_test_cookie');
    check('Domain=localhost cookie kept by the browser (Domain dropped)', !!testCookie, testCookie ? `domain ${testCookie.domain}` : 'missing');
    await page.fill('#user_login', 'admin');
    await page.fill('#user_pass', 'password');
    await Promise.all([page.waitForNavigation(), page.click('#wp-submit')]);
    await page.waitForSelector('#dash', { timeout: 5000 }).catch(() => {});
    const post = origins.hits.wp.filter((h) => h.method === 'POST' && h.url === '/wp-login.php').pop();
    check('the posted redirect_to reached WordPress as localhost', post && new URLSearchParams(post.body).get('redirect_to') === 'http://localhost:18090/wp-admin/', post && new URLSearchParams(post.body).get('redirect_to'));
    check('Origin and Referer reached WordPress as localhost', post && post.origin === 'http://localhost:18090' && String(post.referer).startsWith('http://localhost:18090/'), post && `${post.origin} | ${post.referer}`);
    check('logged in: dashboard on the public URL, no fallback', page.url() === `${wpUrl}/wp-admin/` && (await page.locator('#dash').count()) === 1, page.url());
    check('still no request to localhost', client.leaks.length === 0, client.leaks.join(', '));

    // ---------------- Preview panel: WordPress preset + label ----------------
    await dash.click('#preview-button');
    await dash.click('#preview-pop [data-preset="wordpress"]');
    await dash.check('#pv-badge');
    await dash.screenshot({ path: `${SHOTS}/3-panel.png` });
    await dash.click('[data-action="preview-apply"]');
    await dash.waitForTimeout(500);
    const opts = (await api(18799, 'GET', '/api/state')).json.sessions.find((s) => s.id === wp.id).options;
    check('panel saves blocked paths and label', JSON.stringify(opts.blocked) === '["/wp-admin","/wp-login.php","/xmlrpc.php"]' && opts.badge, JSON.stringify(opts.blocked));
    const before = origins.hits.wp.length;
    for (const p of ['/wp-admin/', '/WP-ADMIN/edit.php', '/wp-login.php', '//wp-login.php', '/x/..%2fwp-admin/', '/wp-%61dmin/']) {
      const r = await page.goto(`${wpUrl}${p}`);
      check(`blocked: ${p} → 403`, r.status() === 403 && /Non disponibile in questa anteprima/.test(await page.content()), String(r.status()));
    }
    const xml = await page.evaluate(async (u) => (await fetch(u + '/xmlrpc.php', { method: 'POST', body: '<x/>' })).status, wpUrl);
    check('blocked: POST /xmlrpc.php → 403', xml === 403);
    check('blocked requests never reach WordPress', origins.hits.wp.length === before, `${origins.hits.wp.length - before} reached`);
    await page.screenshot({ path: `${SHOTS}/4-blocked.png` });
    await page.goto(`${wpUrl}/`);
    const badge = page.locator('#trydash-preview');
    check('"Anteprima" label on the page', (await badge.count()) === 1 && (await badge.innerText()) === 'Anteprima');
    check('label does not catch clicks', (await badge.evaluate((n) => getComputedStyle(n).pointerEvents)) === 'none');
    check('page still works with the label (CSS, REST)', (await page.evaluate(() => getComputedStyle(document.body).color)) === 'rgb(180, 83, 42)');
    await page.waitForFunction(() => document.getElementById('rest').textContent !== '…');
    await page.screenshot({ path: `${SHOTS}/5-wp-label.png` });

    await dash.click('#tab-requests');
    await dash.waitForTimeout(800);
    const tags = await dash.locator('.req-tag').allInnerTexts();
    check('Requests tab marks blocked requests ⛔', tags.includes('⛔'), tags.join(' '));
    await dash.screenshot({ path: `${SHOTS}/6-requests.png` });
    const list = (await api(18799, 'GET', `/api/sessions/${wp.id}/requests`)).json.requests;
    const blockedRec = list.find((r) => r.blocked);
    const beforeReplay = origins.hits.wp.length;
    const replay = await api(18799, 'POST', `/api/sessions/${wp.id}/requests/${blockedRec.seq}/replay`);
    check('Replay from the dashboard still reaches the origin', replay.status === 201 && origins.hits.wp.length === beforeReplay + 1, `${blockedRec.method} ${blockedRec.path} → origin ${replay.json.request.status}`);
    const homeRec = list.find((r) => r.path === '/' && r.status === 200);
    const detail = (await api(18799, 'GET', `/api/sessions/${wp.id}/requests/${homeRec.seq}`)).json.request;
    check('inspector shows the origin\'s real body (localhost)', /http:\/\/localhost:18090/.test(detail.responseBody.text || ''));

    // --index
    await api(18799, 'PATCH', `/api/sessions/${wp.id}/options`, { noindex: false });
    const idx = await page.goto(`${wpUrl}/`);
    check('noindex off → no X-Robots-Tag', !(await idx.allHeaders())['x-robots-tag']);
    await api(18799, 'PATCH', `/api/sessions/${wp.id}/options`, { rewrite: false });
    client.leaks.length = 0;
    await page.goto(`${wpUrl}/ciao-mondo/`).catch(() => {});
    check('rewrite off again → back to the localhost redirect', client.leaks.length > 0);

    // ---------------- Vite ----------------
    const v = (await api(18799, 'POST', '/api/sessions', { origin: '15173' })).json.session;
    const vUrl = await waitFor(async () => (await api(18799, 'GET', '/api/state')).json.sessions.find((s) => s.id === v.id).url);
    const vp = await client.newPage();
    const blockedRes = await vp.goto(`${vUrl}/`);
    check('Vite refuses the public host without rewriting', blockedRes.status() === 403);
    const vNotice = await waitFor(async () => (await api(18799, 'GET', '/api/state')).json.sessions.find((s) => s.id === v.id).localRedirect);
    check('trydash recognizes Vite\'s host check', vNotice && vNotice.kind === 'host');
    await dash.click(`[data-session="${v.id}"]`);
    await dash.waitForSelector('.warning');
    check('banner explains the host check', /rifiuta l’indirizzo pubblico/.test(await dash.locator('#tunnel-warnings').innerText()));
    await dash.click('[data-action="enable-rewrite"]');
    await dash.waitForTimeout(400);
    client.leaks.length = 0;
    await vp.goto(`${vUrl}/`);
    await vp.waitForFunction(() => document.body.dataset.hmr, null, { timeout: 5000 }).catch(() => {});
    check('Vite app loads with rewriting', (await vp.locator('#app').innerText()) === 'Ciao da Vite');
    check('HMR WebSocket connects through the tunnel', (await vp.evaluate(() => document.body.dataset.hmr)) === 'connected', await vp.evaluate(() => document.body.dataset.hmr));
    check('Vite got 127.0.0.1:15173 as Host, WebSocket included', origins.hits.vite.filter((h) => h.ws).pop().host === '127.0.0.1:15173');

    // ---------------- Laravel through the CLI flags ----------------
    const lState = await waitFor(async () => { const s = (await api(18798, 'GET', '/api/state')).json.sessions[0]; return s && s.url ? s : null; });
    check('CLI: `trydash 18000 --rewrite --block /telescope --badge`', lState && lState.options.rewrite && lState.options.badge && lState.options.blocked[0] === '/telescope', lState && JSON.stringify(lState.options));
    check('CLI prints the public URL', cli.log().includes(`→ ${lState.url}`));
    const lp = await client.newPage();
    client.leaks.length = 0;
    await lp.goto(`${lState.url}/`);
    check('Laravel: first visit lands on the public URL', lp.url() === `${lState.url}/` && (await lp.title()) === 'Officina', lp.url());
    check('Laravel: asset from APP_URL rewritten and applied', (await lp.evaluate(() => getComputedStyle(document.body).color)) === 'rgb(1, 2, 3)');
    await lp.click('#login');
    await lp.fill('input[name=email]', 'a@b.it');
    await Promise.all([lp.waitForNavigation(), lp.click('button')]);
    check('Laravel: CSRF + session cookies, redirect to /dashboard on the public URL', lp.url() === `${lState.url}/dashboard` && (await lp.locator('#dash').count()) === 1, lp.url());
    check('Laravel: no request to localhost', client.leaks.length === 0, client.leaks.join(', '));
    check('Laravel: label "Anteprima"', (await lp.locator('#trydash-preview').count()) === 1);
    check('Laravel: /telescope → 403', (await lp.goto(`${lState.url}/telescope`)).status() === 403);

    // ---------------- Folder ----------------
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trydash-e2e-site-'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Portfolio</title><h1>Portfolio</h1>');
    fs.mkdirSync(path.join(dir, 'bozze'));
    fs.writeFileSync(path.join(dir, 'bozze', 'idea.html'), 'segreto');
    const f = (await api(18799, 'POST', '/api/sessions', { origin: '', options: { mode: 'folder', folder: dir, badge: true, blocked: '/bozze' } })).json.session;
    const fUrl = await waitFor(async () => (await api(18799, 'GET', '/api/state')).json.sessions.find((s) => s.id === f.id).url);
    const fp = await client.newPage({ locale: 'en-US' });
    const fr = await fp.goto(`${fUrl}/`);
    check('folder: label on index.html, noindex', (await fp.locator('#trydash-preview').count()) === 1 && (await fr.allHeaders())['x-robots-tag'] === 'noindex, nofollow');
    check('folder: /bozze/idea.html → 403', (await fp.goto(`${fUrl}/BOZZE/idea.html`)).status() === 403);
  } catch (error) {
    check('script finished', false, error.stack);
  } finally {
    await browser.close();
    main.proc.kill('SIGTERM');
    cli.proc.kill('SIGTERM');
    for (const s of servers) s.close();
    edge.close();
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    fs.writeFileSync(path.join(WORK, 'results.json'), JSON.stringify(results, null, 2));
    console.log(`screenshots: ${SHOTS}`);
    setTimeout(() => process.exit(failed.length ? 1 : 0), 300);
  }
})();
