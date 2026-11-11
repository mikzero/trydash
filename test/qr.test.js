import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { dashboardRoot } from '../src/load-dashboard.js';

function loadQr() {
  const sandbox = {};
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(dashboardRoot, 'public/js/qr.js'), 'utf8'), sandbox, { filename: 'qr.js' });
  return sandbox.TryDash.qr;
}

const qr = loadQr();
const fixture = JSON.parse(fs.readFileSync(path.join(dashboardRoot, 'test/fixtures/qr-vectors.json'), 'utf8'));

test('matrices match the reference encoder, module by module', () => {
  assert.ok(fixture.vectors.length >= 8);
  for (const vector of fixture.vectors) {
    const out = qr.encode(vector.text, { mask: vector.mask });
    assert.equal(out.version, vector.version, vector.text);
    assert.equal(out.size, vector.version * 4 + 17);
    const rows = out.modules.map((row) => row.map((dark) => (dark ? '1' : '0')).join(''));
    assert.equal(rows.join('\n'), vector.rows.join('\n'), `${vector.text.slice(0, 20)} v${vector.version} mask ${vector.mask}`);
  }
});

test('the smallest version that fits is used, up to version 10', () => {
  assert.equal(qr.encode('a').version, 1);
  assert.equal(qr.encode('x'.repeat(14)).version, 1);
  assert.equal(qr.encode('x'.repeat(15)).version, 2);
  assert.equal(qr.encode('https://perfect-connecticut-armor-wooden.trycloudflare.com').version, 4);
  assert.equal(qr.encode('x'.repeat(213)).version, 10);
  assert.throws(() => qr.encode('x'.repeat(214)), /too long/);
  // UTF-8: "è" is two bytes.
  assert.equal(qr.encode('è'.repeat(7)).version, 1);
  assert.equal(qr.encode('è'.repeat(8)).version, 2);
  const auto = qr.encode('https://aqua-wolf-1234.trycloudflare.com');
  assert.ok(auto.mask >= 0 && auto.mask <= 7);
  assert.equal(JSON.stringify(auto.modules), JSON.stringify(qr.encode('https://aqua-wolf-1234.trycloudflare.com', { mask: auto.mask }).modules));
});

test('the SVG path draws one square per dark module, inside a quiet zone', () => {
  const code = qr.encode('a');
  const dark = code.modules.flat().filter(Boolean).length;
  const d = qr.svgPath(code);
  assert.equal(d.match(/M/g).length, dark);
  assert.ok(d.startsWith('M4 4h1v1h-1z'), 'the top-left finder starts after the 4-module margin');
});
