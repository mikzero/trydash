import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { browserScripts, dashboardRoot } from '../src/load-dashboard.js';

function browserSandbox(location) {
  const sandbox = {
    console,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    requestAnimationFrame(fn) { return setTimeout(fn, 0); },
    cancelAnimationFrame(id) { clearTimeout(id); },
    navigator: { platform: 'Linux', clipboard: { writeText() { return Promise.resolve(); } } },
    location: location || { protocol: 'http:', href: 'http://127.0.0.1:8787/' },
    document: {
      readyState: 'complete',
      hidden: false,
      getElementById() { return null; },
      addEventListener() {},
      createElement() { return null; },
      createElementNS(ns, tag) { return this.createElement(tag); },
      querySelector() { return null; },
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  return sandbox;
}

function run(file, sandbox) {
  const code = fs.readFileSync(path.join(dashboardRoot, file), 'utf8');
  if (!vm.isContext(sandbox)) vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: file });
  return sandbox;
}

test('every shipped browser script is listed and loads without Node module globals', () => {
  const onDisk = fs.readdirSync(path.join(dashboardRoot, 'public/js')).filter((name) => name.endsWith('.js')).sort();
  const listed = browserScripts.map((file) => path.basename(file)).sort();
  assert.deepEqual(listed, onDisk);

  const html = fs.readFileSync(path.join(dashboardRoot, 'public/index.html'), 'utf8');
  for (const file of browserScripts) {
    const source = fs.readFileSync(path.join(dashboardRoot, file), 'utf8');
    assert.equal(source.includes('require('), false, file);
    assert.equal(source.includes('module.exports'), false, file);
    assert.equal(source.includes('exports.'), false, file);
    const tag = path.basename(file);
    assert.match(html, new RegExp(`src="js/${tag}"`));
    assert.equal(html.includes(`src="/js/${tag}"`), false);

    const sandbox = browserSandbox();
    assert.equal('module' in sandbox, false);
    assert.equal('require' in sandbox, false);
    assert.equal('exports' in sandbox, false);
    assert.doesNotThrow(() => run(file, sandbox));
  }
});

function element(tag) {
  return {
    tag,
    children: [],
    className: '',
    textContent: '',
    id: '',
    hidden: false,
    disabled: false,
    value: '',
    title: '',
    style: {},
    dataset: {},
    attrs: {},
    append(...kids) { this.children.push(...kids); },
    replaceChildren(...kids) { this.children = kids; },
    setAttribute(name, value) {
      this.attrs[name] = String(value);
      if (name === 'id') this.id = String(value);
      if (name === 'hidden') this.hidden = true;
    },
    removeAttribute(name) {
      delete this.attrs[name];
      if (name === 'hidden') this.hidden = false;
    },
    addEventListener() {},
    querySelector(selector) {
      const found = walkAll(this).find((node) => matches(node, selector));
      return found || null;
    },
    querySelectorAll(selector) {
      return walkAll(this).filter((node) => matches(node, selector));
    },
    closest() { return null; },
    focus() {},
    matches() { return false; },
  };
}

function matches(node, selector) {
  if (selector.startsWith('#')) return node.id === selector.slice(1);
  if (selector.startsWith('.')) return String(node.className).split(/\s+/).includes(selector.slice(1));
  if (selector.startsWith('[data-action')) return Object.prototype.hasOwnProperty.call(node.dataset, 'action');
  return node.tag === selector;
}

function walkAll(node, acc = []) {
  acc.push(node);
  for (const child of node.children || []) walkAll(child, acc);
  return acc;
}

function actions(root) {
  return walkAll(root)
    .map((node) => node.dataset && node.dataset.action)
    .filter(Boolean);
}

function textOf(root) {
  return walkAll(root).map((node) => node.textContent || '').join('\n');
}

