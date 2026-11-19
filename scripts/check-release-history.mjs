import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import semanticRelease from 'semantic-release';
import config from '../release.config.mjs';

// Use a real local Git history: the former scoped package's v2 tags must not
// affect the new package's first version, while subsequent releases increment.
const directory = mkdtempSync(join(tmpdir(), 'isr-release-history-'));
const working = join(directory, 'working');
const remote = join(directory, 'remote.git');
const git = (cwd, ...args) =>
  execFileSync(
    'git',
    [
      '-c',
      'commit.gpgsign=false',
      '-c',
      'tag.gpgsign=false',
      '-c',
      'user.name=Release contract test',
      '-c',
      'user.email=release-test@example.invalid',
      ...args,
    ],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );
// The fixture owns its Git context; outer Actions branch/PR metadata and
// credentials must not affect this local, non-publishing dry run.
const fixtureEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) =>
    [
      'PATH',
      'HOME',
      'TMPDIR',
      'TEMP',
      'TMP',
      'SystemRoot',
      'COMSPEC',
      'USERPROFILE',
      'PATHEXT',
    ].includes(key)
  )
);
const quiet = new Writable({
  write(_chunk, _encoding, callback) {
    callback();
  },
});
try {
  git(directory, 'init', '--bare', '--initial-branch=main', remote);
  git(directory, 'init', '--initial-branch=main', working);
  writeFileSync(
    join(working, 'package.json'),
    JSON.stringify({ name: 'isr-engine', version: '1.0.0' })
  );
  git(working, 'add', 'package.json');
  git(working, 'commit', '-m', 'feat: create engine');
  git(working, 'tag', '-a', 'v2.6.21', '-m', 'Legacy scoped package');
  git(working, 'commit', '--allow-empty', '-m', 'ci: publish unscoped engine');
  git(working, 'remote', 'add', 'origin', remote);
  git(working, 'push', '--follow-tags', 'origin', 'main');
  const dryRun = () =>
    semanticRelease(
      {
        branches: config.branches,
        tagFormat: config.tagFormat,
        repositoryUrl: remote,
        dryRun: true,
        ci: false,
        plugins: [
          [
            fileURLToPath(import.meta.resolve('@semantic-release/commit-analyzer')),
            config.plugins[0][1],
          ],
        ],
      },
      { cwd: working, env: fixtureEnvironment, stdout: quiet, stderr: quiet }
    );
  const first = await dryRun();
  assert.ok(first, 'The local Git fixture must perform its own main-branch dry run');
  assert.equal(
    first.nextRelease.version,
    '1.0.0',
    'Legacy v2 history must not determine the npm package version'
  );
  assert.equal(first.nextRelease.gitTag, 'isr-engine-v1.0.0');
  git(working, 'tag', '-a', first.nextRelease.gitTag, '-m', 'First unscoped release');
  git(working, 'commit', '--allow-empty', '-m', 'refactor: improve rendering');
  git(working, 'push', '--follow-tags', 'origin', 'main');
  const next = await dryRun();
  assert.equal(next.nextRelease.version, '1.0.1');
  assert.equal(next.nextRelease.gitTag, 'isr-engine-v1.0.1');
  git(working, 'tag', '-a', next.nextRelease.gitTag, '-m', 'Patch release');
  git(working, 'commit', '--allow-empty', '-m', 'ci: maintain release artifact upload');
  git(working, 'push', '--follow-tags', 'origin', 'main');
  assert.equal(await dryRun(), false, 'Pure CI maintenance must not publish an extra version');
  console.log(
    'Real Git release history verified: legacy v2 tags → 1.0.0 → 1.0.1; CI-only commits do not release.'
  );
} finally {
  quiet.end();
  rmSync(directory, { recursive: true, force: true });
}
