import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createConfigFile, defaultConfigPath, tunnelKey } from '../src/config.js';
import { createApp } from '../server.js';

function quietProcess() {
  const proc = new EventEmitter();
  proc.stdout = Readable.from([]);
  proc.stderr = Readable.from([]);
  proc.pid = 0;
  proc.kill = () => {};
  return proc;
}

test('the saved tunnels live in the user config folder', () => {
  assert.equal(defaultConfigPath({ env: {}, platform: 'linux', home: '/home/me' }), '/home/me/.config/trydash/tunnels.json');
  assert.equal(defaultConfigPath({ env: { XDG_CONFIG_HOME: '/cfg' }, platform: 'linux', home: '/home/me' }), '/cfg/trydash/tunnels.json');
  assert.equal(defaultConfigPath({ env: {}, platform: 'darwin', home: '/Users/me' }), '/Users/me/.config/trydash/tunnels.json');
  assert.equal(defaultConfigPath({ env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, platform: 'win32', home: 'C:\\Users\\me' }),
    path.join('C:\\Users\\me\\AppData\\Roaming', 'trydash', 'tunnels.json'));
});

test('save and load: private file, no duplicates, a broken file is kept aside', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trydash-config-'));
  const file = path.join(dir, 'nested', 'tunnels.json');
  const warnings = [];
  const config = createConfigFile(file, { warn: (w) => warnings.push(w) });
  try {
    assert.deepEqual(config.load(), []);
    const a = { origin: 'http://127.0.0.1:3000', options: { mode: 'origin', allowedMail: ['a@b.it'] } };
    assert.equal(config.save([a, a, { origin: null, options: { mode: 'hello' } }]), true);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    }
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(data.version, 1);
    assert.equal(data.tunnels.length, 2);
    assert.deepEqual(config.load(), [a, { origin: null, options: { mode: 'hello' } }]);
    assert.equal(tunnelKey(a), tunnelKey({ ...a }));
    assert.equal(fs.readdirSync(path.dirname(file)).some((name) => name.endsWith('.tmp')), false);

    fs.writeFileSync(file, '{ not json');
    assert.deepEqual(config.load(), []);
    assert.equal(fs.readFileSync(`${file}.broken`, 'utf8'), '{ not json');
    assert.match(warnings[0], /not valid JSON/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the dashboard saves on create and remove, restores stopped, and restarts with the inspector', async () => {
  const saves = [];
  const persist = { save: (list) => { saves.push(JSON.parse(JSON.stringify(list))); return true; } };
  const spawned = [];
  const app = createApp({ persist, probe: async () => ({ present: true, version: 'test' }), spawn(bin, args) { spawned.push(args); return quietProcess(); } });
  await app.listen(0, '127.0.0.1');
  const call = (method, p, body) => fetch(`${app.url}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const site = fs.mkdtempSync(path.join(os.tmpdir(), 'trydash-restore-'));
  try {
    const { session } = await (await call('POST', '/api/sessions', { origin: '3000', options: { allowedMail: 'a@b.it', expiresIn: 60 } })).json();
    assert.equal(saves.length, 1);
    assert.deepEqual(saves[0][0], { origin: 'http://127.0.0.1:3000', options: session.options, ownerKey: session.ownerKey, links: [] });
    assert.match(session.ownerKey, /^[A-Za-z0-9_-]{22}$/);
    await call('DELETE', `/api/sessions/${session.id}`);
    assert.deepEqual(saves.at(-1), []);

    const restored = app.restoreTunnels([
      { origin: 'http://127.0.0.1:4000', options: { mode: 'origin', allowedMail: [], inspect: true } },
      { origin: null, options: { mode: 'folder', folder: site } },
      { origin: null, options: { mode: 'folder', folder: path.join(site, 'gone') } },
      { origin: 'ftp://nope', options: {} },
    ]);
    assert.equal(restored.length, 2);
    assert.equal(spawned.length, 1);
    const state = await (await fetch(`${app.url}/api/state`)).json();
    assert.deepEqual(state.sessions.map((s) => s.status), ['stopped', 'stopped']);
    assert.match(app.store.get(restored[0].id).entries.at(-1).message, /restored from the saved tunnels/);
    assert.equal(saves.length, 2);

    const res = await call('POST', `/api/sessions/${restored[0].id}/restart`);
    assert.equal(res.status, 200);
    const target = spawned[1][spawned[1].indexOf('--url') + 1];
    assert.notEqual(target, 'http://127.0.0.1:4000');
    assert.equal(app.inspector.has(restored[0].id), true);
    assert.equal((await call('POST', `/api/sessions/${restored[0].id}/restart`)).status, 409);
    assert.equal((await call('POST', '/api/sessions/nope/restart')).status, 404);

    const same = app.describeTunnel('4000', {});
    assert.equal(tunnelKey(same), tunnelKey({ origin: restored[0].origin, options: restored[0].options }));
  } finally {
    await app.close();
    fs.rmSync(site, { recursive: true, force: true });
  }
});
