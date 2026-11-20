import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { analyzeCommits } from '@semantic-release/commit-analyzer';
import config from '../release.config.mjs';
import pkg from '../package.json' with { type: 'json' };

const [, analyzerOptions] = config.plugins.find(
  plugin => Array.isArray(plugin) && plugin[0] === '@semantic-release/commit-analyzer'
);

test('commit types select the intended release increment', async () => {
  for (const [message, expected] of [
    ['feat: add a renderer', 'minor'],
    ['refactor: simplify cache boundaries', 'patch'],
    ['ci: configure publishing', null],
    ['docs: clarify API', 'patch'],
    ['feat: replace API\n\nBREAKING CHANGE: remove old API', 'major'],
    ['ci: replace pipeline\n\nBREAKING CHANGE: require a new runtime contract', 'major'],
  ]) {
    assert.equal(
      await analyzeCommits(analyzerOptions, {
        cwd: process.cwd(),
        commits: [{ message, hash: 'test' }],
        logger: { log() {} },
      }),
      expected,
      message
    );
  }
});

test('main publishes the unscoped package to the public registry', async () => {
  assert.deepEqual(config.branches, ['main']);
  assert.equal(config.tagFormat, 'isr-engine-v${version}');
  assert.equal(pkg.name, 'isr-engine');
  assert.deepEqual(pkg.publishConfig, {
    registry: 'https://registry.npmjs.org/',
    access: 'public',
  });
  const nodeVersion = await readFile(new URL('../.nvmrc', import.meta.url), 'utf8');
  assert.equal(pkg.engines.node, nodeVersion.trim());
});
