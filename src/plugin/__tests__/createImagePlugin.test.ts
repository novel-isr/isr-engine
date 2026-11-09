import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createImageMiddleware, createImagePlugin } from '../createImagePlugin';

vi.mock('sharp', () => ({
  default: () => ({
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
function handler(options = {}, production = false) {
  const plugin = createImagePlugin(options) as unknown as {
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
    middleware = createImageMiddleware(options);
  }
  return (src: string, headers = {}, pathname = '/_/img') =>
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
          { url: `${pathname}?src=${encodeURIComponent(src)}`, headers } as IncomingMessage,
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
  it('checks redirect destinations before fetching them', async () => {
    const fetcher = vi.fn(
      async (_url: unknown, _options: unknown) =>
        new Response(null, { status: 302, headers: { location: 'http://blocked.test/a' } })
    );
    vi.stubGlobal('fetch', fetcher);
    expect(
      (await handler({ remoteAllowlist: ['allowed.test'] })('https://allowed.test/a')).statusCode
    ).toBe(400);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
  });
  it('rejects oversize streams before buffering the entire response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(new Uint8Array(26 * 1024 * 1024));
                c.close();
              },
            })
          )
      )
    );
    expect(
      (await handler({ remoteAllowlist: ['allowed.test'] })('https://allowed.test/a')).statusCode
    ).toBe(413);
  });
});

describe('production image service resilience', () => {
  it('contains source failures and continues serving later requests', async () => {
    await writeFile(path.join(root, 'public/a'), 'image');
    const request = handler({}, true);
    expect((await request('https://blocked.test/a')).statusCode).toBe(400);
    expect((await request('/missing')).statusCode).toBe(404);
    expect((await request('/a')).statusCode).toBe(200);
  });
  it('aborts stalled upstream requests within ten seconds', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: unknown, options: RequestInit) =>
          new Promise((_resolve, reject) => {
            options.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          })
      )
    );
    const pending = handler({ remoteAllowlist: ['allowed.test'] }, true)('https://allowed.test/a');
    await vi.advanceTimersByTimeAsync(10_001);
    expect((await pending).statusCode).toBe(504);
  });
  it('bounds simultaneous processing and releases slots after failure', async () => {
    let finish!: () => void;
    const gate = new Promise<void>(resolve => {
      finish = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        await gate;
        return new Response('image');
      })
    );
    const request = handler({ remoteAllowlist: ['allowed.test'] }, true);
    const pending = Array.from({ length: 4 }, (_, i) => request(`https://allowed.test/${i}`));
    expect((await request('https://allowed.test/busy')).statusCode).toBe(503);
    finish();
    expect((await Promise.all(pending)).every(r => r.statusCode === 200)).toBe(true);
    expect((await request('https://allowed.test/next')).statusCode).toBe(200);
  });
  it('refreshes cached mutable sources after the cache TTL', async () => {
    let now = 100;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const fetcher = vi.fn(async () => new Response('image'));
    vi.stubGlobal('fetch', fetcher);
    const request = handler({ remoteAllowlist: ['allowed.test'] }, true);
    await request('https://allowed.test/a');
    await request('https://allowed.test/a');
    expect(fetcher).toHaveBeenCalledTimes(1);
    now += 60_001;
    await new Promise(resolve => setTimeout(resolve, 5));
    await request('https://allowed.test/a');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