test('file: renders the start command and the two phases do not share actions', () => {
  const sandbox = browserSandbox({ protocol: 'file:', href: 'file:///tmp/index.html' });
  const app = element('div');
  app.id = 'app';
  sandbox.document.getElementById = (id) => (id === 'app' ? app : null);
  sandbox.document.createElement = element;
  for (const file of browserScripts) run(file, sandbox);

  assert.equal(app.children[0].dataset.phase, 'file');
  assert.match(textOf(app), /bun server\.js/);
  assert.match(textOf(app), /127\.0\.0\.1:8787/);
  assert.equal(actions(app).includes('create'), false);
  assert.equal(actions(app).includes('recheck'), false);

  const host = element('div');
  sandbox.TryDash.renderPhase(host, { present: false, platform: 'linux', arch: 'x64' });
  assert.equal(host.children[0].dataset.phase, 'install');
  const installActions = actions(host);
  assert.deepEqual(installActions.filter((name) => name === 'recheck'), ['recheck']);
  assert.equal(installActions.includes('create'), false);
  assert.equal(installActions.includes('stop'), false);
  assert.equal(installActions.includes('remove'), false);
  assert.match(textOf(host), /cloudflared/);
  assert.match(textOf(host), /Ricontrolla/);
  assert.equal(host.querySelector('#log-rows'), null);

  sandbox.TryDash.renderPhase(host, { present: true, version: 'cloudflared version 2026.10.0', platform: 'linux' });
  assert.equal(host.children[0].dataset.phase, 'workspace');
  const workspaceActions = actions(host);
  assert.equal(workspaceActions.includes('recheck'), false);
  assert.equal(workspaceActions.includes('create'), true);
  assert.equal(workspaceActions.includes('stop'), true);
  assert.equal(workspaceActions.includes('remove'), true);
  assert.ok(host.querySelector('#log-rows'));
  assert.ok(host.querySelector('#log-detail'));
  assert.equal(textOf(host).includes('Manca cloudflared'), false);
});

test('theme cycles and survives a throwing localStorage', () => {
  const sandbox = browserSandbox();
  sandbox.localStorage = {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('denied'); },
  };
  const html = element('html');
  sandbox.document.documentElement = html;
  for (const file of browserScripts) run(file, sandbox);
  const theme = sandbox.TryDash.theme;
  assert.equal(theme.get(), 'auto');
  assert.equal(theme.cycle(), 'light');
  assert.equal(html.attrs['data-theme'], 'light');
  assert.equal(theme.cycle(), 'dark');
  assert.equal(theme.cycle(), 'auto');
  assert.equal('data-theme' in html.attrs, false);
  theme.set('dark');
  assert.equal(html.attrs['data-theme'], 'dark');
  assert.equal(theme.label('dark'), '☾ scuro');
  assert.equal(theme.label('auto'), '◐ auto');
  assert.equal(typeof sandbox.TryDash.toast, 'function');
  assert.equal(typeof sandbox.TryDash.h, 'function');
});

function workspaceSandbox() {
  const sandbox = browserSandbox();
  sandbox.document.createElement = element;
  for (const file of browserScripts) run(file, sandbox);
  return sandbox;
}

test('sidebar helpers and workspace skeleton', () => {
  const T = workspaceSandbox().TryDash;
  assert.equal(T.shortOrigin('http://127.0.0.1:3000'), ':3000');
  assert.equal(T.shortOrigin('http://localhost:5173'), ':5173');
  assert.equal(T.shortOrigin('https://example.test:8443/x'), 'example.test:8443/x');
  assert.equal(T.statusText({ status: 'starting' }), 'in attesa dell’URL…');
  assert.equal(T.statusText({ status: 'running', url: 'https://a-b.trycloudflare.com' }), 'a-b.trycloudflare.com');
  assert.equal(T.statusText({ status: 'stopped', entryCount: 142 }), 'fermato · 142 righe');
  assert.equal(T.statusText({ status: 'stopped', entryCount: 1 }), 'fermato · 1 riga');
  assert.equal(T.statusText({ status: 'exited', exitCode: null }), 'terminato (codice ?)');
  assert.equal(T.statusText({ status: 'exited', exitCode: 1 }), 'terminato (codice 1)');
  assert.equal(T.pickCurrentId([{ id: 's1' }, { id: 's2' }], 's2'), 's2');
  assert.equal(T.pickCurrentId([{ id: 's1' }], 's99'), 's1');
  assert.equal(T.pickCurrentId([{ id: 's1' }], ''), 's1');
  assert.equal(T.pickCurrentId([], 's1'), null);

  const host = element('div');
  T.renderPhase(host, { present: true, version: 'cloudflared version 2026.10.0' });
  for (const sel of ['#tunnel-list', '#create-form', '#origin', '#origin-preview', '#toasts', '#empty-state', '#offline-banner', '#cf-version']) {
    assert.ok(host.querySelector(sel), sel);
  }
  assert.equal(host.querySelectorAll('#create-form').length, 1);
  assert.ok(actions(host).includes('theme'));
  assert.ok(actions(host).includes('new'));
  assert.equal(host.querySelector('#offline-banner').hidden, true);
});

