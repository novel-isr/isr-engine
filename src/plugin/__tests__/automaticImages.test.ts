import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import type { ResolvedConfig, ViteDevServer } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createAutomaticImagePlugin } from '../createAutomaticImagePlugin';
import { describe, expect, it } from 'vitest';
import { createIsrPlugin } from '../createIsrPlugin';
import { resolveImageOptions } from '../../config/resolveImageOptions';
import type { Plugin } from 'vite';

describe('automatic image endpoint', () => {
  it('serves a real converted image from the normal engine plugin stack', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'automatic-image-'));
    try {
      await mkdir(path.join(root, 'src'));
      await mkdir(path.join(root, 'public'));
      await writeFile(path.join(root, 'src/app.tsx'), 'export function App() { return null; }');
      await writeFile(
        path.join(root, 'public/image.png'),
        await sharp({ create: { width: 40, height: 20, channels: 3, background: 'red' } })
          .png()
          .toBuffer()
      );
      const plugins = (createIsrPlugin({ root, config: { renderMode: 'ssr' } }) as unknown[]).flat(
        Infinity
      ) as Plugin[];
      const image = plugins.find(plugin => plugin.name === 'novel-isr:automatic-images');
      expect(image).toBeDefined();
      const resolved = {
        root,
        publicDir: path.join(root, 'public'),
        plugins,
      } as unknown as ResolvedConfig;
      const configure = image?.configResolved as (config: ResolvedConfig) => Promise<void>;
      await configure(resolved);
      let middleware!: (req: IncomingMessage, res: ServerResponse, next: () => void) => void;
      const server = {
        middlewares: {
          use(handler: typeof middleware) {
            middleware = handler;
          },
        },
      } as unknown as ViteDevServer;
      (image?.configureServer as (server: ViteDevServer) => void)(server);
      const listener = createServer((req, res) =>
        middleware(req, res, () => {
          res.statusCode = 404;
          res.end();
        })
      );
      listener.listen(0, '127.0.0.1');
      await once(listener, 'listening');
      try {
        const port = (listener.address() as import('node:net').AddressInfo).port;
        const response = await fetch(`http://127.0.0.1:${port}/_/img?src=/image.png&w=10&fmt=webp`);
        expect(response.status).toBe(200);
        expect(await sharp(Buffer.from(await response.arrayBuffer())).metadata()).toMatchObject({
          width: 10,
          height: 5,
          format: 'webp',
        });
      } finally {
        listener.closeAllConnections();
        await new Promise<void>(resolve => listener.close(() => resolve()));
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('defers to an explicitly installed image plugin', async () => {
    const image = createAutomaticImagePlugin('/unused', {});
    await (image.configResolved as (config: ResolvedConfig) => Promise<void>)({
      plugins: [{ name: 'novel-isr:image-optimization' }],
    } as unknown as ResolvedConfig);
    let registered = false;
    (image.configureServer as (server: ViteDevServer) => void)({
      middlewares: {
        use() {
          registered = true;
        },
      },
    } as unknown as ViteDevServer);
    expect(registered).toBe(false);
  });
  it('defaults to denying remote sources', () => {
    expect(resolveImageOptions(undefined)).toEqual({ remoteAllowlist: [] });
  });
  it('normalizes exact hostname and port entries', () => {
    expect(resolveImageOptions({ remoteAllowlist: ['CDN.example.com:8443'] })).toEqual({
      remoteAllowlist: ['cdn.example.com:8443'],
    });
  });
  it.each([
    null,
    [],
    { other: true },
    { remoteAllowlist: '*' },
    { remoteAllowlist: ['https://example.com/a'] },
    { remoteAllowlist: ['*.example.com'] },
    { remoteAllowlist: ['user@example.com'] },
    { remoteAllowlist: ['example.com/a'] },
  ])('rejects invalid image policy %j', value => {
    expect(() => resolveImageOptions(value)).toThrow('runtime.images');
  });
});

import { isAllowedImageOrigin } from '../remoteImageSource';
it.each([
  ['cdn.test:443', 'http://cdn.test/a', false],
  ['cdn.test:443', 'http://cdn.test:443/a', true],
  ['cdn.test:443', 'https://cdn.test/a', true],
  ['cdn.test:80', 'https://cdn.test/a', false],
  ['cdn.test:80', 'http://cdn.test/a', true],
  ['cdn.test', 'http://cdn.test/a', true],
  ['cdn.test', 'https://cdn.test/a', true],
  ['cdn.test', 'https://cdn.test:8443/a', false],
  ['[2606:4700:4700::1111]:443', 'https://[2606:4700:4700::1111]/a', true],
  ['[2606:4700:4700::1111]:443', 'http://[2606:4700:4700::1111]/a', false],
])('matches configured authority %s against %s', (host, source, expected) => {
  const options = resolveImageOptions({ remoteAllowlist: [host] });
  expect(isAllowedImageOrigin(new URL(source), new Set(options.remoteAllowlist))).toBe(expected);
});
