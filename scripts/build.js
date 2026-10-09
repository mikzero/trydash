// Builds standalone trydash binaries with `bun build --compile`.
//
//   bun scripts/build.js                      current system, version "dev"
//   bun scripts/build.js --all --version 1.0.0
//   bun scripts/build.js --target bun-linux-arm64 --out dist
//
// public/** and the seed fixture are embedded through a generated entry
// (build/entry.js) that maps each project-relative path to its embedded file.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const TARGETS = [
  { target: 'bun-linux-x64', suffix: 'linux-x64' },
  { target: 'bun-linux-arm64', suffix: 'linux-arm64' },
  { target: 'bun-darwin-x64', suffix: 'darwin-x64' },
  { target: 'bun-darwin-arm64', suffix: 'darwin-arm64' },
  { target: 'bun-windows-x64', suffix: 'windows-x64.exe' },
];

const EXTRA_ASSETS = ['test/fixtures/quick-tunnel.log'];

export function hostTarget() {
  const os = process.platform === 'win32' ? 'windows' : process.platform;
  return `bun-${os}-${process.arch}`;
}

function walk(dir, base) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = `${base}/${entry.name}`;
    if (entry.isDirectory()) return walk(path.join(dir, entry.name), rel);
    return entry.isFile() ? [rel] : [];
  });
}

export function listAssets(projectRoot = root) {
  return walk(path.join(projectRoot, 'public'), 'public').concat(EXTRA_ASSETS).sort();
}

// Imports must stay static strings so `bun build` embeds the files; the server
// is imported only after the globals are set.
export function renderEntry(files, version) {
  const imports = files.map((rel, i) => `import a${i} from ${JSON.stringify(`../${rel}`)} with { type: 'file' };`);
  const map = files.map((rel, i) => `  ${JSON.stringify(rel)}: a${i},`);
  return [
    ...imports,
    '',
    'globalThis.__TRYDASH_ASSETS__ = {',
    ...map,
    '};',
    `globalThis.__TRYDASH_VERSION__ = ${JSON.stringify(version)};`,
    '',
    "const { main } = await import('../server.js');",
    // A failed start (busy port…) must exit with an error, not leave the binary hanging.
    'main().catch((error) => {',
    '  console.error(error && error.message ? error.message : error);',
    '  process.exit(1);',
    '});',
    '',
  ].join('\n');
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export async function build({ targets = [hostTarget()], version = 'dev', out = path.join(root, 'dist') } = {}) {
  const entry = path.join(root, 'build', 'entry.js');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(entry, renderEntry(listAssets(root), version));

  const binaries = [];
  for (const target of targets) {
    const known = TARGETS.find((t) => t.target === target);
    if (!known) throw new Error(`Target sconosciuto: ${target}`);
    const outfile = path.join(out, `trydash-${version}-${known.suffix}`);
    const proc = Bun.spawnSync([process.execPath, 'build', '--compile', `--target=${target}`, entry, '--outfile', outfile], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (proc.exitCode !== 0) throw new Error(`bun build ${target} non riuscito:\n${proc.stderr.toString()}`);
    binaries.push(outfile);
  }

  const sums = binaries.map((file) => `${sha256(file)}  ${path.basename(file)}`).join('\n');
  fs.writeFileSync(path.join(out, 'SHA256SUMS'), `${sums}\n`);
  return binaries;
}

function parseArgs(argv) {
  const options = { targets: [], version: 'dev', out: path.join(root, 'dist') };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--all') options.targets = TARGETS.map((t) => t.target);
    else if (arg === '--target') options.targets.push(argv[++i]);
    else if (arg === '--version') options.version = argv[++i];
    else if (arg === '--out') options.out = path.resolve(argv[++i]);
    else throw new Error(`Opzione sconosciuta: ${arg}`);
  }
  if (!options.targets.length) options.targets = [hostTarget()];
  if (!/^[0-9A-Za-z.+-]+$/.test(options.version || '')) throw new Error(`Versione non valida: ${options.version}`);
  return options;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] || '')).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const binaries = await build(options);
    for (const file of binaries) console.log(path.relative(process.cwd(), file));
    console.log(path.relative(process.cwd(), path.join(options.out, 'SHA256SUMS')));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
