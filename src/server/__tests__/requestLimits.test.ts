import { afterEach, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BoundedRateLimitStore,
  createRequestLimiter,
  resolveRequestLimitPolicy,
  validateRequestLimits,
} from '../requestLimits';
import { resolveOpsConfig } from '../opsConfig';
import { createCacheInspectorMiddleware } from '../../plugin/createCacheInspectorMiddleware';
import { createStaticHtmlMiddleware } from '../productionRuntime';
import { createIsrCacheHandler } from '../../plugin/isrCacheMiddleware';
import type { IsrCacheHandler } from '../../plugin/isrCacheMiddleware';
import type { RequestLimitPolicy } from '../../types/ISRConfig';
import { ISRRoutes } from '../../isr/ISRRoutes';

afterEach(() => vi.restoreAllMocks());

const smallPolicy = { windowMs: 60_000, maxRequests: 1, globalMaxRequests: 20, maxClients: 10 };

async function serve(
  handler: http.RequestListener,
  check: (url: string) => Promise<void>
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await check(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

function limitedApp(trustProxy: boolean | string, policy: RequestLimitPolicy = smallPolicy) {
  const app = express();
  app.set('trust proxy', trustProxy);
  const work = vi.fn();
  app.get('/', createRequestLimiter('ops', policy), (_req, res) => {
    work();
    res.send('accepted');
  });
  return { app, work };
}

it('bounds counters without evicting live quotas, then reclaims expired clients without timers', () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(10_000);
  const store = new BoundedRateLimitStore(1000, 1, 2);
  expect(store.increment('a').totalHits).toBe(1);
  expect(store.increment('b').totalHits).toBe(3);
  expect(store.size).toBe(1);
  expect(store.increment('a').totalHits).toBe(2);
  for (let count = 0; count < 100; count++) store.increment(`rotated-${count}`);
  expect(store.size).toBe(1);
  expect(store.increment('a').totalHits).toBe(3);
  clock.mockReturnValue(11_001);
  expect(store.increment('b').totalHits).toBe(1);
  expect(store.get('a')).toBeUndefined();
  expect(store.size).toBe(1);
});

it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, null, false])(
  'rejects invalid policy values: %j',
  value => {
    for (const field of ['windowMs', 'maxRequests', 'globalMaxRequests', 'maxClients']) {
      expect(() => resolveRequestLimitPolicy('ops', { [field]: value } as never)).toThrow();
    }
  }
);

it('validates category objects and keeps omitted values at their positive defaults', () => {
  expect(() => validateRequestLimits(false as never)).toThrow();
  expect(() => validateRequestLimits({ staticHtml: false } as never)).toThrow();
  expect(() => validateRequestLimits({ seo: { windowMs: 2_147_483_648 } })).toThrow();
  expect(resolveRequestLimitPolicy('ops', { maxRequests: undefined }).maxRequests).toBe(120);
});

it.each([false, true])('ignores spoofed forwarded identities with trust proxy %j', async trust => {
  const { app, work } = limitedApp(trust);
  await serve(app, async url => {
    const first = await fetch(url, { headers: { 'x-forwarded-for': '192.0.2.1' } });
    expect(first.status).toBe(200);
    expect(first.headers.get('ratelimit')).toBeNull();
    expect(first.headers.get('x-ratelimit-limit')).toBeNull();
    const blocked = await fetch(url, { headers: { 'x-forwarded-for': '192.0.2.2' } });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(blocked.headers.get('cache-control')).toBe('no-store');
    expect(work).toHaveBeenCalledTimes(1);
  });
});

it('uses explicit trusted proxies, groups rotating IPv6 addresses, and normalizes mapped IPv4', async () => {
  const { app } = limitedApp('loopback');
  await serve(app, async url => {
    const status = async (ip: string) =>
      (await fetch(url, { headers: { 'x-forwarded-for': ip } })).status;
    expect(await status('2001:db8:abcd:1::1')).toBe(200);
    expect(await status('2001:db8:abcd:2::2')).toBe(429);
    expect(await status('2001:db8:abce::1')).toBe(200);
    expect(await status('::ffff:192.0.2.1')).toBe(200);
    expect(await status('::ffff:c000:201')).toBe(429);
    expect(await status('192.0.2.1')).toBe(429);
    expect(await status('192.0.2.2')).toBe(200);
  });
});

it('caps aggregate work across clients and fails closed when client storage is full', async () => {
  for (const policy of [
    { ...smallPolicy, maxRequests: 10, globalMaxRequests: 2 },
    { ...smallPolicy, maxRequests: 2, maxClients: 1 },
  ]) {
    const { app, work } = limitedApp('loopback', policy);
    await serve(app, async url => {
      const status = async (ip: string) =>
        (await fetch(url, { headers: { 'x-forwarded-for': ip } })).status;
      expect(await status('192.0.2.1')).toBe(200);
      expect(await status('192.0.2.2')).toBe(policy.maxClients === 1 ? 429 : 200);
      expect(await status('192.0.2.3')).toBe(429);
      expect(work).toHaveBeenCalledTimes(policy.maxClients === 1 ? 1 : 2);
    });
  }
});