test('log view helpers and markup', () => {
  const T = workspaceSandbox().TryDash;
  const plain = (value) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(T.chipGroups({ info: 139, error: 2, warn: 1 })).map((c) => c.label), ['Info', 'Avvisi', 'Errori']);
  assert.deepEqual(plain(T.chipGroups({ info: 3, debug: 2, warn: 0 })), [
    { group: 'info', label: 'Info', count: 3 },
    { group: 'debug', label: 'Debug', count: 2 },
  ]);
  assert.deepEqual(plain(T.highlightParts('Failed quic Connection', 'conn')), [
    { text: 'Failed quic ', mark: false },
    { text: 'Conn', mark: true },
    { text: 'ection', mark: false },
  ]);
  assert.deepEqual(plain(T.highlightParts('a<b>(x', '(x')), [{ text: 'a<b>', mark: false }, { text: '(x', mark: true }]);
  assert.deepEqual(plain(T.highlightParts('abc', '')), [{ text: 'abc', mark: false }]);
  assert.deepEqual(plain(T.highlightParts('aXaXa', 'x')).filter((p) => p.mark).length, 2);
  const now = Date.parse('2026-10-07T12:00:00Z');
  assert.equal(T.relativeTime('2026-10-07T11:59:30Z', now), 'adesso');
  assert.equal(T.relativeTime('2026-10-07T11:59:00Z', now), '1 minuto fa');
  assert.equal(T.relativeTime('2026-10-07T11:48:00Z', now), '12 minuti fa');
  assert.equal(T.relativeTime('2026-10-07T11:00:00Z', now), '1 ora fa');
  assert.equal(T.relativeTime('2026-10-07T09:00:00Z', now), '3 ore fa');
  assert.equal(T.relativeTime('2026-10-05T12:00:00Z', now), '2 giorni fa');

  const host = element('div');
  T.renderPhase(host, { present: true, version: 'v' });
  for (const sel of ['#log-rows', '#log-detail', '#log-search', '#level-chips', '#log-scroller', '#log-spacer', '#new-rows', '#log-count', '#tunnel-status', '#tunnel-url', '#tunnel-sub']) {
    assert.ok(host.querySelector(sel), sel);
  }
  for (const a of ['create', 'stop', 'remove', 'restart', 'copy-url', 'open', 'copy-cmd']) assert.ok(actions(host).includes(a), a);
  assert.equal(actions(host).includes('recheck'), false);
  assert.equal(host.querySelector('#log-detail').hidden, true);
  assert.ok(actions(host).includes('menu'));
});

test('detail panel never renders a literal null for missing fields', () => {
  const T = workspaceSandbox().TryDash;
  const nodes = T.buildDetail({ index: 3, level: 'info', message: 'retrying connection', timestamp: null, url: null, raw: '{}' });
  assert.ok(nodes.length > 0);
  for (const node of nodes) assert.equal(typeof node, 'object', String(node));
  assert.ok(nodes.every((node) => node !== null));
  assert.match(walkAll({ children: nodes }).map((n) => n.textContent || '').join('|'), /nessun timestamp/);
});

function domSandbox() {
  const sandbox = browserSandbox();
  const host = element('div');
  sandbox.document.createElement = element;
  sandbox.document.createTextNode = (text) => ({ tag: '#text', textContent: String(text), children: [] });
  sandbox.document.getElementById = (id) => host.querySelector(`#${id}`);
  sandbox.document.querySelector = (selector) => host.querySelector(selector);
  sandbox.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ offset: 0, limit: 200, total: 0, entries: [] }) });
  for (const file of browserScripts) run(file, sandbox);
  return { sandbox, host, T: sandbox.TryDash };
}

test('a malformed hash is ignored instead of throwing', () => {
  const { T } = domSandbox();
  assert.equal(T.readHash('#%E0'), '');
  assert.equal(T.readHash('#s2'), 's2');
  assert.equal(T.readHash(''), '');
});

