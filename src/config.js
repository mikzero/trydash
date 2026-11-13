// Saved tunnels: what each tunnel is (origin or folder, options), never logs,
// requests, URLs or tokens. They come back stopped at the next start, so
// nothing turns public again without a click.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CONFIG_VERSION = 1;

// ~/.config/trydash (or $XDG_CONFIG_HOME/trydash), %APPDATA%\trydash on Windows.
export function defaultConfigPath({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'trydash', 'tunnels.json');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'trydash', 'tunnels.json');
}

// Two saved tunnels are the same when they would run the same command.
export function tunnelKey(tunnel) {
  return JSON.stringify([tunnel.origin || null, tunnel.options || {}]);
}

function clean(tunnel) {
  const out = { origin: tunnel.origin || null, options: tunnel.options || {} };
  // Personal links and the owner's key, so the same ?tdk= links work after a restart.
  if (typeof tunnel.ownerKey === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(tunnel.ownerKey)) out.ownerKey = tunnel.ownerKey;
  if (Array.isArray(tunnel.links)) {
    out.links = tunnel.links.filter((link) => link && typeof link === 'object'
      && /^l[0-9a-f]{10}$/.test(String(link.id)) && /^[A-Za-z0-9_-]{16,64}$/.test(String(link.key))).slice(0, 50);
  }
  if (Array.isArray(tunnel.comments)) {
    out.comments = tunnel.comments.filter((c) => c && typeof c === 'object' && /^c[0-9a-f]{10}$/.test(String(c.id)) && typeof c.text === 'string').slice(-500);
  }
  return out;
}

export function createConfigFile(file, { warn = (text) => console.error(text) } = {}) {
  return {
    file,
    load() {
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch (error) {
        if (error.code !== 'ENOENT') warn(`trydash: cannot read ${file}: ${error.message}`);
        return [];
      }
      try {
        const data = JSON.parse(text);
        const list = Array.isArray(data && data.tunnels) ? data.tunnels : [];
        const seen = new Set();
        return list.filter((item) => item && typeof item === 'object').map(clean).filter((item) => {
          const key = tunnelKey(item);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      } catch {
        // Keep the broken file for the user instead of overwriting it at the next save.
        const backup = `${file}.broken`;
        try { fs.renameSync(file, backup); } catch { /* read-only: leave it */ }
        warn(`trydash: ${file} is not valid JSON, moved to ${backup}`);
        return [];
      }
    },
    save(tunnels) {
      const seen = new Set();
      const list = tunnels.map(clean).filter((item) => {
        const key = tunnelKey(item);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const body = `${JSON.stringify({ version: CONFIG_VERSION, tunnels: list }, null, 2)}\n`;
      try {
        // The emails of protected tunnels are in here: only the user reads it.
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        const temp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(temp, body, { mode: 0o600 });
        fs.renameSync(temp, file);
        return true;
      } catch (error) {
        warn(`trydash: cannot save ${file}: ${error.message}`);
        return false;
      }
    },
  };
}
