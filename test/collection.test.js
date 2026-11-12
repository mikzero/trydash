import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { parseImport, parseCurl, shellWords, pathOf, checkRequest, toPostman, toHar, MAX_IMPORT } from '../src/formats.js';
import { createCollection, MAX_SAVED } from '../src/collection.js';
import { createApp } from '../server.js';

const plain = (value) => JSON.parse(JSON.stringify(value));

const POSTMAN = {
  info: { name: 'Shop', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  variable: [{ key: 'baseUrl', value: 'https://api.shop.test' }, { key: 'token', value: 's3cret' }, { key: 'off', value: 'x', disabled: true }],
  auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}' }] },
  event: [{ listen: 'prerequest', script: { exec: ['pm.environment.set("x", 1)'] } }],
  item: [
    { name: 'Orders', item: [
      { name: 'List', request: { method: 'GET', url: { raw: '{{baseUrl}}/v1/orders?limit=20&debug=1', host: ['{{baseUrl}}'], path: ['v1', 'orders'], query: [{ key: 'limit', value: '20' }, { key: 'debug', value: '1', disabled: true }] } } },
      { name: 'Create', request: { method: 'POST', header: [{ key: 'X-Off', value: '1', disabled: true }, { key: 'Content-Length', value: '9' }], url: '{{baseUrl}}/v1/orders', body: { mode: 'raw', raw: '{"sku":"{{sku}}"}', options: { raw: { language: 'json' } } } } },
    ] },
    { name: 'Login', request: { method: 'POST', auth: { type: 'basic', basic: [{ key: 'username', value: 'mario' }, { key: 'password', value: 'pw' }] }, url: 'https://api.shop.test/login', body: { mode: 'urlencoded', urlencoded: [{ key: 'a', value: 'b c' }, { key: 'z', value: '1', disabled: true }] } } },
    { name: 'Key in query', request: { method: 'GET', auth: { type: 'apikey', apikey: [{ key: 'key', value: 'api_key' }, { key: 'value', value: 'k1' }, { key: 'in', value: 'query' }] }, url: 'https://api.shop.test/items?page=2' } },
    { name: 'Form', event: [{ listen: 'test', script: { exec: ['pm.test()'] } }], request: { method: 'POST', url: '/upload', body: { mode: 'formdata', formdata: [{ key: 'title', value: 'Hi', type: 'text' }, { key: 'file', src: '/etc/passwd', type: 'file' }] } } },
    { name: 'GQL', request: { method: 'POST', url: '{{other}}/graphql', body: { mode: 'graphql', graphql: { query: '{ me { id } }', variables: '{"a":1}' } } } },
    { name: 'Bad header', request: { method: 'GET', header: [{ key: 'X-Evil\r\nHost', value: 'x' }], url: '/x' } },
  ],
};

test('Postman v2.1: folders, variables, inherited auth, bodies, and scripts left alone', () => {
  const out = parseImport(JSON.stringify(POSTMAN));
  assert.equal(out.format, 'postman');
  const byName = Object.fromEntries(out.requests.map((r) => [r.name, r]));
  assert.deepEqual(Object.keys(byName), ['Orders / List', 'Orders / Create', 'Login', 'Key in query', 'Form', 'GQL']);
  assert.equal(byName['Orders / List'].path, '/v1/orders?limit=20');
  assert.deepEqual(byName['Orders / List'].headers, [['Authorization', 'Bearer s3cret']]);
  const create = byName['Orders / Create'];
  assert.equal(create.body, '{"sku":"{{sku}}"}');
  assert.deepEqual(create.headers, [['Authorization', 'Bearer s3cret'], ['Content-Type', 'application/json']]);
  assert.deepEqual(byName.Login.headers, [['Authorization', `Basic ${Buffer.from('mario:pw').toString('base64')}`], ['Content-Type', 'application/x-www-form-urlencoded']]);
  assert.equal(byName.Login.body, 'a=b%20c');
  assert.equal(byName['Key in query'].path, '/items?page=2&api_key=k1');
  assert.match(byName.Form.body, /name="title"\r\n\r\nHi\r\n/);
  assert.doesNotMatch(byName.Form.body, /passwd/);
  assert.equal(byName.GQL.path, '/graphql');
  assert.deepEqual(JSON.parse(byName.GQL.body), { query: '{ me { id } }', variables: { a: 1 } });
  const warned = (key) => out.warnings.find((w) => w.key === key);
  assert.deepEqual(warned('import.scripts').params, { n: 2 });
  assert.deepEqual(warned('import.fileFields').params, { n: 1, name: 'Form' });
  assert.deepEqual(warned('import.missingVars').params, { names: 'other, sku' });
  assert.deepEqual(warned('import.skipped').params, { name: 'Bad header', field: 'headers' });

  // v2.0 keeps auth fields as an object, and a collection may be wrapped.
  const v20 = parseImport(JSON.stringify({ collection: { info: { name: 'x', schema: 'https://schema.getpostman.com/json/collection/v2.0.0/collection.json' }, item: [{ name: 'A', request: { method: 'GET', url: 'http://h/a', auth: { type: 'bearer', bearer: { token: 't0' } } } }] } }));
  assert.deepEqual(plain(v20.requests[0].headers), [['Authorization', 'Bearer t0']]);
});