test('install phase can show toasts', () => {
  const { T } = domSandbox();
  const host = element('div');
  T.renderPhase(host, { present: false, platform: 'linux', arch: 'x64' });
  assert.ok(host.querySelector('#toasts'));
});

test('sidebar tunnels are buttons and an unchanged poll does not rebuild them', () => {
  const { T, host } = domSandbox();
  T.renderPhase(host, { present: true, version: 'v' });
  const sessions = [
    { id: 's1', origin: 'http://127.0.0.1:3000', status: 'running', url: 'https://a.trycloudflare.com', entryCount: 3, counts: { error: 1 } },
    { id: 's2', origin: 'http://127.0.0.1:8080', status: 'stopped', url: null, entryCount: 9, counts: {} },
  ];
  T.paintSidebar({ sessions, currentId: 's1' });
  const list = host.querySelector('#tunnel-list');
  const first = list.children[0];
  const button = first.children.find((child) => child.tag === 'button');
  assert.ok(button, 'tunnel item has a button');
  assert.equal(button.dataset.session, 's1');
  T.paintSidebar({ sessions: JSON.parse(JSON.stringify(sessions)), currentId: 's1' });
  assert.equal(list.children[0], first);
  T.paintSidebar({ sessions, currentId: 's2' });
  assert.notEqual(list.children[0], first);
});

test('level chips are not rebuilt when counts are unchanged', () => {
  const { T, host } = domSandbox();
  T.renderPhase(host, { present: true, version: 'v' });
  const view = T.createLogView();
  const summary = { id: 's1', origin: 'http://127.0.0.1:3000', status: 'running', active: true, url: null, entryCount: 3, counts: { info: 2, error: 1 }, restarts: 0, startedAt: '2026-10-07T11:00:00Z', equivalent: 'cloudflared tunnel --url http://127.0.0.1:3000' };
  view.update(summary);
  const chips = host.querySelector('#level-chips');
  const firstChip = chips.children[0];
  view.update({ ...summary });
  assert.equal(chips.children[0], firstChip);
  view.update({ ...summary, entryCount: 4, counts: { info: 3, error: 1 } });
  assert.notEqual(chips.children[0], firstChip);
});

test('scrolling up turns follow off even right next to the bottom', () => {
  const { T } = domSandbox();
  const at = (lastTop, top, follow) => T.followAfterScroll({ lastTop, top, scrollHeight: 1000, clientHeight: 400, follow });
  assert.equal(at(600, 598, true), false);
  assert.equal(at(500, 600, false), true);
  assert.equal(at(300, 350, false), false);
  assert.equal(at(600, 600, true), true);
});

test('the product is branded trydash with its logo', () => {
  const html = fs.readFileSync(path.join(dashboardRoot, 'public/index.html'), 'utf8');
  assert.match(html, /<title>trydash<\/title>/);
  assert.ok(fs.existsSync(path.join(dashboardRoot, 'public/logo.svg')));
  const T = workspaceSandbox().TryDash;
  const host = element('div');
  T.renderPhase(host, { present: true, version: 'v' });
  const text = textOf(host);
  assert.match(text, /trydash/);
  assert.equal(/try logs/.test(text), false);
  assert.ok(host.querySelectorAll('img').some((img) => img.attrs.src === 'logo.svg'));
});