it('admits the client again after its window expires without a cleanup timer', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(10_000);
  const { app, work } = limitedApp(false, { ...smallPolicy, windowMs: 1000 });
  await serve(app, async url => {
    expect((await fetch(url)).status).toBe(200);
    expect((await fetch(url)).status).toBe(429);
    clock.mockReturnValue(11_001);
    expect((await fetch(url)).status).toBe(200);
    expect(work).toHaveBeenCalledTimes(2);
  });
});

it('guards raw Connect inventory before authentication and Redis inspection', async () => {
  const ops = resolveOpsConfig(
    {
      server: {
        requestLimits: { ops: smallPolicy },
        ops: { authToken: 'secret', inventory: { enabled: true, public: false } },
      },
    } as never,
    'production'
  );
  let tokenChecks = 0;
  Object.defineProperty(ops, 'authToken', {
    get: () => {
      tokenChecks++;
      return 'secret';
    },
  });
  const inspect = vi.fn();
  const handler = {
    getCacheInspection: inspect,
    getL2Inspection: inspect,
  } as unknown as IsrCacheHandler;
  const inventory = createCacheInspectorMiddleware(handler, ops);
  await serve(
    (req, res) =>
      inventory(req, res, () => {
        res.statusCode = 404;
        res.end();
      }),
    async url => {
      expect(
        (
          await fetch(url + '/__isr/cache/inventory', {
            headers: { authorization: 'Bearer wrong' },
          })
        ).status
      ).toBe(403);
      const checked = tokenChecks;
      expect(checked).toBeGreaterThan(0);
      expect(
        (
          await fetch(url + '/__isr/cache/inventory', {
            headers: { authorization: 'Bearer secret', 'x-forwarded-for': '192.0.2.99' },
          })
        ).status
      ).toBe(429);
      expect(tokenChecks).toBe(checked);
      expect(inspect).not.toHaveBeenCalled();
    }
  );
});

it('denies indexed HTML before sendFile while leaving cache hits and application SSR uncharged', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'isr-limit-html-'));
  const cache = createIsrCacheHandler({
    renderMode: 'ssr',
    revalidate: 3600,
    routes: { '/cached': 'isr' },
  } as never);
  try {
    await fs.mkdir(path.join(root, 'page'));
    await fs.writeFile(path.join(root, 'page/index.html'), '<html>indexed</html>');
    const sendFile = vi.spyOn(express.response, 'sendFile');
    const app = express();
    app.use(cache);
    app.use(
      createStaticHtmlMiddleware(
        root,
        {
          legacy: false,
          buildId: 'test',
          scriptHashes: new Map([['page/index.html', []]]),
        },
        smallPolicy
      )
    );
    app.get('/cached', (_req, res) => res.type('html').send('<html>cached page</html>'));
    app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
    await serve(app, async url => {
      expect((await fetch(url + '/page')).status).toBe(200);
      expect((await fetch(url + '/page?different=query')).status).toBe(429);
      expect(sendFile).toHaveBeenCalledTimes(1);
      for (let count = 0; count < 5; count++) {
        const cached = await fetch(url + '/cached');
        expect(cached.status).toBe(200);
        expect(await cached.text()).toContain('cached page');
        if (count > 0) expect(cached.headers.get('x-cache-status')).toBe('HIT');
        expect((await fetch(url + '/api/health')).status).toBe(200);
      }
      expect(sendFile).toHaveBeenCalledTimes(1);
    });
  } finally {
    await cache.destroy();
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('shares the SEO budget and rejects another request before filesystem probes or generation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'isr-limit-seo-'));
  try {
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    const exists = vi.spyOn(fsSync, 'existsSync');
    const generateSeo = vi.fn().mockResolvedValue(undefined);
    const app = express();
    new ISRRoutes({ generateSeo } as never, { debug() {}, error() {} } as never, {
      renderMode: 'isr',
      requestLimits: { seo: smallPolicy },
    }).setup(app);
    await serve(app, async url => {
      expect((await fetch(url + '/sitemap.xml')).status).toBe(200);
      expect(generateSeo).toHaveBeenCalledTimes(1);
      const probes = exists.mock.calls.length;
      expect(probes).toBeGreaterThan(0);
      expect((await fetch(url + '/robots.txt')).status).toBe(429);
      expect((await fetch(url + '/sitemap.xml')).status).toBe(429);
      expect(exists).toHaveBeenCalledTimes(probes);
      expect(generateSeo).toHaveBeenCalledTimes(1);
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
