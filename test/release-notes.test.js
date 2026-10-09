import test from 'node:test';
import assert from 'node:assert/strict';
import { groupCommits, renderNotes } from '../scripts/release-notes.js';

const subjects = [
  'feat(ui): traffic strip and sparkline',
  'fix(server): refuse foreign Host',
  'feat!: drop the old API',
  'ci(release): pin actions',
  'docs: describe email access',
  'Add design spec for release',
  'fix: shell-safe copied command',
];

test('commits are grouped by Conventional Commits type', () => {
  const groups = groupCommits(subjects);
  assert.deepEqual(groups.breaking, ['drop the old API']);
  assert.deepEqual(groups.feat, ['**ui**: traffic strip and sparkline']);
  assert.deepEqual(groups.fix, ['**server**: refuse foreign Host', 'shell-safe copied command']);
  assert.deepEqual(groups.other, ['**release**: pin actions', 'describe email access', 'Add design spec for release']);
});

test('notes render a title line, a description slot and the sections that have entries', () => {
  const text = renderNotes('v1.1.0', subjects);
  const lines = text.split('\n');
  assert.equal(lines[0], 'trydash 1.1.0');
  assert.equal(lines[1], '');
  for (const heading of ['## ⚠️ Breaking changes', '## ✨ New', '## 🐛 Fixes', '## 🧰 Maintenance']) {
    assert.ok(text.includes(heading), heading);
  }
  assert.ok(text.indexOf('## ✨ New') < text.indexOf('## 🐛 Fixes'));
  assert.ok(text.includes('- **ui**: traffic strip and sparkline'));
  assert.equal(renderNotes('v1.0.1', ['fix: one']).includes('## ✨ New'), false);
});
