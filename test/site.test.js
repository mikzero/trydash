import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { projectRoot } from '../src/assets.js';
import { TARGETS } from '../scripts/build.js';

const site = path.join(projectRoot, 'site');

// The English page is the main one; the Italian one lives in it/.
const PAGES = { en: 'index.html', it: 'it/index.html' };
const read = (page) => fs.readFileSync(path.join(site, page), 'utf8');

for (const [lang, page] of Object.entries(PAGES)) {
  test(`${page}: every local file it links to exists`, () => {
    const html = read(page);
    const refs = [...html.matchAll(/(?:href|src|srcset)="([^"#]+)"/g)]
      .flatMap((m) => m[1].split(',').map((item) => item.trim().split(/\s+/)[0]))
      .filter((ref) => !/^(https?:|mailto:)/.test(ref));
    assert.ok(refs.length >= 8, refs.join(', '));
    for (const ref of refs) {
      const target = path.join(site, path.dirname(page), ref);
      assert.ok(fs.existsSync(target), ref);
    }
  });

  test(`${page}: language, translations and no personal email`, () => {
    const html = read(page);
    assert.match(html, new RegExp(`<html lang="${lang}">`));
    for (const other of Object.keys(PAGES)) assert.match(html, new RegExp(`hreflang="${other}"`));
    assert.doesNotMatch(html, /[\w.+-]+@[\w-]+\.[\w.]+/);
  });

  test(`${page}: the download links point straight at the files of one release`, () => {
    const html = read(page);
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
}

test('both languages have the same page structure and release version', () => {
  // Everything the scripts look up must exist in both pages, in the same order.
  const skeleton = (html) => [...html.matchAll(/\b(id|data-el|data-step|data-suffix|data-file|data-lang|class="v")(?:="([^"]*)")?/g)]
    .map((m) => `${m[1]}=${m[2] || ''}`);
  assert.deepEqual(skeleton(read(PAGES.it)), skeleton(read(PAGES.en)));
  const sections = (html) => (html.match(/data-mascot="/g) || []).length;
  assert.equal(sections(read(PAGES.it)), sections(read(PAGES.en)));
  const scripts = (html) => [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => path.basename(m[1]));
  assert.deepEqual(scripts(read(PAGES.it)), scripts(read(PAGES.en)));
  const version = (html) => /<span class="v">([^<]+)</.exec(html)[1];
  assert.equal(version(read(PAGES.it)), version(read(PAGES.en)));
});

test('i18n.js has every text in both languages', () => {
  const win = {};
  new Function('window', 'document', fs.readFileSync(path.join(site, 'i18n.js'), 'utf8'))(win, { documentElement: { lang: 'it' } });
  const { en, it } = win.trydashTexts;
  assert.deepEqual(Object.keys(it).sort(), Object.keys(en).sort());
  assert.equal(win.trydashLang, 'it');
  assert.equal(win.trydashT('downloadFor', { name: 'Linux x64' }), 'Scarica per Linux x64');
  // Every key the scripts use is defined.
  const used = ['site.js', 'demo.js', 'mascot.js']
    .flatMap((f) => [...fs.readFileSync(path.join(site, f), 'utf8').matchAll(/\bt(?:rydashT)?\('(\w+)'/g)].map((m) => m[1]));
  assert.ok(used.length >= 15);
  for (const key of used) assert.ok(key in en, key);
});

test('the logo and favicons in site/ match the ones in public/', () => {
  for (const [copy, original] of [['images/logo.svg', 'logo.svg'], ['favicon.svg', 'favicon.svg'], ['favicon.png', 'favicon.png']]) {
    assert.ok(fs.readFileSync(path.join(site, copy)).equals(fs.readFileSync(path.join(projectRoot, 'public', original))), copy);
  }
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