test('HAR and curl come in as requests; the host is always dropped', () => {
  const har = parseImport(JSON.stringify({ log: { entries: [
    { request: { method: 'POST', url: 'https://x.test/a?b=1', headers: [{ name: ':authority', value: 'x' }, { name: 'Content-Length', value: '3' }, { name: 'Accept', value: '*/*' }], postData: { mimeType: 'text/plain', text: 'hey' } } },
    { request: { method: 'POST', url: 'https://x.test/form', headers: [], postData: { mimeType: 'application/x-www-form-urlencoded', params: [{ name: 'q', value: 'a b' }] } } },
  ] } }));
  assert.equal(har.format, 'har');
  assert.deepEqual(plain(har.requests[0]), { name: 'POST /a?b=1', method: 'POST', path: '/a?b=1', headers: [['Accept', '*/*'], ['Content-Type', 'text/plain']], body: 'hey', bodyBase64: null });
  assert.equal(har.requests[1].body, 'q=a%20b');

  const curl = parseImport(`curl 'https://api.stripe.test/v1/hook?x=1' \\
  -H 'Content-Type: application/json' -H "Stripe-Signature: t=1,v1=it's" \\
  --data-raw '{"id":"evt_1"}' --compressed

curl -X DELETE https://h.test/items/7 -u admin:pw
curl -G https://h.test/search -d q=fox --data-urlencode 'n=a b'
curl --json '{"a":1}' https://h.test/j`);
  assert.equal(curl.format, 'curl');
  assert.deepEqual(plain(curl.requests.map((r) => [r.method, r.path, r.body])), [
    ['POST', '/v1/hook?x=1', '{"id":"evt_1"}'],
    ['DELETE', '/items/7', null],
    ['GET', '/search?q=fox&n=a%20b', null],
    ['POST', '/j', '{"a":1}'],
  ]);
  assert.deepEqual(plain(curl.requests[0].headers), [['Content-Type', 'application/json'], ['Stripe-Signature', "t=1,v1=it's"]]);
  assert.deepEqual(plain(curl.requests[1].headers), [['Authorization', `Basic ${Buffer.from('admin:pw').toString('base64')}`]]);

  // trydash's own "Copy as curl" comes back as the same request.
  const own = parseCurl("curl -X POST \\\n  -H 'Content-Type: application/json' \\\n  -H 'Stripe-Signature: t=1,v1=it'\\''s' \\\n  --data-raw '{\"id\":\"evt\"}' \\\n  http://127.0.0.1:3000/webhooks/stripe");
  assert.deepEqual(plain(own.requests[0]), { name: 'POST /webhooks/stripe', method: 'POST', path: '/webhooks/stripe', headers: [['Content-Type', 'application/json'], ['Stripe-Signature', "t=1,v1=it's"]], body: '{"id":"evt"}' });

  assert.deepEqual(shellWords(`a 'b c' "d \\"e\\"" $'f\\ng' h\\ i`), ['a', 'b c', 'd "e"', 'f\ng', 'h i']);
  assert.equal(pathOf('https://a.test'), '/');
  assert.equal(pathOf('{{base}}/v1/x?y=1#frag'), '/v1/x?y=1');
  assert.equal(pathOf('api.test/v1'), '/v1');
  assert.equal(pathOf('localhost:3000/v1'), '/v1');
  assert.equal(pathOf('users/7?x=1'), '/users/7?x=1');
  assert.equal(pathOf('api.test'), '/');
  assert.equal(pathOf('?a=1'), '/?a=1');
  assert.throws(() => parseImport('hello world'), (e) => e.key === 'collection.unknownFormat');
  assert.throws(() => parseImport('{not json', 'postman'), (e) => e.key === 'collection.badJson');
});

