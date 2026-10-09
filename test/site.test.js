import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { projectRoot } from '../src/assets.js';

const site = path.join(projectRoot, 'site');

test('every local file the landing page links to exists', () => {
  const html = fs.readFileSync(path.join(site, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:href|src|srcset)="([^"#]+)"/g)]
    .map((m) => m[1])
    .filter((ref) => !/^(https?:|mailto:|\.\/$)/.test(ref));
  assert.ok(refs.length >= 8, refs.join(', '));
  for (const ref of refs) assert.ok(fs.existsSync(path.join(site, ref)), ref);
});

test('the logo and favicons in site/ match the ones in public/', () => {
  for (const [copy, original] of [['images/logo.svg', 'logo.svg'], ['favicon.svg', 'favicon.svg'], ['favicon.png', 'favicon.png']]) {
    assert.ok(fs.readFileSync(path.join(site, copy)).equals(fs.readFileSync(path.join(projectRoot, 'public', original))), copy);
  }
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
