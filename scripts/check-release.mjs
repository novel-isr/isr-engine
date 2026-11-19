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

assert.equal(pkg.name, 'isr-engine');
assert.equal(plugins.includes('@semantic-release/github'), false);
assert.equal(
  readFileSync('.github/workflows/publish.yml', 'utf8').includes('packages: write'),
  false
);
console.log('Unscoped npm-only release policy verified.');

assert.deepEqual(Object.keys(pkg.bin), ['isr-engine']);
assert.equal(pkg.main, './dist/isr-engine.cjs');
assert.equal(pkg.module, './dist/isr-engine.js');
assert.equal(
  readFileSync('.github/workflows/publish.yml', 'utf8').includes('mirror-release'),
  false
);

// Exercise the same plugin loader used by the release CLI, including transitive resolution.
const { loadPlugin } = await import('../node_modules/semantic-release/lib/plugins/utils.js');
const loadedNpm = await loadPlugin({ cwd: process.cwd() }, '@semantic-release/npm', {});
const configuredNpm = await import('@semantic-release/npm');
assert.equal(
  loadedNpm.verifyConditions,
  configuredNpm.verifyConditions,
  'Release CLI must load the configured OIDC-capable npm plugin'
);

assert.equal(readFileSync('.nvmrc', 'utf8').trim(), '24.15.0');
assert.equal(pkg.engines.node, '>=24.15.0');
await import('./check-release-history.mjs');
