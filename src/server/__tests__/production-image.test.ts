import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { startAppServer, shutdownServer } from '../manager';
import { normalizeEngineConfig } from '../../config/normalizeEngineConfig';
import * as remote from '../../plugin/remoteImageSource';

let root: string;
afterEach(async () => {
  await shutdownServer();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (root) await fs.rm(root, { recursive: true, force: true });
});

it('production image endpoint consumes the explicit runtime image allowlist', async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'production-image-'));
  await fs.mkdir(path.join(root, 'dist/rsc'), { recursive: true });
  await fs.mkdir(path.join(root, 'dist/client/.vite'), { recursive: true });
  await fs.writeFile(path.join(root, 'dist/client/.vite/manifest.json'), '{}');
  await fs.writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  await fs.writeFile(
    path.join(root, 'dist/rsc/index.js'),
    'export default { fetch: async () => new Response("page") };'
  );
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  vi.stubEnv('NODE_ENV', 'production');
  const source = await sharp({ create: { width: 40, height: 20, channels: 3, background: 'red' } })
    .png()
    .toBuffer();
  await fs.writeFile(path.join(root, 'dist/client/local.png'), source);
  const fetcher = vi.spyOn(remote, 'fetchRemoteImage').mockResolvedValue(source);
  const config = normalizeEngineConfig({
    renderMode: 'ssr',
    revalidate: 60,
    routes: {},
    ssg: { routes: [] },
    server: { port: 0, host: '127.0.0.1' },
    runtime: {
      site: 'https://example.com',
      services: { api: undefined, telemetry: undefined },
      redis: undefined,
      experiments: {},
      i18n: undefined,
      seo: undefined,
      telemetry: false,
      images: { remoteAllowlist: ['cdn.example.com'] },
    },
  } as never);
  const ctx = await startAppServer(config, () => {});
  const response = await fetch(
    `${ctx.url}/_/img?src=https%3A%2F%2Fcdn.example.com%2Fa.png&w=10&fmt=webp`
  );
  expect(response.status).toBe(200);
  expect(await sharp(Buffer.from(await response.arrayBuffer())).metadata()).toMatchObject({
    width: 10,
    height: 5,
    format: 'webp',
  });
  const local = await fetch(`${ctx.url}/_/img?src=/local.png&w=10&fmt=webp`);
  expect(local.status).toBe(200);
  expect(await sharp(Buffer.from(await local.arrayBuffer())).metadata()).toMatchObject({
    width: 10,
    height: 5,
    format: 'webp',
  });
  expect(fetcher).toHaveBeenCalledWith(
    'https://cdn.example.com/a.png',
    new Set(['cdn.example.com']),
    25 * 1024 * 1024
  );
});
