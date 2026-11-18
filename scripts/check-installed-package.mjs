import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'isr-installed-consumer-'));
const npmCommand = process.platform === 'win32' ? process.execPath : 'npm';
const npmPrefix =
  process.platform === 'win32'
    ? [path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')]
    : [];
function npm(args, cwd) {
  return execFileSync(npmCommand, [...npmPrefix, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 8 * 1024 * 1024,
  });
}

try {
  const [pack] = JSON.parse(
    npm(['pack', '--json', '--ignore-scripts', '--pack-destination', temporary], root)
  );
  await fs.writeFile(
    path.join(temporary, 'package.json'),
    JSON.stringify({ private: true, type: 'module' })
  );
  npm(
    [
      'install',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      '--registry=https://registry.npmjs.org',
      path.join(temporary, pack.filename),
    ],
    temporary
  );
  const installed = path.join(temporary, 'node_modules/@novel-isr/engine');
  const manifest = path.join(temporary, 'pack-manifest.json');
  await fs.writeFile(manifest, JSON.stringify([pack]));
  assert.equal((await fs.lstat(installed)).isSymbolicLink(), false);
  for (const script of ['check-package-exports.mjs', 'check-production-runtime.mjs']) {
    const output = execFileSync(
      process.execPath,
      [
        path.join(root, 'scripts', script),
        ...(script === 'check-package-exports.mjs' ? [installed, manifest] : []),
      ],
      { cwd: installed, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }
    );
    process.stdout.write(output);
  }
  // Build and serve a real RSC application from the installed archive, not a
  // workspace link. This exercises shipped source entries as well as dist.
  const fixture = path.join(temporary, 'app');
  await fs.mkdir(fixture);
  for (const entry of ['src', 'ssr.config.ts', 'vite.config.ts']) {
    await fs.cp(path.join(root, 'bench/app', entry), path.join(fixture, entry), {
      recursive: true,
    });
  }
  await fs.writeFile(path.join(fixture, 'package.json'), '{"private":true,"type":"module"}');
  const consumerRequire = createRequire(path.join(temporary, 'package.json'));
  const vite = path.join(path.dirname(consumerRequire.resolve('vite/package.json')), 'bin/vite.js');
  process.stdout.write(
    execFileSync(process.execPath, [vite, 'build'], {
      cwd: fixture,
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    })
  );
  const smoke = `
    import assert from 'node:assert/strict';
    import { createISRApp, loadConfig } from '@novel-isr/engine';
    process.env.NODE_ENV = 'production';
    const config = await loadConfig();
    config.server.host = '127.0.0.1';
    config.server.port = 0;
    const app = await createISRApp(config);
    try {
      const { url } = await app.start();
      for (const [route, expected] of [['/', 'Bench Home'], ['/about', 'Bench About'], ['/books/1', 'Book '], ['/api/health', 'status']]) {
        const response = await fetch(url + route, { signal: AbortSignal.timeout(10000) });
        assert.equal(response.status, 200, route);
        assert.ok((await response.text()).includes(expected), route);
      }
      console.log('Installed artifact RSC build and ISR/SSG/SSR HTTP routes verified.');
    } finally { await app.shutdown(); }
  `;
  process.stdout.write(
    execFileSync(process.execPath, ['--input-type=module', '--eval', smoke], {
      cwd: fixture,
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    })
  );
  console.log(
    `Clean tarball installation, consumer types, exports and native HTTP verified: ${pack.filename}`
  );
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
