import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { startAppServer, shutdownServer } from '../manager';
import { normalizeEngineConfig } from '@/config/normalizeEngineConfig';
import { generateStaticCspManifest } from '@/security/staticCspManifest';

let root: string;
afterEach(async () => {
  await shutdownServer();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (root) await fs.rm(root, { recursive: true, force: true });
});

it('programmatic production serves the built Fetch handler, preserves actions and releases its listener', async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'isr-production-runtime-'));
  await fs.mkdir(path.join(root, 'dist/rsc'), { recursive: true });
  await fs.mkdir(path.join(root, 'dist/client'), { recursive: true });
  await fs.mkdir(path.join(root, 'dist/client/.vite'));
  await fs.writeFile(
    path.join(root, 'dist/client/.vite/manifest.json'),
    '{"entry":{"file":"assets/main.js"}}'
  );
  await fs.writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  await fs.writeFile(
    path.join(root, 'dist/rsc/index.js'),
    `export default { fetch: async request => new Response(request.method === 'POST' ? await request.text() : '<html><body>production fixture</body></html>', { headers: { 'content-type': 'text/html' } }) };`
  );
  await fs.mkdir(path.join(root, 'dist/client/prebuilt'));
  await fs.writeFile(
    path.join(root, 'dist/client/prebuilt/index.html'),
    '<html><body>immutable build route</body></html>'
  );
  await fs.mkdir(path.join(root, 'dist/client/%E4%B9%A6'));
  await fs.writeFile(path.join(root, 'dist/client/%E4%B9%A6/index.html'), 'encoded Unicode build');
  await generateStaticCspManifest(path.join(root, 'dist'), {
    ssgRoutes: ['/prebuilt', '/%E4%B9%A6'],
  });
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  vi.stubEnv('NODE_ENV', 'production');
  const config = normalizeEngineConfig({
    renderMode: 'isr',
    revalidate: 3600,
    routes: { '/prebuilt/custom.html': 'ssr' },
    ssg: {
      routes: async () => {
        throw new Error('build-only CMS discovery must never run at startup');
      },
    },
    server: { port: 0, host: '127.0.0.1' },
    runtime: {
      site: 'https://example.com',
      services: { api: undefined, telemetry: undefined },
      redis: undefined,
      experiments: {},
      i18n: undefined,
      seo: undefined,
      telemetry: false,
    },
  } as never);
  const started = startAppServer(config, app => {
    app.get('/custom', (_req, res) => res.send('custom route'));
  });
  const concurrent = startAppServer(config, () => {});
  const [ctx, same] = await Promise.all([started, concurrent]);
  expect(same).toBe(ctx);
  expect(ctx.requestHandler.get('trust proxy')).toBe(false);
  expect(ctx.manifest).toEqual({ entry: { file: 'assets/main.js' } });
  expect(await (await fetch(`${ctx.url}/custom`)).text()).toBe('custom route');
  for (const [alias, canonical] of [
    ['/prebuilt/', '/prebuilt'],
    ['/prebuilt/index.html', '/prebuilt'],
    ['/prebuilt/_.rsc', '/prebuilt_.rsc'],
    ['/%70rebuilt', '/prebuilt'],
    ['/%70rebuilt/', '/prebuilt'],
    ['/prebuilt/%69ndex.html', '/prebuilt'],
    ['/%70rebuilt/_.rsc', '/prebuilt_.rsc'],
    ['/%E4%B9%A6/', '/%E4%B9%A6'],
    ['/%E4%B9%A6/index.html', '/%E4%B9%A6'],
    ['/%25E4%25B9%25A6/index.html', '/%E4%B9%A6'],
  ]) {
    const response = await fetch(`${ctx.url}${alias}?keep=a%2Fb`, { redirect: 'manual' });
    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toBe(`${canonical}?keep=a%2Fb`);
  }
  const unicode = await fetch(`${ctx.url}/%E4%B9%A6`, { redirect: 'manual' });
  expect(unicode.status).toBe(200);
  expect(unicode.headers.get('location')).toBeNull();
  expect(await unicode.text()).toBe('encoded Unicode build');
  const customHtml = await fetch(`${ctx.url}/prebuilt/custom.html?keep=yes`, {
    redirect: 'manual',
  });
  expect(customHtml.status).toBe(200);
  expect(customHtml.headers.get('location')).toBeNull();
  expect(await customHtml.text()).toContain('production fixture');
  const prebuilt = await fetch(`${ctx.url}/prebuilt`);
  expect(prebuilt.headers.get('x-served-by')).toBe('ssg-static');
  expect(await prebuilt.text()).toContain('immutable build route');
  const response = await fetch(ctx.url!);
  expect(response.status).toBe(200);
  expect(await response.text()).toContain('production fixture');
  expect(response.headers.get('content-security-policy')).toContain('script-src');
  const action = await fetch(ctx.url!, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{ "action": true }',
  });
  expect(await action.text()).toBe('{ "action": true }');
  await shutdownServer();
  await expect(fetch(ctx.url!)).rejects.toThrow();
  config.server.trustProxy = 'loopback';
  config.routes = { '/prebuilt/index.html': 'ssr', '/prebuilt/': 'isr' };
  const trusted = await startAppServer(config, () => {});
  expect(trusted.requestHandler.get('trust proxy')).toBe('loopback');
  for (const [alias, mode] of [
    ['/prebuilt/index.html', 'ssr'],
    ['/prebuilt/', 'isr'],
    ['/prebuilt/index.html_.rsc', 'ssr'],
  ]) {
    const response = await fetch(`${trusted.url}${alias}`, { redirect: 'manual' });
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('x-resolved-mode')).toBe(mode);
    expect(response.headers.get('x-served-by')).not.toBe('ssg-static');
    expect(await response.text()).toContain('production fixture');
  }
  // The slash before _.rsc is a transport alias, not a separate trailing-slash page.
  const flightAlias = await fetch(`${trusted.url}/prebuilt/_.rsc`, { redirect: 'manual' });
  expect(flightAlias.status).toBe(308);
  expect(flightAlias.headers.get('location')).toBe('/prebuilt_.rsc');
  const encodedOverride = await fetch(`${trusted.url}/prebuilt/%69ndex.html`, {
    redirect: 'manual',
  });
  expect(encodedOverride.status).toBe(308);
  expect(encodedOverride.headers.get('location')).toBe('/prebuilt/index.html');
  await shutdownServer();
  const manifestPath = path.join(root, 'dist/static-csp-manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const payload = {
    schemaVersion: 2,
    deploymentFiles: manifest.deploymentFiles,
    files: manifest.files.map(
      ({
        path,
        sha256,
        scriptHashes,
      }: {
        path: string;
        sha256: string;
        scriptHashes: string[];
      }) => ({ path, sha256, scriptHashes })
    ),
  };
  await fs.writeFile(
    manifestPath,
    JSON.stringify({
      ...payload,
      buildId: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
    })
  );
  config.routes = {};
  config.ssg.routes = ['/prebuilt'];
  const legacy = await startAppServer(config, () => {});
  const legacyAlias = await fetch(`${legacy.url}/prebuilt/index.html`, { redirect: 'manual' });
  expect(legacyAlias.status).toBe(308);
  expect(legacyAlias.headers.get('location')).toBe('/prebuilt');
  const legacyCanonical = await fetch(`${legacy.url}/prebuilt`);
  expect(legacyCanonical.headers.get('x-served-by')).toBe('ssg-runtime');
  expect(await legacyCanonical.text()).toContain('production fixture');
});
