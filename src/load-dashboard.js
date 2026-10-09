import vm from 'node:vm';
import { projectRoot, readAsset } from './assets.js';

export const libraryScripts = [
  'public/js/i18n-it.js',
  'public/js/i18n-en.js',
  'public/js/i18n.js',
  'public/js/parse.js',
  'public/js/command.js',
  'public/js/install-gate.js',
  'public/js/window.js',
  'public/js/sessions.js',
];

export const browserScripts = [
  ...libraryScripts,
  'public/js/dom.js',
  'public/js/theme.js',
  'public/js/toast.js',
  'public/js/sidebar.js',
  'public/js/warnings.js',
  'public/js/recent-mail.js',
  'public/js/logview.js',
  'public/js/app.js',
];

let cached = null;

export function loadDashboard() {
  if (cached) return cached;
  const sandbox = { console, URL, URLSearchParams };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const rel of libraryScripts) {
    const code = readAsset(rel).toString('utf8');
    vm.runInContext(code, sandbox, { filename: rel });
  }
  if (!sandbox.TryDash) throw new Error('TryDash missing after load');
  cached = sandbox.TryDash;
  return cached;
}

export const dashboardRoot = projectRoot;
