import { afterEach, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BoundedRateLimitStore,
  admitRequest,
  createRequestLimiter,
  resolveRequestLimitPolicy,
  validateRequestLimits,
} from '../requestLimits';
import { bindRuntimeOpsConfig, getRuntimeOpsConfig, resolveOpsConfig } from '../opsConfig';
import { createCacheInspectorMiddleware } from '../../plugin/createCacheInspectorMiddleware';
import { createProductionRuntime, createStaticHtmlMiddleware } from '../productionRuntime';
import { createIsrCacheHandler, createIsrCacheMiddleware } from '../../plugin/isrCacheMiddleware';
import type { IsrCacheHandler } from '../../plugin/isrCacheMiddleware';
import type { RequestLimitPolicy, RuntimeSitemapConfig } from '../../types/ISRConfig';
import { revalidateContent } from '../../rsc/revalidate';
import { ISRRoutes } from '../../isr/ISRRoutes';
import { normalizeEngineConfig } from '../../config/normalizeEngineConfig';
import { generateStaticCspManifest } from '../../security/staticCspManifest';
import type { Connect, ViteDevServer } from 'vite';

async function productionFixture(options: {
  files: Record<string, string>;
  ssgRoutes?: string[];
  staticHtml?: RequestLimitPolicy;
  seo?: RequestLimitPolicy;
  sitemap?: RuntimeSitemapConfig;
}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'isr-limit-production-'));
  try {
    await fs.mkdir(path.join(root, 'dist/rsc'), { recursive: true });
    await fs.mkdir(path.join(root, 'dist/client'), { recursive: true });
    await fs.writeFile(path.join(root, 'package.json'), '{"type":"module"}');
    await fs.writeFile(
      path.join(root, 'dist/rsc/index.js'),
      'export default { fetch: () => new Response("<html>origin fallback</html>", { headers: { "content-type": "text/html" } }) };'
    );
    for (const [file, body] of Object.entries(options.files)) {
      const target = path.join(root, 'dist/client', file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, body);
    }
    await generateStaticCspManifest(path.join(root, 'dist'), {
      ssgRoutes: options.ssgRoutes ?? [],
    });
    const config = normalizeEngineConfig({
      renderMode: 'ssr',
      revalidate: 3600,
      routes: {},
      server: {
        port: 0,
        host: '127.0.0.1',
        requestLimits: {
          staticHtml: options.staticHtml,
          seo: options.seo,
        },
      },
      ssg: { routes: options.ssgRoutes ?? [] },
      runtime: {
        site: 'https://example.com',
        services: { api: undefined, telemetry: undefined },
        redis: undefined,
        experiments: {},
        i18n: undefined,
        seo: options.sitemap && {
          endpoint: undefined,
          fallbackLocal: undefined,
          ttl: 60_000,
          timeoutMs: 1200,
          dynamicResolvers: undefined,
          sitemap: options.sitemap,
        },
        telemetry: false,
      },
    } as never);
    const runtime = await createProductionRuntime(config, { root });
    return {
      root,
      runtime,
      close: async () => {
        await runtime.close();
        await fs.rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
}

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

it('shares one file-read budget across cold SSG seeds and direct HTML, while allowing seeded HITs', async () => {
  const fixture = await productionFixture({
    files: {
      'a/index.html': '<html>seed a</html>',
      'b/index.html': '<html>seed b</html>',
      'direct/index.html': '<html>direct static</html>',
    },
    ssgRoutes: ['/a', '/b'],
    staticHtml: smallPolicy,
  });
  try {
    const reads = vi.spyOn(fs, 'readFile');
    const sends = vi.spyOn(express.response, 'sendFile');
    await serve(fixture.runtime.app, async url => {
      const seeded = await fetch(url + '/a');
      expect(seeded.status).toBe(200);
      expect(await seeded.text()).toContain('seed a');
      const countReads = () =>
        reads.mock.calls.filter(([target]) =>
          String(target).startsWith(path.join(fixture.root, 'dist/client'))
        ).length;
      expect(countReads()).toBe(1);
      for (let count = 0; count < 3; count++) {
        const hit = await fetch(url + '/a');
        expect(hit.status).toBe(200);
        expect(hit.headers.get('x-cache-status')).toBe('HIT');
      }
      for (const route of ['/b', '/direct']) {
        const blocked = await fetch(url + route);
        expect(blocked.status).toBe(429);
        expect(blocked.headers.get('cache-control')).toBe('no-store');
        expect(await blocked.text()).not.toContain('origin fallback');
      }
      expect(countReads()).toBe(1);
      expect(sends).not.toHaveBeenCalled();
    });
  } finally {
    await fixture.close();
  }
});

it.each([false, true])(
  'reserves seed admission before concurrent followers and never falls through after denial: %j',
  async exhausted => {
    const limiter = createRequestLimiter('staticHtml', smallPolicy);
    let release!: () => void;
    const ready = new Promise<void>(resolve => {
      release = resolve;
    });
    let arrivals = 0;
    const admission = vi.fn(async (req: http.IncomingMessage, res: http.ServerResponse) => {
      await ready;
      return admitRequest(limiter, req, res);
    });
    const seed = vi.fn(async () => ({
      body: Buffer.from('<html>one seed</html>'),
      statusCode: 200,
      contentType: 'text/html',
      headers: { 'content-type': 'text/html' },
      storedAt: Date.now(),
      expiresAt: 0,
      hardExpiresAt: 0,
      tags: [],
    }));
    const cache = createIsrCacheHandler({ renderMode: 'ssg', revalidate: 3600 } as never, {
      staticSeedInfo: () => ({ generatedAt: Date.now() }),
      staticSeedAdmission: admission,
      staticSeed: seed,
    });
    const origin = vi.fn();
    const app = express();
    app.get('/consume', limiter, (_req, res) => res.send('used'));
    app.use((req, _res, next) => {
      if (req.path === '/seed' && ++arrivals === 4) release();
      next();
    });
    app.use(cache);
    app.use((_req, res) => {
      origin();
      res.send('origin fallback');
    });
    try {
      await serve(app, async url => {
        if (exhausted) expect((await fetch(url + '/consume')).status).toBe(200);
        const responses = await Promise.all(Array.from({ length: 4 }, () => fetch(url + '/seed')));
        expect(responses.map(response => response.status)).toEqual(
          Array(4).fill(exhausted ? 429 : 200)
        );
        for (const response of responses) {
          expect(await response.text()).toContain(exhausted ? 'Too many requests' : 'one seed');
        }
        expect(seed).toHaveBeenCalledTimes(exhausted ? 0 : 1);
        expect(admission).toHaveBeenCalledTimes(1);
        expect(origin).not.toHaveBeenCalled();
        if (!exhausted) {
          expect((await fetch(url + '/seed')).status).toBe(200);
          expect(admission).toHaveBeenCalledTimes(1);
        }
      });
    } finally {
      release();
      await cache.destroy();
    }
  }
);

it('fails closed when seed admission raises an error', async () => {
  const seed = vi.fn();
  const origin = vi.fn();
  const cache = createIsrCacheHandler({ renderMode: 'ssg', revalidate: 3600 } as never, {
    staticSeed: seed,
    staticSeedAdmission: async () => {
      throw new Error('admission unavailable');
    },
  });
  const app = express();
  app.use(cache);
  app.use((_req, res) => {
    origin();
    res.send('origin fallback');
  });
  try {
    await serve(app, async url => {
      const blocked = await fetch(url + '/seed');
      expect(blocked.status).toBe(503);
      expect(blocked.headers.get('cache-control')).toBe('no-store');
      expect(seed).not.toHaveBeenCalled();
      expect(origin).not.toHaveBeenCalled();
    });
  } finally {
    await cache.destroy();
  }
});

it('limits static SEO before asset I/O and preserves the built robots and sitemap content', async () => {
  const fixture = await productionFixture({
    files: {
      'robots.txt': 'User-agent: *\nDisallow: /private\n',
      'sitemap.xml': '<urlset><url><loc>https://example.com/built</loc></url></urlset>',
    },
    seo: { ...smallPolicy, maxRequests: 2 },
  });
  try {
    const stat = vi.spyOn(fsSync, 'stat');
    await serve(fixture.runtime.app, async url => {
      const robots = await fetch(url + '/%72obots.txt');
      expect(robots.status).toBe(200);
      expect(await robots.text()).toContain('Disallow: /private');
      const sitemap = await fetch(url + '/sitemap.xml');
      expect(sitemap.status).toBe(200);
      expect(await sitemap.text()).toContain('/built');
      const before = stat.mock.calls.length;
      expect(before).toBeGreaterThan(0);
      const blocked = await fetch(url + '/robots.txt', { method: 'HEAD' });
      expect(blocked.status).toBe(429);
      expect(stat).toHaveBeenCalledTimes(before);
    });
  } finally {
    await fixture.close();
  }
});

it('charges generated SEO once at the same boundary as static SEO', async () => {
  const fixture = await productionFixture({ files: {}, seo: { ...smallPolicy, maxRequests: 2 } });
  try {
    await serve(fixture.runtime.app, async url => {
      const sitemap = await fetch(url + '/sitemap.xml');
      expect(sitemap.status).toBe(200);
      expect(await sitemap.text()).toContain('urlset');
      const robots = await fetch(url + '/robots.txt');
      expect(robots.status).toBe(200);
      expect(await robots.text()).toContain('User-agent: *');
      expect((await fetch(url + '/sitemap.xml')).status).toBe(429);
    });
  } finally {
    await fixture.close();
  }
});

it('serves only published, indexable sitemap URLs from a single bulk load', async () => {
  const load = vi.fn<RuntimeSitemapConfig['load']>(() => [
    { path: '/published', status: 'published', modifiedTime: '2024-05-13T10:00:00Z' },
    { path: '/not-indexed', status: 'published', noindex: true },
    { path: '/draft', status: 'draft' },
    { path: 'https://other.example.com/page', status: 'published' },
    { path: '/%61pi/page', status: 'published' },
    { path: '/invalid-date', status: 'published', modifiedTime: '2024-02-30' },
  ]);
  const fixture = await productionFixture({
    files: { 'sitemap.xml': '<urlset><url><loc>https://example.com/built</loc></url></urlset>' },
    sitemap: { load },
  });
  try {
    await serve(fixture.runtime.app, async url => {
      const responses = await Promise.all([
        fetch(url + '/sitemap.xml'),
        fetch(url + '/s%69temap.xml'),
      ]);
      for (const response of responses) {
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('no-cache');
        const xml = await response.text();
        expect(xml.match(/<loc>[^<]+<\/loc>/g)).toEqual([
          '<loc>https://example.com/published</loc>',
          '<loc>https://example.com/invalid-date</loc>',
        ]);
        expect(xml.match(/<lastmod>[^<]+<\/lastmod>/g)).toEqual([
          '<lastmod>2024-05-13T10:00:00.000Z</lastmod>',
        ]);
      }
      expect(load).toHaveBeenCalledTimes(1);
    });
  } finally {
    await fixture.close();
  }
});

it('refreshes the publication sitemap after an event and leaves an empty catalog empty', async () => {
  const load = vi.fn<RuntimeSitemapConfig['load']>();
  load.mockReturnValueOnce([{ path: '/removed', status: 'published' }]).mockReturnValue([]);
  const fixture = await productionFixture({ files: {}, sitemap: { load } });
  try {
    await serve(fixture.runtime.app, async url => {
      const first = await fetch(url + '/sitemap.xml');
      expect(await first.text()).toContain('/removed</loc>');
      await revalidateContent({ sitemap: true });
      const fresh = await fetch(url + '/sitemap.xml');
      expect(fresh.status).toBe(200);
      const xml = await fresh.text();
      expect(xml).toContain('<urlset');
      expect(xml).not.toContain('<loc>');
    });
  } finally {
    await fixture.close();
  }
});

it('refreshes an in-flight publication sitemap that was invalidated before delivery', async () => {
  let release!: () => void;
  let signalStarted!: () => void;
  const pending = new Promise<void>(resolve => {
    release = resolve;
  });
  const started = new Promise<void>(resolve => {
    signalStarted = resolve;
  });
  const load = vi.fn<RuntimeSitemapConfig['load']>();
  load
    .mockImplementationOnce(async () => {
      signalStarted();
      await pending;
      return [{ path: '/superseded', status: 'published' }];
    })
    .mockReturnValue([{ path: '/current', status: 'published' }]);
  const fixture = await productionFixture({ files: {}, sitemap: { load } });
  try {
    await serve(fixture.runtime.app, async url => {
      const waiting = fetch(url + '/sitemap.xml');
      await started;
      await revalidateContent({ sitemap: true });
      release();
      const response = await waiting;
      expect(response.status).toBe(200);
      expect((await response.text()).match(/<loc>[^<]+<\/loc>/g)).toEqual([
        '<loc>https://example.com/current</loc>',
      ]);
    });
  } finally {
    await fixture.close();
  }
});

it('returns a retryable error when the publication sitemap source fails', async () => {
  const load = vi.fn<RuntimeSitemapConfig['load']>();
  load.mockRejectedValueOnce(new Error('upstream unavailable')).mockReturnValue([]);
  const fixture = await productionFixture({ files: {}, sitemap: { load } });
  try {
    await serve(fixture.runtime.app, async url => {
      const failed = await fetch(url + '/sitemap.xml');
      expect(failed.status).toBe(503);
      expect(failed.headers.get('cache-control')).toBe('no-store');
      expect(await failed.text()).not.toContain('upstream unavailable');
      const recovered = await fetch(url + '/sitemap.xml');
      expect(recovered.status).toBe(200);
      expect(await recovered.text()).toContain('<urlset');
    });
  } finally {
    await fixture.close();
  }
});

it.each(['/health', '/metrics'])(
  'shares the dev ops budget from Vite through Express after %s',
  async first => {
    const middleware: Connect.NextHandleFunction[] = [];
    const plugin = createIsrCacheMiddleware({
      renderMode: 'ssr',
      revalidate: 60,
      server: {
        requestLimits: { ops: smallPolicy },
        ops: {
          health: { enabled: true, public: true },
          metrics: { enabled: true, public: true },
          inventory: { enabled: true, public: true },
        },
      },
    } as never);
    const vite = {
      config: { root: '/unused' },
      middlewares: {
        use: (handler: Connect.NextHandleFunction) => {
          middleware.push(handler);
        },
      },
    } as unknown as ViteDevServer;
    const configure = plugin.configureServer;
    const close = plugin.closeBundle;
    if (!configure || !close) throw new Error('Expected cache lifecycle hooks');
    await (typeof configure === 'function' ? configure : configure.handler).call({} as never, vite);
    try {
      const app = express();
      const shared = getRuntimeOpsConfig(vite);
      expect(shared).toBeDefined();
      bindRuntimeOpsConfig(app, shared!);
      new ISRRoutes({} as never, { debug() {}, error() {} } as never, {
        renderMode: 'ssr',
        requestLimits: { ops: { maxRequests: 99 } },
      }).setup(app);
      for (const handler of middleware) app.use(handler as never);
      await serve(app, async url => {
        expect((await fetch(url + first)).status).toBe(200);
        for (const route of ['/health', '/metrics', '/__isr/cache/inventory']) {
          expect((await fetch(url + route)).status).toBe(429);
        }
      });
    } finally {
      await (typeof close === 'function' ? close : close.handler).call({} as never);
    }
  }
);
