import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadDashboard, dashboardRoot } from '../src/load-dashboard.js';
import { createApp } from '../server.js';

const dash = loadDashboard();

test('catalogs match and t fills params', () => {
  const { it, en } = dash.messages;
  assert.deepEqual(Object.keys(en).sort(), Object.keys(it).sort());
  const holes = (s) => (s.match(/\{\w+\}/g) || []).sort();
  for (const k of Object.keys(it)) assert.deepEqual(holes(en[k]), holes(it[k]), k);
  assert.equal(dash.t('options.mailTooMany', { max: 20 }, 'en'), 'At most 20 email addresses');
  assert.equal(dash.t('options.mailTooMany', { max: 20 }, 'fr'), 'Al massimo 20 indirizzi email');
  assert.equal(dash.t('nope.missing', {}, 'en'), 'nope.missing');
});

test('pickLang reads navigator.language and Accept-Language', () => {
  assert.equal(dash.pickLang('it-IT'), 'it');
  assert.equal(dash.pickLang('en-US'), 'en');
  assert.equal(dash.pickLang('fr-FR,en;q=0.8'), 'en');
  assert.equal(dash.pickLang(''), 'it');
  assert.equal(dash.pickLang(undefined), 'it');
  assert.equal(dash.pickLang(';;q=,'), 'it');
});

test('appError and errorBody', () => {
  const e = dash.appError('BAD_OPTIONS', 'options.mailInvalid', { value: 'mario@' });
  assert.equal(e.code, 'BAD_OPTIONS');
  assert.equal(e.message, 'Indirizzo email non valido: mario@');
  assert.deepEqual(JSON.parse(JSON.stringify(dash.errorBody(e, 'en'))), { error: 'Invalid email address: mario@', key: 'options.mailInvalid', params: { value: 'mario@' } });
  assert.equal(dash.errorBody(new Error('boom'), 'it').error, 'Errore del server: boom');
});

test('no hand-written error strings left', () => {
  for (const f of ['public/js/command.js', 'public/js/sessions.js', 'server.js']) {
    const src = fs.readFileSync(path.join(dashboardRoot, f), 'utf8');
    // Keys start lowercase; Italian sentences start uppercase.
    assert.doesNotMatch(src, /new Error\('[A-Z]|fail\('[A-Z]|error: '[A-Za-z]/, f);
  }
});

test('server errors follow Accept-Language', async () => {
  const app = createApp({ probe: async () => ({ present: true, version: 'test' }), spawn() { throw new Error('no spawn'); } });
  await app.listen(0, '127.0.0.1');
  try {
    const en = await fetch(`${app.url}/api/sessions/s99/stop`, { method: 'POST', headers: { 'Accept-Language': 'en-US,en;q=0.9' } });
    assert.equal(en.status, 404);
    const enBody = await en.json();
    assert.equal(enBody.error, 'Session not found');
    assert.equal(enBody.key, 'session.notFound');
    const it = await (await fetch(`${app.url}/api/sessions/s99/stop`, { method: 'POST' })).json();
    assert.equal(it.error, 'Sessione non trovata');
  } finally {
    await app.close();
  }
});