test('checkRequest refuses what could split a request', () => {
  for (const bad of [
    { method: 'GET /x HTTP/1.1' },
    { path: '/a\r\nX: 1' },
    { headers: [['X-A\r\nHost', 'x']] },
    { headers: [['X-A', 'ok\r\nX-B: 1']] },
    { headers: 'X-A: 1' },
    { body: 'x'.repeat(256 * 1024 + 1) },
    { bodyBase64: 'not base64!' },
  ]) {
    assert.throws(() => checkRequest(bad), (e) => e.key === 'collection.invalid', JSON.stringify(bad).slice(0, 60));
  }
  const ok = checkRequest({ method: 'patch', path: 'https://x.test/a?b=1', headers: [[' X-A ', 1]] });
  assert.deepEqual(plain(ok), { name: 'PATCH /a?b=1', method: 'PATCH', path: '/a?b=1', headers: [['X-A', '1']], body: null, bodyBase64: null });
  const many = { info: { schema: 'postman' }, item: Array.from({ length: MAX_IMPORT + 3 }, (_, i) => ({ name: `r${i}`, request: { method: 'GET', url: `/r${i}` } })) };
  const out = parseImport(JSON.stringify(many));
  assert.equal(out.requests.length, MAX_IMPORT);
  assert.deepEqual(out.warnings.find((w) => w.key === 'import.tooMany').params, { max: MAX_IMPORT });
});

