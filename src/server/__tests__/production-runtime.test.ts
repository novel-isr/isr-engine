import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startAppServer, shutdownServer } from '../manager';
import { normalizeEngineConfig } from '@/config/normalizeEngineConfig';

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
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  vi.stubEnv('NODE_ENV', 'production');
  const config = normalizeEngineConfig({
    renderMode: 'isr',
    revalidate: 3600,
    routes: {},
    ssg: {},
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
  expect(ctx.manifest).toEqual({ entry: { file: 'assets/main.js' } });
  expect(await (await fetch(`${ctx.url}/custom`)).text()).toBe('custom route');
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
});
