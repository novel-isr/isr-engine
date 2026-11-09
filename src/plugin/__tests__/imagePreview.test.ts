import { afterEach, expect, it } from 'vitest';
import { build, preview, type PreviewServer } from 'vite';
import sharp from 'sharp';
import { mkdtemp, mkdir, writeFile, rm, readdir, symlink, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createImagePlugin } from '../createImagePlugin';
import { createAutomaticImagePlugin } from '../createAutomaticImagePlugin';

let server: PreviewServer | undefined;
let dir: string;
afterEach(async () => {
  if (server) {
    if ('closeAllConnections' in server.httpServer) server.httpServer.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server!.httpServer.close(error => (error ? reject(error) : resolve()))
    );
    server = undefined;
  }
  if (dir) await rm(dir, { recursive: true, force: true });
});

it.each(['explicit', 'automatic', 'disabled-public', 'client-environment'] as const)(
  'optimizes built assets from the client output without source files (%s)',
  async mode => {
    dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'image-preview-')));
    const root = path.join(dir, 'app');
    const outDir = '../output/client';
    const output = path.resolve(root, outDir);
    await mkdir(path.join(root, 'public'), { recursive: true });
    await mkdir(path.join(root, 'src'));
    const image = await sharp({ create: { width: 40, height: 20, channels: 3, background: 'red' } })
      .png()
      .toBuffer();
    await writeFile(path.join(root, 'public/cover.png'), image);
    await writeFile(path.join(root, 'src/imported.png'), image);
    await writeFile(
      path.join(root, 'index.html'),
      '<script type="module" src="/src/main.js"></script>'
    );
    await writeFile(
      path.join(root, 'src/main.js'),
      'import image from "./imported.png"; document.body.innerHTML = `<img src="${image}">`;'
    );
    const config = {
      configFile: false as const,
      root,
      logLevel: 'silent' as const,
      publicDir: mode === 'disabled-public' ? (false as const) : 'public',
      plugins: [
        mode === 'automatic'
          ? createAutomaticImagePlugin(root, { renderMode: 'ssr' })
          : createImagePlugin(),
      ],
      build: {
        outDir: mode === 'client-environment' ? '../wrong-output' : outDir,
        assetsInlineLimit: 0,
        emptyOutDir: true,
      },
      ...(mode === 'client-environment' ? { environments: { client: { build: { outDir } } } } : {}),
      preview: { host: '127.0.0.1', port: 0 },
    };
    await build(config);
    const asset = (await readdir(path.join(output, 'assets'))).find(name => name.endsWith('.png'))!;
    expect(asset).toMatch(/^imported-.*\.png$/);
    await rm(path.join(root, 'public'), { recursive: true });
    await rm(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(dir, 'secret.png'), image);
    await writeFile(path.join(root, 'source-only.png'), image);
    await symlink(path.join(dir, 'secret.png'), path.join(output, 'escape.png'));
    server = await preview(config);
    const port = (server.httpServer.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    const optimize = (src: string) =>
      fetch(`${base}/_/img?src=${encodeURIComponent(src)}&w=10&fmt=webp`);
    for (const src of [
      `/assets/${asset}?v=1#hero`,
      ...(mode === 'disabled-public' ? [] : ['/cover.png']),
    ]) {
      expect((await fetch(`${base}${src}`)).status).toBe(200);
      const response = await optimize(src);
      expect(response.status, src).toBe(200);
      expect(await sharp(Buffer.from(await response.arrayBuffer())).metadata()).toMatchObject({
        width: 10,
        height: 5,
        format: 'webp',
      });
    }
    if (mode === 'disabled-public') expect((await optimize('/cover.png')).status).toBe(404);
    for (const src of [
      '/escape.png',
      '/source-only.png',
      '/%2e%2e/secret.png',
      `/@fs${path.join(dir, 'secret.png')}`,
      '/bad%ZZ.png',
    ]) {
      expect((await optimize(src)).status, src).not.toBe(200);
    }
  }
);
