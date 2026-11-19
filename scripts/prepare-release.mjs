import { execFileSync } from 'node:child_process';

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  throw new Error('Expected a stable semantic release version');
}

// Version-dependent constants must be built after semantic-release chooses the version.
execFileSync('npm', ['version', version, '--no-git-tag-version', '--allow-same-version'], {
  stdio: 'inherit',
});
for (const command of [
  'audit:security',
  'build',
  'test:package',
  'test:package:installed',
  'test:workers',
]) {
  execFileSync('pnpm', ['run', command], { stdio: 'inherit' });
}
