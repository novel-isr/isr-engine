import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const npmRegistry = 'https://registry.npmjs.org';
const githubRegistry = 'https://npm.pkg.github.com';
const tags = execFileSync('git', ['tag', '--points-at', 'HEAD'], { encoding: 'utf8' })
  .trim()
  .split('\n')
  .filter(tag => /^v\d+\.\d+\.\d+$/.test(tag));
if (tags.length === 0) {
  console.log('No release tag on this commit; nothing to mirror.');
} else {
  if (tags.length !== 1) throw new Error('Expected exactly one release tag on this commit');
  if (!process.env.NODE_AUTH_TOKEN) throw new Error('GitHub Packages authentication is required');
  const version = tags[0].slice(1);
  const name = JSON.parse(readFileSync('package.json', 'utf8')).name;
  const spec = `${name}@${version}`;
  const directory = mkdtempSync(join(tmpdir(), 'isr-release-'));
  const userconfig = join(directory, '.npmrc');
  // Only GitHub receives this token. npmjs reads and downloads remain anonymous.
  writeFileSync(userconfig, '//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}\n', {
    mode: 0o600,
  });
  const npm = args =>
    execFileSync('npm', [...args, '--userconfig', userconfig], {
      cwd: directory,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  try {
    const sourceIntegrity = JSON.parse(
      npm(['view', spec, 'dist.integrity', '--json', '--registry', npmRegistry])
    );
    if (!sourceIntegrity) throw new Error('Published npm artifact has no integrity metadata');
    let existingIntegrity;
    try {
      existingIntegrity = JSON.parse(
        npm(['view', spec, 'dist.integrity', '--json', '--registry', githubRegistry])
      );
    } catch (error) {
      let code;
      try {
        code = JSON.parse(String(error.stdout)).error?.code;
      } catch {
        throw error;
      }
      // Authentication, permission and network failures must never become a publish attempt.
      if (code !== 'E404') throw error;
    }
    if (existingIntegrity) {
      if (existingIntegrity !== sourceIntegrity)
        throw new Error(`Registry integrity mismatch for ${spec}`);
      console.log(`${spec} already mirrored with identical integrity.`);
    } else {
      const [archive] = JSON.parse(
        npm(['pack', spec, '--ignore-scripts', '--json', '--registry', npmRegistry])
      );
      if (archive.integrity !== sourceIntegrity)
        throw new Error('Downloaded release integrity mismatch');
      npm([
        'publish',
        join(directory, archive.filename),
        '--ignore-scripts',
        '--access',
        'public',
        '--registry',
        githubRegistry,
      ]);
      const mirroredIntegrity = JSON.parse(
        npm(['view', spec, 'dist.integrity', '--json', '--registry', githubRegistry])
      );
      if (mirroredIntegrity !== sourceIntegrity)
        throw new Error('Published mirror integrity mismatch');
      console.log(`Mirrored ${spec} with verified integrity.`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
