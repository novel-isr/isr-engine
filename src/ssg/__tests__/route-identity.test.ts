import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { spiderSsgRoutes } from '../spider';
import { generateStaticCspManifest } from '@/security/staticCspManifest';
import { createProductionRuntime, type ProductionRuntime } from '@/server/productionRuntime';
import { normalizeEngineConfig } from '@/config/normalizeEngineConfig';

let root: string;
let runtime: ProductionRuntime | undefined;
afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
  if (root) await fs.rm(root, { recursive: true, force: true });
});

it.each([
  ['/foo', '/%66oo'],
  ['/%E4%B9%A6', '/%e4%b9%a6'],
])('rejects logical route collision %s and %s before rendering', async (a, b) => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ssg-identity-'));
  const fetch = vi.fn(
    async () => new Response('page', { headers: { 'content-type': 'text/html' } })
  );
  await expect(
    spiderSsgRoutes({ handler: { fetch }, routes: [a, b], outDir: root })
  ).rejects.toThrow(/route identity collision/i);
  expect(fetch).not.toHaveBeenCalled();
  expect(await fs.readdir(root)).toEqual([]);
});

async function fixture(): Promise<void> {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ssg-identity-build-'));
  await fs.mkdir(path.join(root, 'dist/rsc'), { recursive: true });
  await fs.mkdir(path.join(root, 'dist/client'), { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  await fs.writeFile(
    path.join(root, 'dist/rsc/index.js'),
    `export default { fetch: async () => new Response('dynamic', {headers: {'content-type':'text/html'}}) };`
  );
}

it('rejects conflicting SSG identities before publishing a build manifest', async () => {
  await fixture();
  await expect(
    generateStaticCspManifest(path.join(root, 'dist'), { ssgRoutes: ['/foo', '/%66oo'] })
  ).rejects.toThrow(/route identity collision/i);
  await expect(fs.access(path.join(root, 'dist/static-csp-manifest.json'))).rejects.toThrow();
});

it('rejects SSG and explicit route identity conflicts before loading application code', async () => {
  await fixture();
  // A startup conflict must be diagnosed before this intentionally invalid module executes.
  await fs.writeFile(
    path.join(root, 'dist/rsc/index.js'),
    `throw new Error('application loaded');`
  );
  const config = normalizeEngineConfig({
    renderMode: 'isr',
    revalidate: 3600,
    routes: { '/%66oo': 'ssr' },
    ssg: { routes: ['/foo'] },
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
  await expect(
    createProductionRuntime(config, {
      build: {
        rscDistEntry: path.join(root, 'dist/rsc/index.js'),
        clientDir: path.join(root, 'dist/client'),
        staticCspIndex: {
          legacy: false,
          buildId: 'test',
          scriptHashes: new Map(),
          ssgRoutes: ['/foo'],
        },
      },
    }).then(result => {
      runtime = result;
      return result;
    })
  ).rejects.toThrow(/route identity collision/i);
});

it('keeps an encoded declared page ahead of an automatically derived Flight alias', async () => {
  await fixture();
  const config = normalizeEngineConfig({
    renderMode: 'isr',
    revalidate: 3600,
    routes: { '/foo': 'ssr' },
    ssg: { routes: ['/%66oo_.rsc'] },
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
  runtime = await createProductionRuntime(config, {
    build: {
      rscDistEntry: path.join(root, 'dist/rsc/index.js'),
      clientDir: path.join(root, 'dist/client'),
      staticCspIndex: {
        legacy: false,
        buildId: 'test',
        scriptHashes: new Map(),
        ssgRoutes: ['/%66oo_.rsc'],
      },
    },
  });
  const server = createServer(runtime.app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing HTTP port');
    const response = await fetch(`http://127.0.0.1:${address.port}/%66oo_.rsc`, {
      redirect: 'manual',
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
    expect(await response.text()).toBe('dynamic');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve()))
    );
  }
});
