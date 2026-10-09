import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { projectRoot } from '../src/assets.js';
import { TARGETS } from '../scripts/build.js';

const site = path.join(projectRoot, 'site');

test('every local file the landing page links to exists', () => {
  const html = fs.readFileSync(path.join(site, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:href|src|srcset)="([^"#]+)"/g)]
    .flatMap((m) => m[1].split(',').map((item) => item.trim().split(/\s+/)[0]))
    .filter((ref) => !/^(https?:|mailto:|\.\/$)/.test(ref));
  assert.ok(refs.length >= 8, refs.join(', '));
  for (const ref of refs) assert.ok(fs.existsSync(path.join(site, ref)), ref);
});

test('the logo and favicons in site/ match the ones in public/', () => {
  for (const [copy, original] of [['images/logo.svg', 'logo.svg'], ['favicon.svg', 'favicon.svg'], ['favicon.png', 'favicon.png']]) {
    assert.ok(fs.readFileSync(path.join(site, copy)).equals(fs.readFileSync(path.join(projectRoot, 'public', original))), copy);
  }
});

test('the download links point straight at the files of one release', () => {
  const html = fs.readFileSync(path.join(site, 'index.html'), 'utf8');
  const links = [...html.matchAll(/<a data-suffix="([^"]+)" href="([^"]+)"><code>trydash-<span class="v">([^<]+)<\/span>-([^<]+)<\/code>/g)];
  assert.deepEqual(links.map((m) => m[1]).sort(), TARGETS.map((t) => t.suffix).sort());
  const version = links[0][3];
  assert.match(version, /^\d+\.\d+\.\d+/);
  for (const [, suffix, href, v, shown] of links) {
    assert.equal(v, version);
    assert.equal(shown, suffix);
    assert.equal(href, `https://github.com/mikzero/trydash/releases/download/v${version}/trydash-${version}-${suffix}`);
  }
  assert.ok(html.includes(`href="https://github.com/mikzero/trydash/releases/download/v${version}/SHA256SUMS"`));
});

test('the landing page is in Italian and has no personal email', () => {
  const html = fs.readFileSync(path.join(projectRoot, 'site/index.html'), 'utf8');
  assert.match(html, /<html lang="it">/);
  assert.doesNotMatch(html, /[\w.+-]+@[\w-]+\.[\w.]+/);
});

const workflow = Bun.YAML.parse(fs.readFileSync(path.join(projectRoot, '.github/workflows/pages.yml'), 'utf8'));
const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);

test('pages: every action is pinned to a commit SHA and checkout keeps no token', () => {
  for (const step of steps.filter((s) => s.uses)) assert.match(step.uses, /@[0-9a-f]{40}$/, step.uses);
  for (const step of steps.filter((s) => String(s.uses).startsWith('actions/checkout@'))) {
    assert.equal(step.with && step.with['persist-credentials'], false);
  }
});

test('pages: only the deploy job can write, and it runs no project code', () => {
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  const writers = Object.values(workflow.jobs).filter((job) => job.permissions && job.permissions.pages === 'write');
  assert.equal(writers.length, 1);
  assert.equal(writers[0].steps.some((s) => String(s.uses).startsWith('actions/checkout@') || s.run), false);
  assert.ok(writers[0].steps.some((s) => String(s.uses).startsWith('actions/deploy-pages@')));
});

const detect = {};
new Function('window', fs.readFileSync(path.join(site, 'detect.js'), 'utf8'))(detect);
const { pick } = detect.trydashDetect;

const UA = {
  win: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  linux: 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0',
  linuxArm: 'Mozilla/5.0 (X11; Linux aarch64; rv:140.0) Gecko/20100101 Firefox/140.0',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  android: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36',
};

test('detect: suggests the build for the visitor system', () => {
  assert.deepEqual(pick({ ua: UA.win, platform: 'Win32' }), { suffix: 'windows-x64.exe', certain: true });
  assert.deepEqual(pick({ ua: UA.linux, platform: 'Linux x86_64' }), { suffix: 'linux-x64', certain: true });
  assert.deepEqual(pick({ ua: UA.linuxArm, platform: 'Linux aarch64' }), { suffix: 'linux-arm64', certain: true });
  assert.deepEqual(pick({ ua: UA.linux, platform: 'Linux', arch: 'arm' }), { suffix: 'linux-arm64', certain: true });
});

test('detect: tells Apple Silicon from Intel Macs when the browser lets it', () => {
  assert.deepEqual(pick({ ua: UA.mac, platform: 'macOS', arch: 'arm' }), { suffix: 'darwin-arm64', certain: true });
  assert.deepEqual(pick({ ua: UA.mac, platform: 'macOS', arch: 'x86' }), { suffix: 'darwin-x64', certain: true });
  assert.deepEqual(pick({ ua: UA.mac, platform: 'MacIntel', gpu: 'Apple M2' }), { suffix: 'darwin-arm64', certain: true });
  assert.deepEqual(pick({ ua: UA.mac, platform: 'MacIntel', gpu: 'Intel(R) Iris(TM) Plus Graphics' }), { suffix: 'darwin-x64', certain: true });
  assert.deepEqual(pick({ ua: UA.mac, platform: 'MacIntel', gpu: '' }), { suffix: 'darwin-arm64', certain: false });
});

test('detect: no suggestion on phones and tablets', () => {
  assert.equal(pick({ ua: UA.iphone, platform: 'iPhone' }), null);
  assert.equal(pick({ ua: UA.android, platform: 'Linux armv8l' }), null);
  assert.equal(pick({ ua: UA.android, platform: 'Android', mobile: true }), null);
  assert.equal(pick({ ua: UA.mac, platform: 'MacIntel', touch: 5 }), null);
});
