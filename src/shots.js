// Screenshots of a page as a client saw it, taken with the Chrome (or Chromium, Edge, Brave)
// already on this computer: headless, with a throwaway profile, driven over the DevTools
// protocol. Nothing is installed and the user's own profile is never touched.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const LINUX = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable', 'brave-browser', 'brave'];
const MAC = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
];

function windowsCandidates(env) {
  const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
  const rel = [
    'Google\\Chrome\\Application\\chrome.exe',
    'Microsoft\\Edge\\Application\\msedge.exe',
    'Chromium\\Application\\chrome.exe',
    'BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  ];
  return roots.flatMap((root) => rel.map((r) => path.win32.join(root, r)));
}

function isFile(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

function onPath(name, env) {
  for (const dir of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const file = path.join(dir, name);
    if (isFile(file)) return file;
  }
  return null;
}

// TRYDASH_CHROME first, then the usual places. Null when there is no browser to use.
export function findBrowser({ env = process.env, platform = process.platform, exists = isFile } = {}) {
  if (env.TRYDASH_CHROME) return exists(env.TRYDASH_CHROME) ? env.TRYDASH_CHROME : null;
  if (platform === 'darwin') return MAC.find(exists) || null;
  if (platform === 'win32') return windowsCandidates(env).find(exists) || null;
  for (const name of LINUX) {
    const found = onPath(name, env);
    if (found && exists(found)) return found;
  }
  return null;
}

export function clampViewport(viewport) {
  const v = viewport || {};
  const w = Number(v.w) || 1280;
  const h = Number(v.h) || 800;
  return { width: Math.min(2560, Math.max(320, Math.round(w))), height: Math.min(2000, Math.max(320, Math.round(h))) };
}

// A tiny DevTools client: send(method, params, sessionId) and wait for one event.
function devtools(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    const waiters = [];
    ws.onerror = () => reject(new Error('devtools connection failed'));
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.id && pending.has(msg.id)) {
        const { ok, fail } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) fail(new Error(msg.error.message || 'devtools error'));
        else ok(msg.result || {});
        return;
      }
      for (let i = waiters.length - 1; i >= 0; i -= 1) {
        const w = waiters[i];
        if (w.method === msg.method && (!w.sessionId || w.sessionId === msg.sessionId)) {
          waiters.splice(i, 1);
          w.ok(msg.params || {});
        }
      }
    };
    ws.onopen = () => resolve({
      send(method, params = {}, sessionId) {
        seq += 1;
        const id = seq;
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        return new Promise((ok, fail) => pending.set(id, { ok, fail }));
      },
      once(method, sessionId, timeoutMs) {
        return new Promise((ok) => {
          const w = { method, sessionId, ok };
          waiters.push(w);
          setTimeout(() => {
            const i = waiters.indexOf(w);
            if (i >= 0) { waiters.splice(i, 1); ok(null); }
          }, timeoutMs);
        });
      },
      close() { try { ws.close(); } catch { /* already closed */ } },
    });
  });
}

function waitForEndpoint(proc, timeoutMs) {
  return new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error('the browser did not start')), timeoutMs);
    proc.stderr.on('data', (chunk) => {
      text += chunk;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(text);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    proc.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('the browser closed at start'));
    });
    proc.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

const QUIET_FLAGS = [
  '--headless=new', '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--hide-scrollbars', '--mute-audio', '--disable-extensions', '--disable-sync',
  '--disable-background-networking', '--disable-component-update', '--disable-default-apps',
  '--metrics-recording-only', '--password-store=basic', '--use-mock-keychain',
];

// Opens `url` at the client's screen size, lets the page settle, writes a PNG to `file`.
export async function capture({ browser, url, viewport, file, settleMs = 1200, timeoutMs = 30000, extraArgs = [], spawnImpl = spawn }) {
  const { width, height } = clampViewport(viewport);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'trydash-shot-'));
  const flags = [...QUIET_FLAGS, `--user-data-dir=${profile}`, `--window-size=${width},${height}`];
  // A container running as root has no sandbox to use.
  if (typeof process.getuid === 'function' && process.getuid() === 0) flags.push('--no-sandbox');
  const proc = spawnImpl(browser, [...flags, ...extraArgs, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let client = null;
  const deadline = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
  try {
    client = await devtools(await waitForEndpoint(proc, 15000));
    const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
    await client.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 }, sessionId);
    await client.send('Page.enable', {}, sessionId);
    const loaded = client.once('Page.loadEventFired', sessionId, 20000);
    const nav = await client.send('Page.navigate', { url }, sessionId);
    if (nav.errorText) throw new Error(nav.errorText);
    await loaded;
    // The comments widget loads its pins after the page: give it a moment.
    await new Promise((r) => setTimeout(r, settleMs));
    const shot = await client.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'), { mode: 0o600 });
    await client.send('Browser.close').catch(() => {});
    return { width, height };
  } finally {
    clearTimeout(deadline);
    if (client) client.close();
    setTimeout(() => { if (proc.exitCode == null && proc.signalCode == null) proc.kill('SIGKILL'); }, 2000).unref?.();
    await new Promise((r) => (proc.exitCode != null || proc.signalCode != null ? r() : proc.once('exit', r)));
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

// One screenshot at a time: a browser start is heavy, and comments come in bursts.
export function createShooter({ browser = findBrowser(), extraArgs = [], captureImpl = capture } = {}) {
  let chain = Promise.resolve();
  return {
    available: !!browser,
    browser,
    take(job) {
      const run = chain.then(() => captureImpl({ browser, extraArgs, ...job }));
      chain = run.catch(() => {});
      return run;
    },
  };
}
