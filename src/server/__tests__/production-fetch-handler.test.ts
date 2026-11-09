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

it.each([
  [
    'default',
    `export default { state: 'default-owner', fetch() { return new Response(this.state); } };`,
  ],
  [
    'named fallback',
    `export default { state: 'wrong-owner' }; export const state = 'module-owner'; export function fetch() { return Promise.resolve(new Response(this.state)); }`,
  ],
])('serves a stateful %s Fetch export through real production HTTP', async (_name, source) => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'isr-fetch-owner-'));
  await fs.mkdir(path.join(root, 'dist/rsc'), { recursive: true });
  await fs.mkdir(path.join(root, 'dist/client'), { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  await fs.writeFile(path.join(root, 'dist/rsc/index.js'), source);
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  vi.stubEnv('NODE_ENV', 'production');
  const config = normalizeEngineConfig({
    renderMode: 'ssr',
    revalidate: 60,
    routes: {},
    server: { host: '127.0.0.1', port: 0 },
    ssg: { routes: [] },
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
  const ctx = await startAppServer(config, () => {});
  const response = await fetch(`${ctx.url}/state`);
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(_name === 'default' ? 'default-owner' : 'module-owner');
});
