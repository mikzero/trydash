import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { projectRoot } from '../src/assets.js';

const workflow = Bun.YAML.parse(fs.readFileSync(path.join(projectRoot, '.github/workflows/release.yml'), 'utf8'));
const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);

test('every action is pinned to a commit SHA', () => {
  for (const step of steps.filter((s) => s.uses)) {
    assert.match(step.uses, /@[0-9a-f]{40}$/, step.uses);
  }
});

test('checkout does not keep the token', () => {
  for (const step of steps.filter((s) => String(s.uses).startsWith('actions/checkout@'))) {
    assert.equal(step.with && step.with['persist-credentials'], false);
  }
});

test('only the job that publishes can write, and it runs no project code', () => {
  assert.notEqual(workflow.permissions && workflow.permissions.contents, 'write');
  const writers = Object.entries(workflow.jobs).filter(([, job]) => job.permissions && job.permissions.contents === 'write');
  assert.equal(writers.length, 1);
  const [, publisher] = writers[0];
  assert.equal(publisher.steps.some((s) => String(s.uses).startsWith('actions/checkout@')), false);
  assert.equal(publisher.steps.some((s) => /bun (test|scripts)/.test(s.run || '')), false);
  assert.ok(publisher.steps.some((s) => /gh release create/.test(s.run || '')));
});

test('the release uses the annotated tag message as title and notes', () => {
  const publisher = Object.values(workflow.jobs).find((job) => job.permissions && job.permissions.contents === 'write');
  const script = publisher.steps.find((s) => /gh release create/.test(s.run || '')).run;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trydash-gh-'));
  try {
    // A fake gh: answers the two API calls, records the release command.
    fs.writeFileSync(path.join(dir, 'gh'), `#!/bin/bash
case "$*" in
  *git/ref/tags/*.object.type*) echo "\${FAKE_TYPE}" ;;
  *git/ref/tags/*.object.sha*) echo abc123 ;;
  *git/tags/abc123*) printf 'trydash 1.0.0\\n\\nFirst release.\\n\\n## ✨ New\\n- one thing\\n' ;;
  "release create"*) printf '%s\\n' "$@" > "${dir}/args"; cp "$(awk '/--notes-file/{getline; print}' "${dir}/args")" "${dir}/notes" 2>/dev/null; true ;;
esac
`, { mode: 0o755 });
    fs.mkdirSync(path.join(dir, 'dist'));
    fs.writeFileSync(path.join(dir, 'dist', 'trydash-1.0.0-linux-x64'), 'bin');
    const run = (tag, type) => Bun.spawnSync(['bash', '-euo', 'pipefail', '-c', script], {
      cwd: dir,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GITHUB_REF_NAME: tag, GITHUB_REPOSITORY: 'me/trydash', GH_TOKEN: 'x', FAKE_TYPE: type },
    });
    const annotated = run('v1.0.0', 'tag');
    assert.equal(annotated.exitCode, 0, annotated.stderr.toString());
    const args = fs.readFileSync(path.join(dir, 'args'), 'utf8').split('\n');
    assert.equal(args[args.indexOf('--title') + 1], 'trydash 1.0.0');
    assert.ok(args.includes('--generate-notes'));
    assert.equal(args.includes('--prerelease'), false);
    assert.equal(fs.readFileSync(path.join(dir, 'notes'), 'utf8'), 'First release.\n\n## ✨ New\n- one thing\n');

    fs.rmSync(path.join(dir, 'args'));
    const light = run('v1.1.0-rc.1', 'commit');
    assert.equal(light.exitCode, 0, light.stderr.toString());
    const lightArgs = fs.readFileSync(path.join(dir, 'args'), 'utf8').split('\n');
    assert.equal(lightArgs[lightArgs.indexOf('--title') + 1], 'v1.1.0-rc.1');
    assert.equal(lightArgs.includes('--notes-file'), false);
    assert.ok(lightArgs.includes('--prerelease'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