test('warnings and recent mail', () => {
  const T = workspaceSandbox().TryDash;
  const at = '2026-10-09T10:00:00.000Z';
  const base = Date.parse(at);
  const s = { origin: 'http://127.0.0.1:3000', mode: 'origin', active: true, lastOriginError: { at, message: 'x' }, traffic: null };
  const down = T.warningsFor(s, base + 59000);
  assert.equal(down.length, 1);
  assert.equal(down[0].id, 'origin-down');
  assert.equal(down[0].kind, 'error');
  assert.equal(down[0].text, 'Il tuo server su :3000 non risponde — è avviato?');
  assert.deepEqual(Array.from(down[0].actions), ['restart', 'hello']);
  assert.equal(T.warningsFor(s, base + 61000).length, 0);
  assert.equal(T.warningsFor({ ...s, active: false }, base).length, 0);
  assert.equal(T.warningsFor({ ...s, mode: 'hello' }, base).length, 0);

  const busy = (n) => ({ origin: 'http://127.0.0.1:3000', mode: 'origin', active: true, lastOriginError: null, traffic: { inflight: n } });
  assert.equal(T.warningsFor(busy(149), base).length, 0);
  const near = T.warningsFor(busy(150), base);
  assert.equal(near[0].id, 'near-limit');
  assert.equal(near[0].kind, 'warn');
  assert.equal(near[0].text, 'Vicino al limite di 200 richieste: le altre riceveranno 429.');
  assert.equal(T.warningsFor({ ...busy(150), lastOriginError: { at, message: 'x' } }, base)[0].id, 'origin-down');
  assert.equal(T.warningsFor({ ...busy(180), active: false }, base).length, 0);

  assert.equal(T.loadLevel(149), '');
  assert.equal(T.loadLevel(150), 'warn');
  assert.equal(T.loadLevel(200), 'danger');
  assert.equal(T.loadLevel(null), '');

  const data = {};
  const storage = { getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); } };
  T.rememberMail(['a@b.it', '*@x.it'], storage);
  T.rememberMail(['c@d.it', 'a@b.it'], storage);
  assert.deepEqual(Array.from(T.readRecentMail(storage)), ['c@d.it', 'a@b.it', '*@x.it']);
  T.rememberMail(Array.from({ length: 10 }, (_, i) => `u${i}@x.it`), storage);
  assert.equal(T.readRecentMail(storage).length, 8);
  data['trydash.recentMail'] = '{rotto';
  assert.deepEqual(Array.from(T.readRecentMail(storage)), []);
  data['trydash.recentMail'] = '[1, "ok@x.it"]';
  assert.deepEqual(Array.from(T.readRecentMail(storage)), ['ok@x.it']);
  const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.deepEqual(Array.from(T.readRecentMail(throwing)), []);
  assert.doesNotThrow(() => T.rememberMail(['a@b.it'], throwing));
  assert.equal(T.INFLIGHT_LIMIT, 200);
});

test('create form options, preview and recent mail', () => {
  const sandbox = browserSandbox();
  sandbox.document.createElement = element;
  sandbox.localStorage = { getItem: () => '["*@x.it"]', setItem() {} };
  for (const file of browserScripts) run(file, sandbox);
  const T = sandbox.TryDash;
  const form = T.buildCreateForm();
  sandbox.document.getElementById = (id) => form.querySelector(`#${id}`);
  for (const id of ['allowed-mail', 'host-header', 'no-tls-verify', 'http2-origin', 'mail-summary', 'origin-summary', 'recent-mail']) {
    assert.ok(form.querySelector(`#${id}`), id);
  }
  const nodes = walkAll(form);
  const hello = nodes.find((n) => n.dataset.action === 'hello');
  assert.equal(hello.textContent, 'Prova con Hello World');
  assert.match(textOf(form), /Solo per prove · niente SSE · nessuna garanzia di uptime/);
  const recent = nodes.find((n) => n.dataset.action === 'recent-mail');
  assert.equal(recent.dataset.value, '*@x.it');

  T.previewCommand('3000', { allowedMail: '*@x.it' });
  const preview = form.querySelector('#origin-preview');
  assert.equal(preview.textContent, "→ cloudflared tunnel --url http://127.0.0.1:3000 --allowed-mail '*@x.it'");
  T.previewCommand('3000', { allowedMail: 'x' });
  assert.equal(preview.textContent, 'Indirizzo email non valido: x');
  assert.match(preview.className, /\bbad\b/);
  T.previewCommand('', {});
  assert.equal(preview.textContent, '');

  form.querySelector('#allowed-mail').value = 'a@b.it, *@x.it';
  form.querySelector('#host-header').value = 'app.local';
  form.querySelector('#no-tls-verify').checked = true;
  form.querySelector('#http2-origin').checked = false;
  assert.deepEqual({ ...T.readCreateOptions(form) }, { allowedMail: 'a@b.it, *@x.it', hostHeader: 'app.local', noTlsVerify: true, http2Origin: false });
  T.refreshCreateForm(form);
  assert.equal(form.querySelector('#mail-summary').textContent, 'Accesso via email · 2');
  assert.equal(form.querySelector('#origin-summary').textContent, 'Opzioni origine · TLS non verificato');
  form.querySelector('#no-tls-verify').checked = false;
  T.refreshCreateForm(form);
  assert.equal(form.querySelector('#origin-summary').textContent, 'Opzioni origine · 1');
  form.querySelector('#host-header').value = '';
  form.querySelector('#allowed-mail').value = '';
  T.refreshCreateForm(form);
  assert.equal(form.querySelector('#mail-summary').textContent, 'Accesso via email');
  assert.equal(form.querySelector('#origin-summary').textContent, 'Opzioni origine');
});

