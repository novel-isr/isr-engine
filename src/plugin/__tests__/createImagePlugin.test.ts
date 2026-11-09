import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createImageMiddleware, createImagePlugin } from '../createImagePlugin';

vi.mock('sharp', () => ({
  default: () => ({
    rotate() {
      return this;
    },
    resize() {
      return this;
    },
    toFormat() {
      return this;
    },
    toBuffer: async () => Buffer.from('converted'),
  }),
}));
let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'image-test-'));
  await mkdir(path.join(root, 'public'));
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});
type Middleware = ReturnType<typeof createImageMiddleware>;
interface Result {
  statusCode: number;
  headers: Record<string, string | number>;
  body?: unknown;
  next?: boolean;
}
function handler(options = {}, production = false, dependencies = {}) {
  const plugin = createImagePlugin(options, dependencies) as unknown as {
    configResolved(config: { root: string; publicDir: string }): void;
    configureServer(server: { middlewares: { use(fn: Middleware): void } }): void;
  };
  plugin.configResolved({ root, publicDir: path.join(root, 'public') });
  let middleware: Middleware;
  plugin.configureServer({
    middlewares: {
      use(fn: Middleware) {
        middleware = fn;
      },
    },
  });
  if (production) {
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    middleware = createImageMiddleware(options, dependencies);
  }
  return (src: string, headers = {}, pathname = '/_/img', query = '', method = 'GET') =>
    new Promise<Result>((resolve, reject) => {
      const result: Result = { statusCode: 200, headers: {} };
      const res = {
        setHeader(k: string, v: string | number) {
          result.headers[k] = v;
        },
        end(body: unknown) {
          resolve({ ...result, body });
        },
        get statusCode() {
          return result.statusCode;
        },
        set statusCode(n) {
          result.statusCode = n;
        },
      };
      Promise.resolve(
        middleware(
          {
            url: `${pathname}?src=${encodeURIComponent(src)}${query}`,
            headers,
            method,
          } as IncomingMessage,
          res as unknown as ServerResponse,
          () => resolve({ next: true, statusCode: 0, headers: {} })
        )
      ).catch(reject);
    });
}
describe('image endpoint boundaries', () => {
  it('rejects sibling paths and symlinks outside public', async () => {
    await mkdir(path.join(root, 'public-other'));
    await writeFile(path.join(root, 'public-other/a'), 'secret');
    await symlink(path.join(root, 'public-other/a'), path.join(root, 'public/link'));
    const request = handler();
    expect((await request('../public-other/a')).statusCode).toBe(400);
    expect((await request('/link')).statusCode).toBe(400);
  });
  it('matches only the configured pathname', async () => {
    expect(await handler()('/a', {}, '/_/img-other')).toMatchObject({ next: true });
  });
  it('revalidates mutable images and varies negotiated formats, including 304', async () => {
    await writeFile(path.join(root, 'public/a'), 'image');
    const request = handler();
    const first = await request('/a', { accept: 'image/webp' });
    expect(first.headers.vary).toBe('Accept');
    expect(first.headers['cache-control']).not.toContain('immutable');
    const second = await request('/a', {
      accept: 'image/webp',
      'if-none-match': first.headers.etag,
    });
    expect(second.statusCode).toBe(304);
    expect(second.headers.vary).toBe('Accept');
    expect(second.headers['cache-control']).toBe(first.headers['cache-control']);
  });
});

