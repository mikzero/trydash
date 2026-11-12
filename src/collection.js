// Saved requests: the ones the user pins from the Requests tab or imports from
// Postman, HAR or curl. They can carry tokens and signatures, so they are only
// saved on an explicit action, in a file only the user can read
// (~/.config/trydash/requests.json, next to the saved tunnels). Without a file
// (--no-save, TRYDASH_CONFIG=off) they live in memory until trydash closes.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { checkRequest } from './formats.js';

export const MAX_SAVED = 500;
const VERSION = 1;

function appError(code, key, params) {
  return Object.assign(new Error(key), { code, key, params: params || {} });
}

function newId() {
  return `q${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
}

export function createCollection({ file = null, warn = (text) => console.error(text) } = {}) {
  let items = [];

  if (file) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const raw of Array.isArray(data && data.requests) ? data.requests : []) {
        try {
          items.push({ ...checkRequest(raw), id: String(raw.id || newId()), source: String(raw.source || 'saved'), createdAt: raw.createdAt || new Date().toISOString() });
        } catch {
          // A hand-edited entry that no longer passes the checks is left out, not fatal.
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        const backup = `${file}.broken`;
        try { fs.renameSync(file, backup); } catch { /* read-only: leave it */ }
        warn(`trydash: ${file} is not valid, moved to ${backup}`);
      }
    }
  }

  function save() {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const temp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, `${JSON.stringify({ version: VERSION, requests: items }, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temp, file);
    } catch (error) {
      warn(`trydash: cannot save ${file}: ${error.message}`);
    }
  }

  function find(id) {
    const item = items.find((entry) => entry.id === id);
    if (!item) throw appError('NOT_FOUND', 'collection.notFound');
    return item;
  }

  function room(count) {
    if (items.length + count > MAX_SAVED) throw appError('LIMIT', 'collection.tooMany', { max: MAX_SAVED });
  }

  return {
    file,
    list() {
      return items.slice();
    },
    get(id) {
      return find(id);
    },
    add(request, source = 'saved') {
      room(1);
      const item = { ...checkRequest(request), id: newId(), source, createdAt: new Date().toISOString() };
      items.push(item);
      save();
      return item;
    },
    // All or nothing: an import that would pass the limit adds none.
    addMany(requests, source) {
      room(requests.length);
      const added = requests.map((request) => ({ ...checkRequest(request), id: newId(), source, createdAt: new Date().toISOString() }));
      items.push(...added);
      save();
      return added;
    },
    update(id, patch) {
      const item = find(id);
      // A new text body replaces a binary one.
      const merged = { ...item, ...patch };
      if (patch && Object.prototype.hasOwnProperty.call(patch, 'body')) merged.bodyBase64 = null;
      const next = checkRequest(merged);
      Object.assign(item, next);
      save();
      return item;
    },
    remove(id) {
      find(id);
      items = items.filter((entry) => entry.id !== id);
      save();
    },
  };
}
