import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, cp, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const npm =
  process.platform === 'win32'
    ? [
        process.execPath,
        path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
      ]
    : ['npm'];
assert.ok(process.env.npm_execpath, 'Run this check with pnpm test:package');
const pnpm = [process.execPath, process.env.npm_execpath];

function run([command, ...prefix], args, cwd, capture = false) {
  return execFileSync(command, [...prefix, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    timeout: 180_000,
  });
}

function* exportTargets(value) {
  if (typeof value === 'string') yield value.replace(/^\.\//, '');
  else if (value && typeof value === 'object') {
    for (const target of Object.values(value)) yield* exportTargets(target);
  }
}

const archive = process.argv[2] && path.resolve(process.argv[2]);
const temporary = await mkdtemp(path.join(tmpdir(), 'isr-artifact-'));
try {
  const [pack] = JSON.parse(
    run(
      npm,
      [
        'pack',
        '--ignore-scripts',
        '--json',
        ...(archive ? [archive, '--dry-run'] : ['--pack-destination', temporary]),
      ],
      root,
      true
    )
  );
  if (archive) await copyFile(archive, path.join(temporary, pack.filename));
  const engine = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pack.name, engine.name);
  assert.equal(pack.version, engine.version);
  const files = new Set(pack.files.map(file => file.path));
  const targets = new Set(
    exportTargets([engine.exports, engine.bin, engine.main, engine.module, engine.types])
  );
  for (const target of targets) assert.ok(files.has(target), `Missing package target: ${target}`);
  const tests = [...files].filter(file =>
    /(^|\/)(?:__tests__\/|[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$)/.test(file)
  );
  assert.deepEqual(tests, [], 'The archive must exclude repository tests');

  const app = path.join(temporary, 'consumer app');
  const example = path.join(root, 'examples/hello-world');
  for (const entry of ['src', 'package.json', 'ssr.config.ts', 'tsconfig.json', 'vite.config.ts']) {
    await cp(path.join(example, entry), path.join(app, entry), { recursive: true });
  }
  const manifestPath = path.join(app, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const { vite, ...react } = engine.peerDependencies;
  Object.assign(manifest.dependencies, react, { 'isr-engine': `file:../${pack.filename}` });
  manifest.devDependencies.vite = vite;
  await writeFile(manifestPath, JSON.stringify(manifest));
  await copyFile(
    new URL('./consumer-types.ts', import.meta.url),
    path.join(app, 'src/consumer-types.ts')
  );
  await copyFile(
    new URL('./production.test.mjs', import.meta.url),
    path.join(app, 'production.test.mjs')
  );

  run(
    pnpm,
    [
      'install',
      '--ignore-workspace',
      '--config.node-linker=isolated',
      '--config.hoist=false',
      '--config.auto-install-peers=false',
      '--config.strict-peer-dependencies=true',
      '--registry=https://registry.npmjs.org',
    ],
    app
  );
  for (const name of [
    'rsc-html-stream',
    'react-server-dom-webpack',
    '@vitejs/plugin-rsc',
    'webpack',
  ]) {
    await assert.rejects(access(path.join(app, 'node_modules', name)), { code: 'ENOENT' });
  }
  assert.equal(run(pnpm, ['exec', 'isr-engine', '--version'], app, true).trim(), pack.version);
  run(pnpm, ['exec', 'tsc', '--noEmit'], app);
  run(pnpm, ['run', 'build'], app);
  run([process.execPath], ['--test', 'production.test.mjs'], app);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
