// Drafts the annotated tag message for a release from Conventional Commits.
// Release notes are written in English.
//
//   bun scripts/release-notes.js v1.1.0            writes release-notes.md
//   bun scripts/release-notes.js v1.1.0 --out -    prints to stdout
//
// Commits since the previous tag are grouped (feat, fix, the rest). Edit the
// draft, then: git tag -a v1.1.0 -F release-notes.md --cleanup=verbatim

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONVENTIONAL = /^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/;

const SECTIONS = [
  ['breaking', '## ⚠️ Breaking changes'],
  ['feat', '## ✨ New'],
  ['fix', '## 🐛 Fixes'],
  ['other', '## 🧰 Maintenance'],
];

export function groupCommits(subjects) {
  const groups = { breaking: [], feat: [], fix: [], other: [] };
  for (const subject of subjects) {
    const match = CONVENTIONAL.exec(subject);
    if (!match) {
      groups.other.push(subject);
      continue;
    }
    const [, type, scope, bang, text] = match;
    const line = scope ? `**${scope}**: ${text}` : text;
    if (bang) groups.breaking.push(line);
    else if (type === 'feat' || type === 'fix') groups[type].push(line);
    else groups.other.push(line);
  }
  return groups;
}

// First line is the release title; the description slot follows the blank line.
export function renderNotes(tag, subjects) {
  const groups = groupCommits(subjects);
  const out = [`trydash ${tag.replace(/^v/, '')}`, '', 'Short description of the release.', ''];
  for (const [key, heading] of SECTIONS) {
    if (!groups[key].length) continue;
    out.push(heading, ...groups[key].map((line) => `- ${line}`), '');
  }
  return out.join('\n');
}

function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] || '')).href) {
  const [tag, flag, value] = process.argv.slice(2);
  if (!tag || !/^v\d/.test(tag)) {
    console.error('Usage: bun scripts/release-notes.js vX.Y.Z [--out file|-]');
    process.exit(1);
  }
  const previous = git(['describe', '--tags', '--abbrev=0', 'HEAD']);
  const range = previous ? `${previous}..HEAD` : 'HEAD';
  const subjects = (git(['log', '--format=%s', range]) || '').split('\n').filter(Boolean);
  const text = renderNotes(tag, subjects);
  const out = flag === '--out' ? value : 'release-notes.md';
  if (out === '-') process.stdout.write(text);
  else {
    fs.writeFileSync(path.resolve(out), text);
    console.log(`${out} (${subjects.length} commits${previous ? ` since ${previous}` : ''})`);
  }
}