test('Postman export points every URL at {{baseUrl}} and leaves Cloudflare headers out; HAR keeps the responses', () => {
  const requests = [checkRequest({ name: 'Hook', method: 'POST', path: '/v1/hook?x=1&y', headers: [['Host', 'a.trycloudflare.com'], ['Cf-Ray', '1'], ['Content-Type', 'application/json']], body: '{}' })];
  const collection = toPostman(requests, { name: 'Mine', baseUrl: 'https://quiet.trycloudflare.com' });
  assert.equal(collection.info.schema, 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json');
  assert.deepEqual(collection.variable, [{ key: 'baseUrl', value: 'https://quiet.trycloudflare.com' }]);
  const req = collection.item[0].request;
  assert.deepEqual(req.url, { raw: '{{baseUrl}}/v1/hook?x=1&y', host: ['{{baseUrl}}'], path: ['v1', 'hook'], query: [{ key: 'x', value: '1' }, { key: 'y', value: '' }] });
  assert.deepEqual(req.header, [{ key: 'Content-Type', value: 'application/json' }]);
  assert.deepEqual(req.body, { mode: 'raw', raw: '{}' });
  // What trydash exports, trydash imports back the same.
  const back = parseImport(JSON.stringify(collection));
  assert.deepEqual(plain(back.requests[0]), plain({ ...requests[0], headers: [['Content-Type', 'application/json']] }));

  const har = toHar([{
    startedAt: '2026-11-12T10:00:00.000Z', durationMs: 12, method: 'POST', path: '/h?a=1', status: 500, statusText: 'Internal Server Error',
    requestHeaders: [['Content-Type', 'application/json'], ['Cf-Ray', 'x']], responseHeaders: [['Content-Type', 'application/json']],
    requestBody: { size: 2, text: '{}' }, responseBody: { size: 7, text: '{"e":1}' },
  }], { baseUrl: 'https://quiet.trycloudflare.com/', version: '2.0.0' });
  const entry = har.log.entries[0];
  assert.equal(har.log.creator.version, '2.0.0');
  assert.equal(entry.request.url, 'https://quiet.trycloudflare.com/h?a=1');
  assert.deepEqual(entry.request.queryString, [{ name: 'a', value: '1' }]);
  assert.deepEqual(entry.request.headers, [{ name: 'Content-Type', value: 'application/json' }]);
  assert.deepEqual(entry.request.postData, { mimeType: 'application/json', text: '{}' });
  assert.equal(entry.response.status, 500);
  assert.equal(entry.response.content.text, '{"e":1}');
  assert.equal(parseImport(JSON.stringify(har)).requests[0].path, '/h?a=1');
});

test('saved requests: a private file, reloaded, with a limit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trydash-saved-'));
  const file = path.join(dir, 'conf', 'requests.json');
  try {
    const a = createCollection({ file, warn: () => {} });
    const item = a.add({ name: 'Hook', method: 'POST', path: '/hook', bodyBase64: Buffer.from([0, 1, 2]).toString('base64') }, 'captured');
    assert.match(item.id, /^q[0-9a-z]+$/);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const b = createCollection({ file, warn: () => {} });
    assert.equal(b.list().length, 1);
    assert.equal(b.get(item.id).source, 'captured');
    // A text body replaces the binary one.
    const updated = b.update(item.id, { body: 'now text', name: 'Hook 2' });
    assert.equal(updated.bodyBase64, null);
    assert.equal(updated.body, 'now text');
    assert.throws(() => b.update(item.id, { path: '/a\r\nb' }), (e) => e.key === 'collection.invalid');
    assert.equal(b.get(item.id).name, 'Hook 2');
    b.remove(item.id);
    assert.throws(() => b.get(item.id), (e) => e.key === 'collection.notFound');
    assert.equal(createCollection({ file, warn: () => {} }).list().length, 0);
    assert.throws(() => b.addMany(Array.from({ length: MAX_SAVED + 1 }, () => ({ path: '/' })), 'curl'), (e) => e.key === 'collection.tooMany');
    assert.equal(b.list().length, 0, 'an import over the limit adds none');

    fs.writeFileSync(file, '{ broken');
    const warnings = [];
    assert.equal(createCollection({ file, warn: (w) => warnings.push(w) }).list().length, 0);
    assert.ok(fs.existsSync(`${file}.broken`));
    assert.match(warnings[0], /not valid/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function quietProcess() {
  const proc = new EventEmitter();
  proc.stdout = Readable.from([]);
  proc.stderr = Readable.from([]);
  proc.pid = 0;
  proc.kill = () => {};
  return proc;
}

test('HTTP: save a captured request, send it again, import, export, edit and delete', async () => {
  const seen = [];
  const origin = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { seen.push({ method: req.method, url: req.url, headers: req.headers, body }); res.end('ok'); });
  });
  await new Promise((r) => origin.listen(0, '127.0.0.1', r));
  const originUrl = `http://127.0.0.1:${origin.address().port}`;
  const app = createApp({ probe: async () => ({ present: true, version: 'test' }), spawn: quietProcess, collection: createCollection() });
  await app.listen(0, '127.0.0.1');
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(`${app.url}${p}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: res.status, headers: res.headers, json, text };
  };
  try {
    const { session } = (await call('POST', '/api/sessions', { origin: originUrl })).json;
    const target = session.inspect.target;
    await new Promise((resolve, reject) => {
      const req = http.request(`${target}/webhooks/stripe`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': 'v1=abc' } }, (res) => { res.resume(); res.on('end', resolve); });
      req.on('error', reject);
      req.end('{"id":"evt_1"}');
    });
    const captured = (await call('GET', `/api/sessions/${session.id}/requests`)).json.requests[0];

    const saved = await call('POST', '/api/collection', { session: session.id, seq: captured.seq, name: 'Stripe paid' });
    assert.equal(saved.status, 201);
    assert.equal(saved.json.request.name, 'Stripe paid');
    assert.equal(saved.json.request.body, '{"id":"evt_1"}');
    assert.equal(saved.json.request.source, 'captured');
    const id = saved.json.request.id;

    const sent = await call('POST', `/api/collection/${id}/send`, { session: session.id });
    assert.equal(sent.status, 201);
    assert.equal(sent.json.request.saved, 'Stripe paid');
    assert.equal(seen.at(-1).body, '{"id":"evt_1"}');
    assert.equal(seen.at(-1).headers['stripe-signature'], 'v1=abc');
    assert.equal(seen.at(-1).url, '/webhooks/stripe');
    const rows = (await call('GET', `/api/sessions/${session.id}/requests`)).json.requests;
    assert.equal(rows[0].saved, 'Stripe paid');

    // A stopped tunnel turns visitors away, but trydash's own sends still go.
    await call('POST', `/api/sessions/${session.id}/stop`);
    assert.equal((await call('POST', `/api/collection/${id}/send`, { session: session.id })).status, 201);

    const worded = await call('POST', '/api/collection/import', { text: 'curl -F f=@x https://h.test/u' }, { 'Accept-Language': 'it' });
    assert.deepEqual(worded.json.warnings, ['Campi -F lasciati fuori']);
    const imported = await call('POST', '/api/collection/import', { text: "curl -X PUT 'https://elsewhere.test/items/7?force=1' -H 'X-Key: k' -d 'a=1'" });
    assert.equal(imported.status, 201);
    assert.equal(imported.json.format, 'curl');
    assert.equal(imported.json.added, 1);
    const curlId = imported.json.requests[0].id;
    await call('POST', `/api/collection/${curlId}/send`, { session: session.id });
    assert.equal(seen.at(-1).method, 'PUT');
    assert.equal(seen.at(-1).url, '/items/7?force=1', 'only the path: the request reached our origin, not elsewhere.test');
    assert.equal(seen.at(-1).headers['x-key'], 'k');

    const empty = await call('POST', '/api/collection/import', { text: '{"info":{"schema":"postman"},"item":[]}' });
    assert.equal(empty.status, 400);
    assert.equal(empty.json.key, 'collection.empty');
    assert.equal((await call('POST', '/api/collection/import', { text: 'nothing here' })).json.key, 'collection.unknownFormat');

    const list = (await call('GET', '/api/collection')).json.requests;
    assert.deepEqual(list.map((r) => r.name), ['Stripe paid', 'POST /u', 'PUT /items/7?force=1']);
    assert.equal(list[0].bodySize, 14);

    const edited = await call('PATCH', `/api/collection/${curlId}`, { name: 'Force put', method: 'post' });
    assert.equal(edited.json.request.name, 'Force put');
    assert.equal(edited.json.request.method, 'POST');
    assert.equal((await call('PATCH', `/api/collection/${curlId}`, { path: 'no slash\r\n' })).status, 400);

    const postman = await call('GET', `/api/collection/export?format=postman&session=${session.id}`);
    assert.equal(postman.status, 200);
    assert.match(postman.headers.get('content-disposition'), /attachment; filename="trydash\.postman_collection\.json"/);
    assert.equal(postman.json.variable[0].value, `${originUrl}`);
    assert.deepEqual(postman.json.item.map((i) => i.name), ['Stripe paid', 'POST /u', 'Force put']);

    const har = await call('GET', `/api/sessions/${session.id}/requests/export?format=har`);
    assert.match(har.headers.get('content-disposition'), /\.har"/);
    assert.ok(har.json.log.entries.length >= 3);
    assert.equal(har.json.log.entries[0].request.url, `${originUrl}/webhooks/stripe`);
    const sessionPostman = await call('GET', `/api/sessions/${session.id}/requests/export?format=postman`);
    assert.ok(sessionPostman.json.item.length >= 3);

    // Writes from another site are refused like every other API call.
    assert.equal((await call('DELETE', `/api/collection/${id}`, null, { Origin: 'http://evil.example' })).status, 403);
    assert.equal((await call('POST', '/api/collection/import', { text: 'curl /x' }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await call('DELETE', `/api/collection/${id}`)).status, 200);
    assert.equal((await call('GET', `/api/collection/${id}`)).status, 404);

    const hello = (await call('POST', '/api/sessions', { options: { mode: 'hello' } })).json.session;
    assert.equal((await call('POST', `/api/collection/${curlId}/send`, { session: hello.id })).json.key, 'inspect.disabled');
    assert.equal((await call('POST', `/api/collection/${curlId}/send`, { session: 'nope' })).status, 404);
  } finally {
    await app.close();
    await new Promise((r) => origin.close(r));
  }
});
