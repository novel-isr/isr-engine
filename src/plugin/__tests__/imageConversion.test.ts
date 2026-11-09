import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createImageMiddleware, createImagePlugin } from '../createImagePlugin';
import type { IncomingMessage, ServerResponse } from 'node:http';

describe('installed image optimizer', () => {
  it('really resizes and converts pixels through the image endpoint', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'image-conversion-'));
    try {
      await mkdir(path.join(root, 'public'));
      await writeFile(
        path.join(root, 'public/a.png'),
        await sharp({ create: { width: 80, height: 40, channels: 3, background: '#ff0000' } })
          .png()
          .toBuffer()
      );
      type Middleware = ReturnType<typeof createImageMiddleware>;
      const plugin = createImagePlugin() as unknown as {
        configResolved(config: { root: string; publicDir: string }): void;
        configureServer(server: { middlewares: { use(handler: Middleware): void } }): void;
      };
      plugin.configResolved({ root, publicDir: path.join(root, 'public') });
      let middleware!: Middleware;
      plugin.configureServer({
        middlewares: {
          use(handler: Middleware) {
            middleware = handler;
          },
        },
      });
      const output = await new Promise<Buffer>((resolve, reject) => {
        const res = {
          statusCode: 200,
          setHeader() {},
          end(body: Buffer) {
            if (this.statusCode !== 200) reject(new Error(String(body)));
            else resolve(body);
          },
        };
        middleware(
          {
            url: '/_/img?src=/a.png&w=20&fmt=webp&q=70',
            method: 'GET',
            headers: {},
          } as IncomingMessage,
          res as unknown as ServerResponse,
          reject
        );
      });
      expect(await sharp(output).metadata()).toMatchObject({
        width: 20,
        height: 10,
        format: 'webp',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
