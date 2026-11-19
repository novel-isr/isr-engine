import assert from 'node:assert/strict';
import { analyzeCommits } from '@semantic-release/commit-analyzer';
import config from '../release.config.mjs';
import { readFileSync } from 'node:fs';

const rules = config.plugins[0][1];
for (const [message, expected] of [
  ['feat: add a renderer', 'minor'],
  ['refactor: simplify cache boundaries', 'patch'],
  ['ci: configure publishing', 'patch'],
  ['docs: clarify API', 'patch'],
  ['feat: replace API\n\nBREAKING CHANGE: remove old API', 'major'],
]) {
  assert.equal(
    await analyzeCommits(rules, {
      cwd: process.cwd(),
      commits: [{ message, hash: 'test' }],
      logger: { log() {} },
    }),
    expected,
    message
  );
}
assert.equal(
  await analyzeCommits(rules, {
    cwd: process.cwd(),
    commits: [],
    logger: { log() {} },
  }),
  null
);
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
// The official npm plugin compares the OIDC registry URL verbatim, including its slash.
const { default: getRegistry } =
  await import('../node_modules/@semantic-release/npm/lib/get-registry.js');
const { OFFICIAL_REGISTRY } =
  await import('../node_modules/@semantic-release/npm/lib/definitions/constants.js');
assert.equal(getRegistry(pkg, { cwd: process.cwd(), env: process.env }), OFFICIAL_REGISTRY);
assert.equal(pkg.publishConfig.access, 'public');
const plugins = config.plugins.map(plugin => (Array.isArray(plugin) ? plugin[0] : plugin));
assert.ok(plugins.indexOf('@semantic-release/exec') < plugins.indexOf('@semantic-release/npm'));
assert.equal(config.branches[0], 'main');
console.log('Release rules, empty-history behavior, registry and build ordering verified.');

// Exercise mirror retries and fail-closed errors without credentials or network access.
const { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join, resolve } = await import('node:path');
const { spawnSync } = await import('node:child_process');
const fixture = mkdtempSync(join(tmpdir(), 'isr-mirror-test-'));
try {
  const bin = join(fixture, 'bin');
  mkdirSync(bin);
  writeFileSync(join(fixture, 'package.json'), JSON.stringify({ name: '@novel-isr/engine' }));
  writeFileSync(join(bin, 'git'), `#!${process.execPath}\nconsole.log('v2.6.22');\n`, {
    mode: 0o755,
  });
  writeFileSync(
    join(bin, 'npm'),
    `#!${process.execPath}
const args = process.argv.slice(2);
const fs = require('node:fs');
const isGithub = args.includes('https://npm.pkg.github.com');
const scenario = process.env.MIRROR_SCENARIO;
if (args[0] === 'view') {
  if (isGithub && !fs.existsSync(process.env.MIRROR_MARKER)) {
    if (scenario === 'missing') { console.log(JSON.stringify({error:{code:'E404'}})); process.exit(1); }
    if (scenario === 'forbidden') { console.log(JSON.stringify({error:{code:'E403'}})); process.exit(1); }
    if (scenario === 'network') { console.error('ECONNRESET'); process.exit(1); }
    if (scenario === 'different') { console.log(JSON.stringify('sha512-other')); process.exit(0); }
  }
  console.log(JSON.stringify('sha512-test'));
} else if (args[0] === 'pack') {
  fs.writeFileSync('release.tgz', 'test');
  console.log(JSON.stringify([{filename:'release.tgz',integrity:'sha512-test'}]));
} else if (args[0] === 'publish') {
  if (!isGithub) process.exit(99);
  fs.writeFileSync(process.env.MIRROR_MARKER, 'published');
} else process.exit(98);
`,
    { mode: 0o755 }
  );
  for (const [scenario, success, published] of [
    ['identical', true, false],
    ['missing', true, true],
    ['different', false, false],
    ['forbidden', false, false],
    ['network', false, false],
  ]) {
    const marker = join(fixture, `${scenario}.marker`);
    const result = spawnSync(process.execPath, [resolve('scripts/mirror-release.mjs')], {
      cwd: fixture,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        NODE_AUTH_TOKEN: 'test-only',
        MIRROR_SCENARIO: scenario,
        MIRROR_MARKER: marker,
      },
      encoding: 'utf8',
    });
    assert.equal(result.status === 0, success, `${scenario}: ${result.stderr}`);
    assert.equal(existsSync(marker), published, scenario);
  }
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
console.log('Mirror integrity, retry and permission/network failure boundaries verified.');
