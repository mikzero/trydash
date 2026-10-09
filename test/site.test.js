import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectRoot } from '../src/assets.js';
import { buildSite } from '../scripts/build-site.js';

test('every local file the landing page links to is in the built site', () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'trydash-site-')), '_site');
  try {
    buildSite(out, projectRoot);
    const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    const refs = [...html.matchAll(/(?:href|src|srcset)="([^"#]+)"/g)]
      .map((m) => m[1])
      .filter((ref) => !/^(https?:|mailto:|\.\/$)/.test(ref));
    assert.ok(refs.length >= 6, refs.join(', '));
    for (const ref of refs) assert.ok(fs.existsSync(path.join(out, ref)), ref);
  } finally {
    fs.rmSync(path.dirname(out), { recursive: true, force: true });
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
