// Command line: `trydash [port | url | folder] [options]`, the environment
// variables (TRYDASH_*, with the 1.x names still read) and the browser launch.

import { spawn } from 'node:child_process';
import { loadDashboard } from './load-dashboard.js';

export const HELP = `Usage: trydash [port | url | folder] [options]

Starts the dashboard and, with an argument, opens a quick tunnel right away:
  trydash                  dashboard only
  trydash 3000             tunnel to http://127.0.0.1:3000
  trydash https://localhost:8443 --no-tls-verify
  trydash ./dist           publish a folder
  trydash --scan           list the servers listening on this computer

Options:
  -p, --port <n>           dashboard port (default 8787, or TRYDASH_PORT)
      --open, --no-open    open the dashboard in the browser (default: when run in a terminal)
      --no-save            don't save or restore tunnels (default: saved, restored stopped)
      --hello              a Hello World tunnel
      --mail <list>        only these emails may open the tunnel (*@company.com for a domain)
      --host-header <h>    Host header for the origin
      --no-tls-verify      accept a self-signed origin certificate
      --http2-origin       talk HTTP/2 to the origin (turns the inspector off)
      --no-inspect         don't record requests
      --rewrite            rewrite localhost URLs to the public one (WordPress, Vite, Laravel…)
      --block <paths>      paths visitors get a 403 for: /wp-admin,/wp-login.php
      --badge              a small "Preview" label on HTML pages
      --index              let search engines index the preview (noindex by default)
      --comments           a Comment button on the pages: clients point and write
      --links-only         only personal links get in (create them in the Clients tab)
      --queue              keep POST/PUT/PATCH/DELETE (webhooks) while your server is down,
                           answer 202, and deliver them when it's back
      --expires <time>     stop the tunnel after a while: 30m, 2h, 1d
      --scan               find the web servers on this computer, what they are,
                           and the command to share each one
  -v, --version            print the version
  -h, --help               this help

Environment: TRYDASH_PORT, TRYDASH_TOKEN, TRYDASH_OPEN=0,
  TRYDASH_CONFIG (file of the saved tunnels, or "off").`;

export function helpText() {
  return HELP;
}

// 1.x names, read when the new one is missing. PORT is a common convention, so it stays quiet.
const LEGACY = {
  TRYDASH_PORT: 'PORT',
  TRYDASH_SEED: 'DASHBOARD_SEED',
  TRYDASH_PROBE: 'DASHBOARD_PROBE',
  TRYDASH_PROBE_VERSION: 'DASHBOARD_PROBE_VERSION',
};
const warned = new Set();

export function envValue(env, name, warn = (text) => console.error(text)) {
  if (env[name] != null && env[name] !== '') return env[name];
  const old = LEGACY[name];
  if (!old || env[old] == null || env[old] === '') return undefined;
  if (old !== 'PORT' && !warned.has(old)) {
    warned.add(old);
    warn(`trydash: ${old} is deprecated, use ${name}`);
  }
  return env[old];
}

// `30m`, `2h`, `1d`, or a number of minutes.
export function parseDuration(text) {
  const match = /^(\d+)\s*(m|min|h|d)?$/i.exec(String(text || '').trim());
  if (!match) return null;
  const n = Number(match[1]);
  const unit = (match[2] || 'm').toLowerCase();
  const minutes = unit === 'h' ? n * 60 : unit === 'd' ? n * 1440 : n;
  return minutes > 0 ? minutes : null;
}

function usage(message) {
  return Object.assign(new Error(message), { usage: true });
}

export function parseArgs(argv) {
  const dash = loadDashboard();
  const out = { port: null, open: null, save: null, help: false, version: false, scan: false, target: null };
  const options = {};
  let positional = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i]);
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    const value = () => {
      const next = eq > 0 ? arg.slice(eq + 1) : argv[(i += 1)];
      if (next == null || next === '') throw usage(`${name} needs a value`);
      return String(next);
    };
    switch (name) {
      case '-h': case '--help': out.help = true; break;
      case '-v': case '--version': out.version = true; break;
      case '--scan': out.scan = true; break;
      case '-p': case '--port': {
        const port = Number(value());
        if (!Number.isInteger(port) || port < 0 || port > 65535) throw usage('the port must be a number from 0 to 65535');
        out.port = port;
        break;
      }
      case '--open': out.open = true; break;
      case '--no-open': out.open = false; break;
      case '--no-save': out.save = false; break;
      case '--hello': options.mode = 'hello'; break;
      case '--mail': options.allowedMail = value(); break;
      case '--host-header': options.hostHeader = value(); break;
      case '--no-tls-verify': options.noTlsVerify = true; break;
      case '--http2-origin': options.http2Origin = true; break;
      case '--no-inspect': options.inspect = false; break;
      case '--rewrite': options.rewrite = true; break;
      case '--block': options.blocked = value(); break;
      case '--badge': options.badge = true; break;
      case '--queue': options.queue = true; break;
      case '--links-only': options.linksOnly = true; break;
      case '--comments': options.comments = true; break;
      case '--index': options.noindex = false; break;
      case '--expires': {
        const minutes = parseDuration(value());
        if (!minutes) throw usage('--expires takes a time like 30m, 2h or 1d');
        options.expiresIn = minutes;
        break;
      }
      default:
        if (arg.startsWith('-') && arg !== '-') throw usage(`unknown option ${name}`);
        if (positional != null) throw usage('only one port, URL or folder at a time');
        positional = arg;
    }
  }
  if (options.mode === 'hello') {
    if (positional != null) throw usage('--hello takes no port, URL or folder');
    out.target = { origin: '', options };
  } else if (positional != null) {
    out.target = dash.looksLikeFolder(positional)
      ? { origin: '', options: { ...options, mode: 'folder', folder: positional } }
      : { origin: positional, options };
  } else if (Object.keys(options).length) {
    throw usage('tunnel options need a port, URL or folder');
  }
  if (out.scan && out.target) throw usage('--scan takes no port, URL or folder');
  return out;
}

// The command that opens a URL with the default browser, without a shell in between.
export function browserCommand(platform, url) {
  if (platform === 'darwin') return ['open', [url]];
  if (platform === 'win32') return ['rundll32', ['url.dll,FileProtocolHandler', url]];
  return ['xdg-open', [url]];
}

export function openBrowser(url, { platform = process.platform, spawnImpl = spawn } = {}) {
  const [bin, args] = browserCommand(platform, url);
  try {
    const child = spawnImpl(bin, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on?.('error', () => {});
    child.unref?.();
    return child;
  } catch {
    return null;
  }
}

// Prints the public URL once cloudflared has it, or why there is none.
export function announceUrl(store, id, { log = console.log, everyMs = 200, giveUpMs = 60000 } = {}) {
  const started = Date.now();
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      const session = store.get(id);
      let line = null;
      if (!session) line = '';
      else if (session.url) line = `→ ${session.url}`;
      else if (!session.active) line = `trydash: the tunnel stopped before getting a URL (${session.status})`;
      else if (Date.now() - started > giveUpMs) line = 'trydash: still waiting for the tunnel URL, see the dashboard';
      if (line == null) return;
      clearInterval(timer);
      if (line) log(line);
      resolve(line);
    }, everyMs);
    timer.unref?.();
  });
}
