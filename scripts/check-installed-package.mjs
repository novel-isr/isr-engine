import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'isr-installed-consumer-'));
const strictPnpm = process.env.ISR_TEST_CONSUMER_INSTALL === 'pnpm';
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
  const engineManifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const [pack] = JSON.parse(
    npm(['pack', '--json', '--ignore-scripts', '--pack-destination', temporary], root)
  );
  await fs.writeFile(
    path.join(temporary, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
      dependencies: { ...engineManifest.peerDependencies, 'isr-engine': `file:./${pack.filename}` },
    })
  );
  if (strictPnpm) {
    execFileSync(
      'pnpm',
      [
        'install',
        '--ignore-workspace',
        '--config.node-linker=isolated',
        '--config.hoist=false',
        '--config.auto-install-peers=false',
        '--config.strict-peer-dependencies=true',
        '--registry=https://registry.npmjs.org',
      ],
      { cwd: temporary, stdio: 'inherit', timeout: 300_000 }
    );
  } else {
    npm(
      [
        'install',
        '--no-audit',
        '--no-fund',
        '--package-lock=false',
        '--registry=https://registry.npmjs.org',
      ],
      temporary
    );
  }
  const installed = await fs.realpath(path.join(temporary, 'node_modules/isr-engine'));
  const manifest = path.join(temporary, 'pack-manifest.json');
  await fs.writeFile(manifest, JSON.stringify([pack]));
  assert.notEqual(installed, root);
  if (strictPnpm) {
    for (const internal of [
      'rsc-html-stream',
      'react-server-dom-webpack',
      '@vitejs/plugin-rsc',
      'webpack',
    ]) {
      await assert.rejects(fs.lstat(path.join(temporary, 'node_modules', internal)), {
        code: 'ENOENT',
      });
    }
  }
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
  const fixture = temporary;
  for (const entry of ['src', 'ssr.config.ts', 'vite.config.ts']) {
    await fs.cp(path.join(root, 'bench/app', entry), path.join(fixture, entry), {
      recursive: true,
    });
  }
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
    import { createISRApp, invalidatorRunsTotal, loadConfig } from 'isr-engine';
    import { revalidateTag } from 'isr-engine/rsc';
    import { applyRuntimeToServerHooks } from 'isr-engine/site-hooks';
    process.env.NODE_ENV = 'production';
    const config = await loadConfig();
    const seoHooks = applyRuntimeToServerHooks({}, {
      ...config.runtime,
      services: {},
      telemetry: false,
      seo: {
        dynamicResolvers: [{ pattern: '/*', resolve: ({ params }) => ({ title: params.wildcard }) }],
      },
    });
    const seoMeta = await seoHooks.loadSeoMeta(new Request('https://site.test/work/arcane'));
    assert.deepEqual(seoMeta, { title: 'work/arcane' });
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
      await revalidateTag('books');
      const metric = await invalidatorRunsTotal.get();
      assert.equal(metric.values.find(({ labels }) => labels.kind === 'tag' && labels.target === 'books')?.value, 1);
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
    `Clean ${strictPnpm ? 'strict pnpm' : 'npm'} tarball installation, consumer types, exports and native HTTP verified: ${pack.filename}`
  );
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
