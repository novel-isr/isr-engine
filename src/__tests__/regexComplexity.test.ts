import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { buildSync } from 'esbuild';
import { afterEach, expect, it } from 'vitest';

const fixtures: string[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

// A subprocess deadline keeps a regression from blocking Vitest's event loop.
// The payloads exercise actual public consumers, including their returned results.
function runIsolated(source: string): void {
  const dir = mkdtempSync(path.join(process.cwd(), '.tmp-regex-complexity-'));
  fixtures.push(dir);
  const outfile = path.join(dir, 'check.mjs');
  buildSync({
    stdin: {
      contents: `import assert from 'node:assert/strict';\n${source}`,
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    outfile,
    logLevel: 'silent',
  });
  const result = spawnSync(process.execPath, [outfile], {
    encoding: 'utf8',
    timeout: 2_000,
    killSignal: 'SIGKILL',
  });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
}

it('locale parsing preserves a long interior slash run without backtracking', () => {
  runIsolated(`
    import { parseLocale } from './src/runtime/i18n';
    const tail = '/'.repeat(300_000) + 'x///';
    assert.deepEqual(parseLocale('/en/a' + tail, { locales: ['en'], defaultLocale: 'en' }),
      { locale: 'en', pathname: '/a' + tail.slice(0, -3), hasPrefix: true });
  `);
});

it('page SEO lookup handles a long interior slash run without backtracking', () => {
  runIsolated(`
    import { resolvePageSeoMeta } from './src/runtime/routes';
    assert.equal(await resolvePageSeoMeta(new URL('https://x.test/a' + '/'.repeat(300_000) + 'x')), null);
  `);
});

it('telemetry endpoint joining preserves interior slash runs without backtracking', () => {
  runIsolated(`
    import { resolveClientObservabilityOptions } from './src/plugin/clientObservabilityConfig';
    const origin = 'https://api.test/a' + '/'.repeat(300_000) + 'x///';
    const config = resolveClientObservabilityOptions({ runtime: {
      services: { api: origin }, telemetry: { app: 'test', events: { endpoint: '///events' }, errors: false }
    }});
    assert.equal(config.analytics.endpoint, origin.slice(0, -3) + '/events');
  `);
});

it('admin loader joins long service origins without backtracking', () => {
  runIsolated(`
    import { createAdminIntlLoader } from './src/defaults/runtime/defineSiteHooks';
    const origin = 'https://api.test/a' + '/'.repeat(300_000) + 'x///';
    let requested;
    globalThis.fetch = async url => { requested = url; return new Response('{"strings":{"hello":"world"}}'); };
    const result = await createAdminIntlLoader({ endpoint: '/intl' })('en', { services: { api: origin } });
    assert.equal(requested, origin.slice(0, -3) + '/intl');
    assert.equal(result.messages.hello, 'world');
  `);
});

it('admin SEO normalization handles long interior slash runs without backtracking', () => {
  runIsolated(`
    import { createAdminSeoLoader } from './src/defaults/runtime/defineSiteHooks';
    const pathname = '/a' + '/'.repeat(300_000) + 'x///';
    let requested;
    globalThis.fetch = async url => { requested = url; return new Response('{}'); };
    await createAdminSeoLoader({ endpoint: '/seo?path={pathname}' })({ pathname }, { services: { api: 'https://api.test' } });
    assert.equal(new URL(requested).searchParams.get('path'), pathname.slice(0, -3));
  `);
});

it('ops authentication rejects whitespace followed by a line break without backtracking', () => {
  runIsolated(`
    import { createOpsAuthMiddleware, resolveOpsConfig } from './src/server/opsConfig';
    const config = resolveOpsConfig({ server: { ops: { authToken: 'secret', metrics: { enabled: true, public: false } } } }, 'production');
    let status;
    const res = { status(value) { status = value; return this; }, json() {} };
    createOpsAuthMiddleware('metrics', config)({ headers: { authorization: 'Bearer' + ' '.repeat(300_000) + '\\n' } }, res, () => assert.fail('authenticated'));
    assert.equal(status, 401);
  `);
});

it.each(['//'.repeat(40), '/*' + '*//*'.repeat(40)])(
  'client dependency detection scans ambiguous comments in bounded time (%s)',
  source => {
    runIsolated(`
      import { mkdirSync, writeFileSync } from 'node:fs';
      import { detectClientReferenceDependencies } from './src/plugin/createIsrPlugin';
      const root = new URL('.', import.meta.url).pathname;
      mkdirSync(root + '/node_modules/client-pkg', { recursive: true });
      writeFileSync(root + '/package.json', JSON.stringify({ dependencies: { 'client-pkg': '1' } }));
      writeFileSync(root + '/node_modules/client-pkg/package.json', '{"main":"index.js"}');
      writeFileSync(root + '/node_modules/client-pkg/index.js', ${JSON.stringify(source)});
      assert.deepEqual(detectClientReferenceDependencies(root), []);
    `);
  }
);

it.each([
  ['unfinished font blocks', '@font-face{{'.repeat(100_000)],
  ['unfinished font URLs', '@font-face{src:' + 'url('.repeat(100_000) + '}'],
])('font optimization handles %s without backtracking', (_name, css) => {
  runIsolated(`
    import { createFontPlugin } from './src/plugin/createFontPlugin';
    const plugin = createFontPlugin();
    const output = plugin.transform(${JSON.stringify(css)}, 'app.css');
    assert.equal(output === null || output.code.endsWith('  font-display: swap;\\n}'), true);
    const html = plugin.transformIndexHtml('<head></head>');
    assert.equal(html.includes('rel="preload"'), false);
  `);
});