describe('production image service resilience', () => {
  it('bounds simultaneous transformations and releases slots afterwards', async () => {
    await writeFile(path.join(root, 'public/a'), 'image');
    let finish!: () => void;
    const gate = new Promise<void>(resolve => {
      finish = resolve;
    });
    const request = handler({}, true, {
      loadSharp: async () => ({
        default: () => ({
          rotate() {
            return this;
          },
          resize() {
            return this;
          },
          toFormat() {
            return this;
          },
          async toBuffer() {
            await gate;
            return Buffer.from('converted');
          },
        }),
      }),
    });
    const pending = Array.from({ length: 4 }, (_, i) => request('/a', {}, '/_/img', `&w=${i + 1}`));
    expect((await request('/a', {}, '/_/img', '&w=100')).statusCode).toBe(503);
    finish();
    expect((await Promise.all(pending)).every(result => result.statusCode === 200)).toBe(true);
    expect((await request('/a', {}, '/_/img', '&w=101')).statusCode).toBe(200);
  });
  it('refreshes transformed sources after cache TTL', async () => {
    await writeFile(path.join(root, 'public/a'), 'image');
    let now = 100;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const transform = vi.fn(async () => Buffer.from('converted'));
    const request = handler({}, true, {
      loadSharp: async () => ({
        default: () => ({
          rotate() {
            return this;
          },
          toFormat() {
            return this;
          },
          toBuffer: transform,
        }),
      }),
    });
    await request('/a');
    await request('/a');
    expect(transform).toHaveBeenCalledTimes(1);
    now += 60_001;
    await new Promise(resolve => setTimeout(resolve, 5));
    await request('/a');
    expect(transform).toHaveBeenCalledTimes(2);
  });
  it('contains source failures and continues serving later requests', async () => {
    await writeFile(path.join(root, 'public/a'), 'image');
    const request = handler({}, true);
    expect((await request('https://blocked.test/a')).statusCode).toBe(400);
    expect((await request('/missing')).statusCode).toBe(404);
    expect((await request('/a')).statusCode).toBe(200);
  });
});

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'base64'
);
describe('explicit original image capability', () => {
  const absent = { loadSharp: async () => null };
  it('serves bounded raster originals without an optimizer and preserves HEAD and conditional GET', async () => {
    await writeFile(path.join(root, 'public/a'), png);
    const request = handler({}, true, absent);
    const first = await request('/a', {}, '/_/img', '&fmt=original');
    expect(first.statusCode).toBe(200);
    expect(first.body).toEqual(png);
    expect(first.headers['content-type']).toBe('image/png');
    expect(first.headers['x-content-type-options']).toBe('nosniff');
    expect((await request('/a', {}, '/_/img', '&fmt=original', 'HEAD')).body).toBeUndefined();
    expect(
      (await request('/a', { 'if-none-match': first.headers.etag }, '/_/img', '&fmt=original'))
        .statusCode
    ).toBe(304);
    expect((await request('/a')).statusCode).toBe(501);
    expect((await request('/a', {}, '/_/img', '&fmt=original&w=10')).statusCode).toBe(400);
    expect((await request('/a', {}, '/_/img', '&fmt=original&q=80')).statusCode).toBe(400);
  });
  it('honors Accept exclusions on cached originals and rejects active content', async () => {
    await writeFile(path.join(root, 'public/a'), png);
    await writeFile(path.join(root, 'public/svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const request = handler({}, false, absent);
    expect((await request('/a', { accept: 'image/*' }, '/_/img', '&fmt=original')).statusCode).toBe(
      200
    );
    expect(
      (await request('/a', { accept: 'image/png;q=0, */*;q=1' }, '/_/img', '&fmt=original'))
        .statusCode
    ).toBe(406);
    expect((await request('/svg', {}, '/_/img', '&fmt=original')).statusCode).toBe(415);
    expect((await request('/a', {}, '/_/img', '&fmt=garbage')).statusCode).toBe(400);
  });
  it('keeps source security checks without sharp', async () => {
    const request = handler({}, false, absent);
    expect(
      (await request('https://blocked.test/a', {}, '/_/img', '&fmt=original')).statusCode
    ).toBe(400);
    expect((await request('../secret', {}, '/_/img', '&fmt=original')).statusCode).toBe(400);
  });
});

describe('original source validation and capability isolation', () => {
  it('rejects truncated PNG and HTML even with misleading extensions', async () => {
    const request = handler({}, false, { loadSharp: async () => null });
    await writeFile(path.join(root, 'public/truncated.png'), png.subarray(0, 33));
    await writeFile(path.join(root, 'public/fake.jpg'), '<html>active</html>');
    expect((await request('/truncated.png', {}, '/_/img', '&fmt=original')).statusCode).toBe(415);
    expect((await request('/fake.jpg', {}, '/_/img', '&fmt=original')).statusCode).toBe(415);
  });
  it('does not load an optimizer for originals or share absent capability across instances', async () => {
    await writeFile(path.join(root, 'public/a'), png);
    const missing = vi.fn(async () => null);
    const absent = handler({}, false, { loadSharp: missing });
    await absent('/a', {}, '/_/img', '&fmt=original');
    expect(missing).not.toHaveBeenCalled();
    expect((await absent('/a')).statusCode).toBe(501);
    expect((await absent('/a')).statusCode).toBe(501);
    expect(missing).toHaveBeenCalledTimes(1);
    expect((await handler()('/a')).statusCode).toBe(200);
  });

  it('honors excluded and preferred transformed formats', async () => {
    await writeFile(path.join(root, 'public/a'), png);
    const request = handler();
    expect(
      (await request('/a', { accept: 'image/avif;q=0,image/webp;q=0.8,image/jpeg;q=0.5' })).headers[
        'content-type'
      ]
    ).toBe('image/webp');
    expect((await request('/a', { accept: 'image/*;q=0' })).statusCode).toBe(406);
  });
});