test('traffic strip, badges, banners and two-click restart', () => {
  const { T, host } = domSandbox();
  // Italian CLDR groups thousands from five digits on.
  assert.equal(T.formatCount(1284), '1284');
  assert.equal(T.formatCount(12840), '12.840');
  assert.equal(T.formatCount(null), '—');
  assert.equal(T.sparkPoints([], 150, 24), '');
  const top = T.sparkPoints([0, 200], 150, 24).split(' ');
  assert.equal(top[top.length - 1].split(',')[1], '0');
  const low = T.sparkPoints([0], 150, 24).split(' ');
  assert.equal(low[0].split(',')[1], '23');
  assert.equal(low[0].split(',')[0], '149');

  T.renderPhase(host, { present: true, version: 'v' });
  const now = Date.parse('2026-10-09T10:00:00Z');
  const traffic = { inflight: 160, total: 1284, errors: 12, connections: 4, history: [1, 2, 160], ok: true, updatedAt: '2026-10-09T10:00:00Z' };
  const s = {
    id: 's1', origin: 'http://127.0.0.1:3000', mode: 'origin', status: 'running', active: true, url: null, entryCount: 0, counts: {},
    options: { allowedMail: ['a@b.it', '*@x.it'], noTlsVerify: true }, traffic, lastOriginError: null,
  };

  T.paintSidebar({ sessions: [s], currentId: 's1' });
  const item = host.querySelector('#tunnel-list').children[0];
  assert.ok(item.querySelector('.lock'));
  assert.equal(item.querySelector('.lock').attrs.title, 'a@b.it, *@x.it');
  assert.ok(item.querySelector('.tls-off'));
  const fill = item.querySelector('.load-fill');
  assert.match(fill.className, /\bwarn\b/);
  assert.equal(fill.style.width, '80%');
  T.paintSidebar({ sessions: [{ ...s, id: 's2', mode: 'hello', origin: null, options: { allowedMail: [] } }], currentId: 's2' });
  assert.match(textOf(host.querySelector('#tunnel-list')), /Hello World/);

  T.paintTunnelExtras(s, now);
  assert.equal(host.querySelector('#tunnel-traffic').hidden, false);
  assert.equal(host.querySelector('#traffic-inflight').textContent, 'in corso 160/200');
  assert.equal(host.querySelector('#traffic-total').textContent, 'richieste 1284');
  assert.equal(host.querySelector('#traffic-errors').textContent, 'errori 12');
  assert.equal(host.querySelector('#traffic-conn').textContent, 'connessioni 4');
  assert.equal(host.querySelector('#traffic-stale').hidden, true);
  assert.equal(host.querySelector('#traffic-spark').hidden, false);
  const badges = textOf(host.querySelector('#tunnel-badges'));
  assert.match(badges, /Protetto · solo: a@b\.it, \*@x\.it — chi visita deve fare l'accesso/);
  assert.match(badges, /Certificato dell'origine non verificato/);
  const banners = host.querySelector('#tunnel-warnings').children;
  assert.equal(banners.length, 1);
  assert.match(banners[0].className, /\bk-warn\b/);

  const down = { ...s, traffic: { ...traffic, inflight: 1 }, lastOriginError: { at: '2026-10-09T09:59:30Z', message: 'x' } };
  T.paintTunnelExtras(down, now);
  const banner = host.querySelector('#tunnel-warnings').children[0];
  assert.match(banner.className, /\bk-error\b/);
  assert.deepEqual(walkAll(banner).map((n) => n.dataset && n.dataset.action).filter(Boolean), ['force-restart', 'hello']);

  T.paintTunnelExtras({ ...s, traffic: { ...traffic, ok: false } }, now);
  assert.equal(host.querySelector('#traffic-stale').hidden, false);
  assert.equal(host.querySelector('#traffic-stale').textContent, 'dati non aggiornati');
  T.paintTunnelExtras({ ...s, status: 'stopped', active: false }, now);
  assert.equal(host.querySelector('#traffic-spark').hidden, true);
  assert.equal(host.querySelector('#traffic-inflight').hidden, true);
  assert.equal(host.querySelector('#traffic-total').textContent, 'richieste 1284');
  assert.equal(host.querySelector('#tunnel-warnings').children.length, 0);
  T.paintTunnelExtras({ ...s, traffic: null, options: { allowedMail: [] } }, now);
  assert.equal(host.querySelector('#tunnel-traffic').hidden, true);
  assert.equal(host.querySelector('#tunnel-badges').children.length, 0);

  assert.equal(T.needsConfirm('restart', { active: false }), true);
  assert.equal(T.needsConfirm('force-restart', { active: true }), true);
  assert.equal(T.needsConfirm('remove', { active: true }), true);
  assert.equal(T.needsConfirm('remove', { active: false }), false);
  assert.equal(T.needsConfirm('stop', { active: true }), false);
  assert.equal(T.armedLabel('restart'), 'Nuovo URL — conferma');
  assert.equal(T.armedLabel('force-restart'), 'Nuovo URL — conferma');
  assert.equal(T.armedLabel('remove'), 'Conferma rimozione');
  assert.equal(T.confirmStep(null, 'restart', 1000), 'arm');
  assert.equal(T.confirmStep({ action: 'remove', at: 0 }, 'restart', 1000), 'arm');
  assert.equal(T.confirmStep({ action: 'restart', at: 900 }, 'restart', 1000), 'wait');
  assert.equal(T.confirmStep({ action: 'restart', at: 600 }, 'restart', 1000), 'go');
});

test('traffic updates patch the sidebar load bar without rebuilding items', () => {
  const { T, host } = domSandbox();
  T.renderPhase(host, { present: true, version: 'v' });
  const s = { id: 's1', origin: 'http://127.0.0.1:3000', mode: 'origin', status: 'running', active: true, url: null, entryCount: 0, counts: {}, options: { allowedMail: [] },
    traffic: { inflight: 10, total: 1, errors: 0, connections: 1, history: [10], ok: true } };
  T.paintSidebar({ sessions: [s], currentId: 's1' });
  const list = host.querySelector('#tunnel-list');
  const first = list.children[0];
  T.paintSidebar({ sessions: [{ ...s, traffic: { ...s.traffic, inflight: 170, ok: false } }], currentId: 's1' });
  assert.equal(list.children[0], first);
  const fill = first.querySelector('.load-fill');
  assert.equal(fill.style.width, '85%');
  assert.match(fill.className, /\bwarn\b/);
  assert.match(first.querySelector('.load-bar').className, /\bis-stale\b/);
  T.paintSidebar({ sessions: [{ ...s, traffic: null }], currentId: 's1' });
  assert.notEqual(list.children[0], first);
  assert.equal(list.children[0].querySelector('.load-bar'), null);
});

test('the email summary counts addresses, not words, for an Outlook paste', () => {
  const sandbox = browserSandbox();
  sandbox.document.createElement = element;
  for (const file of browserScripts) run(file, sandbox);
  const T = sandbox.TryDash;
  const form = T.buildCreateForm();
  sandbox.document.getElementById = (id) => form.querySelector(`#${id}`);
  form.querySelector('#allowed-mail').value = 'Mario Rossi <mario@x.it>; "Bianchi, Anna" <anna@y.it>';
  T.refreshCreateForm(form);
  assert.equal(form.querySelector('#mail-summary').textContent, 'Accesso via email · 2');
});

test('recent mail drops entries that are not email addresses', () => {
  const T = workspaceSandbox().TryDash;
  const storage = { getItem: () => '["foo", "a@b.it", "*@x.it", "<b>@x"]', setItem() {} };
  assert.deepEqual(Array.from(T.readRecentMail(storage)), ['a@b.it', '*@x.it']);
});

test('near-limit banner is not shown on stale traffic', () => {
  const T = workspaceSandbox().TryDash;
  const s = { origin: 'http://127.0.0.1:3000', mode: 'origin', active: true, lastOriginError: null, traffic: { inflight: 180, ok: false } };
  assert.equal(T.warningsFor(s, Date.now()).length, 0);
  assert.equal(T.warningsFor({ ...s, traffic: { inflight: 180, ok: true } }, Date.now())[0].id, 'near-limit');
});
