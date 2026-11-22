import { it, expect } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ISRConfig, RuntimeConfig, RouteRule } from '../types';
import type { ICacheAdapter, CacheSetOptions } from '../cache/ICacheAdapter';
import type { IsrCacheMiddlewareOptions } from '../plugin/isrCacheMiddleware';

import { createIsrCacheHandler } from '../plugin/isrCacheMiddleware';
import { createHybridCacheStore } from '../plugin/isrCacheStore';
import { revalidateContent, revalidatePath, revalidateTag } from '../rsc/revalidate';
import { createCompressionMiddleware } from '../server/middleware';
import {
  applyRuntimeToServerHooks,
  defineAdminSiteHooks,
} from '../defaults/runtime/defineSiteHooks';

async function fixture(
  render: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  options: IsrCacheMiddlewareOptions = {},
  {
    compression,
    ...config
  }: {
    routes?: Record<string, RouteRule>;
    runtime?: Partial<RuntimeConfig>;
    compression?: boolean;
  } = {}
) {
  const handler = createIsrCacheHandler(
    { renderMode: 'isr', revalidate: 3600, ...config } as Partial<ISRConfig>,
    options
  );
  const handle = (req: http.IncomingMessage, res: http.ServerResponse) =>
    handler(req, res, () => render(req, res));
  const server = compression
    ? http.createServer(
        express()
          .use(createCompressionMiddleware({ threshold: 0 }))
          .use(handle)
      )
    : http.createServer(handle);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    handler,
    url,
    close: async () => {
      await handler.destroy();
      server.closeAllConnections();
      await new Promise<void>(r => server.close(() => r()));
    },
  };
}

it.each([
  { final: false, compression: false },
  { final: true, compression: false },
  { final: false, compression: true },
  { final: true, compression: true },
])(
  'preserves bytes and the end callback (final chunk: $final, gzip: $compression)',
  async ({ final, compression }) => {
    let callbackCount = 0;
    const done = () => callbackCount++;
    const f = await fixture(
      (_req, res) => {
        res.setHeader('content-type', 'text/html; charset=iso-8859-1');
        if (final) {
          expect(res.end('é', 'latin1', done)).toBe(res);
        } else {
          res.write('é', 'latin1');
          expect(res.end(done)).toBe(res);
        }
      },
      {},
      { compression }
    );
    try {
      for (const status of ['MISS', 'HIT']) {
        const response = await fetch(f.url + '/encoded', {
          headers: { 'accept-encoding': 'gzip' },
          signal: AbortSignal.timeout(2_000),
        });
        expect(response.headers.get('x-cache-status')).toBe(status);
        expect(response.headers.get('content-encoding')).toBe(compression ? 'gzip' : null);
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(Uint8Array.of(0xe9));
      }
      expect(callbackCount).toBe(1);
    } finally {
      await f.close();
    }
  }
);

it('keeps the first complete response while gzip finishes asynchronously', async () => {
  const f = await fixture(
    (_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end('first body');
      res.end('late body');
    },
    {},
    { compression: true }
  );
  try {
    for (const status of ['MISS', 'HIT']) {
      const response = await fetch(f.url + '/twice', {
        headers: { 'accept-encoding': 'gzip' },
        signal: AbortSignal.timeout(2_000),
      });
      expect(response.headers.get('x-cache-status')).toBe(status);
      expect(await response.text()).toBe('first body');
    }
  } finally {
    await f.close();
  }
});

it('authenticated private responses never enter the shared cache', async () => {
  const f = await fixture((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.setHeader('cache-control', 'private, no-store');
    res.end(req.headers.authorization || 'anonymous');
  });
  try {
    const a = await fetch(f.url + '/account', { headers: { authorization: 'Bearer user-a' } });
    await a.text();
    const b = await fetch(f.url + '/account', { headers: { authorization: 'Bearer user-b' } });
    expect(await b.text()).toBe('Bearer user-b');
    expect(b.headers.get('x-cache-status')).toBe('BYPASS');
  } finally {
    await f.close();
  }
});
it('production query cannot override an SSR route', async () => {
  const f = await fixture(
    (req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(req.headers.cookie || 'none');
    },
    {},
    { routes: { '/account': 'ssr' } }
  );
  try {
    await (await fetch(f.url + '/account?mode=isr')).text();
    const r = await fetch(f.url + '/account?mode=isr');
    await r.text();
    expect(r.headers.get('x-resolved-mode')).toBe('ssr');
    expect(r.headers.get('x-cache-status')).toBe('BYPASS');
  } finally {
    await f.close();
  }
});
it('path invalidation clears GET and HEAD representations', async () => {
  const f = await fixture((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('hello');
  });
  try {
    await (await fetch(f.url + '/page')).text();
    await fetch(f.url + '/page', { method: 'HEAD' });
    expect(f.handler.getCacheInspection().size).toBe(2);
    await revalidatePath('/page');
    expect(f.handler.getCacheInspection().size).toBe(0);
  } finally {
    await f.close();
  }
});

it.each([
  { service: 'i18n', status: 503 },
  { service: 'i18n', status: 200 },
  { service: 'seo', status: 503 },
])(
  'does not cache a render degraded by a $status response from the $service endpoint',
  async ({ service: unavailable, status }) => {
    let recovered = false;
    const upstream = await fixture((req, res) => {
      const service = req.url?.startsWith('/api/i18n/') ? 'i18n' : 'seo';
      res.setHeader('content-type', 'application/json');
      if (service === unavailable && !recovered) {
        res.statusCode = status;
        res.end(JSON.stringify({ strings: {} }));
        return;
      }
      res.end(
        JSON.stringify(
          service === 'i18n' ? { strings: { title: 'live dictionary' } } : { title: 'live SEO' }
        )
      );
    });
    const hooks = applyRuntimeToServerHooks(
      defineAdminSiteHooks({
        i18n: {
          locales: ['en'],
          endpoint: '/api/i18n/{locale}/manifest',
          fallbackLocal: { en: { title: 'snapshot dictionary' } },
        },
        seo: { fallbackLocal: [{ path: '/page', title: 'snapshot SEO' }] },
      }),
      {
        site: undefined,
        services: { api: upstream.url, telemetry: undefined },
        redis: undefined,
        experiments: {},
        i18n: undefined,
        seo: undefined,
        telemetry: false,
      }
    );
    const page = await fixture(async (req, res) => {
      const request = new Request(new URL(req.url!, page.url));
      const [intl, seo] = await Promise.all([hooks.loadIntl(request), hooks.loadSeoMeta(request)]);
      res.setHeader('content-type', 'text/html');
      res.end(`${intl?.messages.title} / ${seo?.title}`);
    });
    try {
      const degraded = await fetch(page.url + '/page');
      expect(degraded.headers.get('x-cache-status')).toBe('MISS');
      expect(await degraded.text()).toContain('snapshot');
      recovered = true;
      const fresh = await fetch(page.url + '/page');
      expect(fresh.headers.get('x-cache-status')).toBe('MISS');
      expect(await fresh.text()).toBe('live dictionary / live SEO');
      const warm = await fetch(page.url + '/page');
      expect(warm.headers.get('x-cache-status')).toBe('HIT');
      expect(await warm.text()).toBe('live dictionary / live SEO');
    } finally {
      await Promise.all([page.close(), upstream.close()]);
    }
  }
);

it.each([
  { status: 503, body: '{}' },
  { status: 200, body: JSON.stringify({ data: null }) },
  { status: 200, body: JSON.stringify({ data: { strings: {} } }) },
  { status: 200, body: JSON.stringify({ strings: ['invalid dictionary'] }) },
  { status: 200, body: JSON.stringify({ strings: { page: { title: ' ', summary: null } } }) },
  { status: 204, body: '' },
  { status: 404, body: '{}' },
])(
  'recovers when the dictionary endpoint initially returns $status $body',
  async ({ status, body }) => {
    let available = false;
    let loads = 0;
    const upstream = await fixture((_req, res) => {
      loads++;
      res.setHeader('content-type', 'application/json');
      res.setHeader('cache-control', 'no-store');
      res.statusCode = available ? 200 : status;
      res.end(available ? JSON.stringify({ strings: { title: 'live dictionary' } }) : body);
    });
    const hooks = applyRuntimeToServerHooks(
      defineAdminSiteHooks({ i18n: { locales: ['en'], endpoint: '/i18n/{locale}' } }),
      {
        site: undefined,
        services: { api: upstream.url, telemetry: undefined },
        redis: undefined,
        experiments: {},
        i18n: undefined,
        seo: undefined,
        telemetry: false,
      }
    );
    const page = await fixture(async (req, res) => {
      const intl = await hooks.loadIntl(new Request(new URL(req.url!, page.url)));
      const title = intl?.messages.title;
      res.setHeader('content-type', 'text/html');
      res.statusCode = typeof title === 'string' ? 200 : 500;
      res.end(typeof title === 'string' ? title : 'Translations unavailable');
    });
    try {
      const missing = await fetch(page.url + '/en');
      expect(missing.status).toBe(500);
      await missing.text();
      available = true;
      const recovered = await fetch(page.url + '/en');
      expect(recovered.status).toBe(200);
      expect(recovered.headers.get('x-cache-status')).toBe('MISS');
      expect(await recovered.text()).toBe('live dictionary');
      const warm = await fetch(page.url + '/en');
      expect(warm.headers.get('x-cache-status')).toBe('HIT');
      await warm.text();
      expect(loads).toBe(2);
    } finally {
      await Promise.all([page.close(), upstream.close()]);
    }
  }
);

it('locale-only publication fences an in-progress render while preserving warm responses', async () => {
  let version = 'before publication';
  let started!: () => void;
  const rendering = new Promise<void>(resolve => {
    started = resolve;
  });
  let finish!: () => void;
  const release = new Promise<void>(resolve => {
    finish = resolve;
  });
  const f = await fixture((req, res) => {
    const body = version;
    res.setHeader('content-type', 'text/html');
    if (req.url === '/page' && body === 'before publication') {
      started();
      void release.then(() => res.end(body));
    } else {
      res.end(body);
    }
  });
  try {
    expect(await (await fetch(f.url + '/warm')).text()).toBe('before publication');
    const inProgress = fetch(f.url + '/page');
    await rendering;
    version = 'after publication';
    await revalidateContent({ locales: ['en'] });
    finish();
    expect(await (await inProgress).text()).toBe('before publication');

    const regenerated = await fetch(f.url + '/page');
    expect(regenerated.headers.get('x-cache-status')).toBe('MISS');
    expect(await regenerated.text()).toBe('after publication');
    const warm = await fetch(f.url + '/warm');
    expect(warm.headers.get('x-cache-status')).toBe('HIT');
    expect(await warm.text()).toBe('before publication');
  } finally {
    finish();
    await f.close();
  }
});

it.each([true, false])('expands logical page paths with prefixDefault=%s', async prefixDefault => {
  let version = 'before publication';
  const f = await fixture(
    (req, res) => {
      res.setHeader('content-type', req.url?.endsWith('_.rsc') ? 'text/x-component' : 'text/html');
      res.end(version);
    },
    {},
    {
      runtime: {
        i18n: {
          locales: ['en', 'ja'],
          defaultLocale: 'en',
          prefixDefault,
          endpoint: undefined,
          fallbackLocal: undefined,
          ttl: 60_000,
          timeoutMs: 1_000,
          remoteSource: 'remote',
          fallbackSource: 'local',
        },
      },
    }
  );
  const affected = ['/ja/work/arcane', '/ja/work/arcane_.rsc'];
  const english = prefixDefault ? '/en/work/arcane' : '/work/arcane';
  const other = [english, english + '_.rsc', '/ja/work/other'];
  async function read(route: string) {
    const response = await fetch(f.url + route);
    return [response.headers.get('x-cache-status'), await response.text()];
  }
  try {
    for (const route of [...affected, ...other]) {
      expect(await read(route)).toEqual(['MISS', version]);
      expect(await read(route)).toEqual(['HIT', version]);
    }
    await expect(
      revalidateContent({ localizedPaths: ['/work/arcane'], locales: ['fr'] })
    ).rejects.toThrow('Unknown publication locale');
    expect(await read(affected[0])).toEqual(['HIT', version]);
    version = 'after publication';
    await revalidateContent({ localizedPaths: ['/work/arcane'], locales: ['JA'] });
    for (const route of affected) expect(await read(route)).toEqual(['MISS', version]);
    for (const route of other) {
      expect(await read(route)).toEqual(['HIT', 'before publication']);
    }
  } finally {
    await f.close();
  }
});
it('path and tag revalidation clear L2 entries after L1 eviction', async () => {
  const db = new Map<string, unknown>();
  const indexed = new Map<string, string[]>();
  const redis = {
    get: async (k: string) => db.get(k),
    set: async (k: string, v: unknown, opts?: CacheSetOptions) => {
      db.set(k, v);
      indexed.set(k, opts?.tags || []);
    },
    delete: async (k: string) => db.delete(k),
    clear: async () => db.clear(),
    destroy: async () => undefined,
    inspect: async () => [],
    invalidateByTag: async (t: string) => {
      for (const [k, tags] of indexed) {
        if (tags.includes(t)) db.delete(k);
      }
      return 1;
    },
  };
  const store = createHybridCacheStore({ max: 1, redis: redis as unknown as ICacheAdapter });
  const f = await fixture(
    (req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end('page');
    },
    { store }
  );
  try {
    await (await fetch(f.url + '/old')).text();
    const old = [...store.keys()][0];
    const e = store.get(old)!;
    store.set(old, { ...e, tags: ['posts'] });
    await (await fetch(f.url + '/other')).text();
    expect(store.get(old)).toBeUndefined();
    await revalidatePath('/old');
    await revalidateTag('posts');
    expect(await store.getAsync!(old)).toBeUndefined();
  } finally {
    await f.close();
  }
});
it('a delayed L2 read cannot resurrect deleted content', async () => {
  let resolve!: (v: unknown) => void;
  const redis = {
    get: () =>
      new Promise(r => {
        resolve = r;
      }),
    delete: async () => true,
    destroy: async () => undefined,
  };
  const store = createHybridCacheStore({ redis: redis as unknown as ICacheAdapter });
  const p = store.getAsync!('key');
  store.delete('key');
  const now = Date.now();
  resolve({
    body: Buffer.from('old').toString('base64'),
    statusCode: 200,
    headers: {},
    contentType: 'text/html',
    storedAt: now,
    expiresAt: now + 60000,
    hardExpiresAt: now + 120000,
    tags: [],
  });
  await p;
  expect(store.get('key')).toBeUndefined();
  await store.destroy();
});

it('private and varying anonymous responses are not cached', async () => {
  for (const header of [{ 'cache-control': 'private, no-store' }, { vary: 'Accept-Language' }]) {
    let count = 0;
    const f = await fixture((req, res) => {
      res.setHeader('content-type', 'text/html');
      for (const [k, v] of Object.entries(header)) res.setHeader(k, v!);
      res.end(String(++count));
    });
    try {
      await (await fetch(f.url + '/page')).text();
      expect(await (await fetch(f.url + '/page')).text()).toBe('2');
    } finally {
      await f.close();
    }
  }
});
it('session cookies bypass public cache reads', async () => {
  const f = await fixture((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(req.headers.cookie || 'public');
  });
  try {
    await (await fetch(f.url + '/page')).text();
    expect(
      await (await fetch(f.url + '/page', { headers: { cookie: 'session=alice' } })).text()
    ).toBe('session=alice');
  } finally {
    await f.close();
  }
});
it('manifest-only experiments enable cache variant isolation', async () => {
  const f = await fixture(
    (req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(req.headers.cookie || 'none');
    },
    {},
    {
      runtime: {
        experimentManifest: {
          endpoint: '/experiments',
          refreshIntervalMs: undefined,
          fallbackOnError: undefined,
          authHeader: undefined,
        },
      },
    }
  );
  try {
    await (await fetch(f.url + '/page', { headers: { cookie: 'ab=a' } })).text();
    expect(await (await fetch(f.url + '/page', { headers: { cookie: 'ab=b' } })).text()).toBe(
      'ab=b'
    );
  } finally {
    await f.close();
  }
});
it('SWR refresh preserves host and experiment cookie while connecting locally', async () => {
  let version = 'old';
  let done!: () => void;
  const refreshed = new Promise<void>(r => {
    done = r;
  });
  const seen: string[] = [];
  const f = await fixture(
    (req, res) => {
      seen.push((req.headers.cookie || 'none') + '|' + req.headers.host);
      res.setHeader('content-type', 'text/html');
      res.end(version);
      if (req.headers['x-isr-background-revalidate']) done();
    },
    { variantIsolation: true, hostIsolation: true },
    { routes: { '/page': { mode: 'isr', ttl: 0.01, staleWhileRevalidate: 60 } } }
  );
  try {
    const h = { cookie: 'ab=a', host: 'tenant.invalid' };
    await rawGet(f.url + '/page', h);
    await new Promise(r => setTimeout(r, 20));
    version = 'new';
    const r = await rawGet(f.url + '/page', h);
    expect(r.headers['x-cache-status']).toBe('STALE');
    await Promise.race([
      refreshed,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('refresh did not return to local origin')), 500)
      ),
    ]);
    expect(seen).toEqual(['ab=a|tenant.invalid', 'ab=a|tenant.invalid']);
    expect(f.handler.getCacheInspection().size).toBe(1);
  } finally {
    await f.close();
  }
});

function rawGet(
  url: string,
  headers: Record<string, string>
): Promise<{ headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, { headers }, res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () =>
          resolve({ headers: res.headers, body: Buffer.concat(chunks).toString() })
        );
      })
      .on('error', reject);
  });
}

it('dynamic route SSR rules never fall back to shared ISR caching', async () => {
  const f = await fixture(
    (_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end('profile');
    },
    {},
    { routes: { '/users/:id': 'ssr' } }
  );
  try {
    for (const path of ['/users/alice', '/users/bob_.rsc']) {
      const r = await fetch(f.url + path);
      await r.text();
      expect(r.headers.get('x-cache-status')).toBe('BYPASS');
    }
  } finally {
    await f.close();
  }
});
it('cached HTML receives a fresh matching CSP nonce on every replay', async () => {
  let count = 0;
  const handler = createIsrCacheHandler({ renderMode: 'isr', revalidate: 60 });
  const server = http.createServer((req, res) => {
    const nonce = 'nonce' + ++count;
    res.setHeader('content-security-policy', `script-src 'nonce-${nonce}'`);
    handler(req, res, () => {
      res.setHeader('content-type', 'text/html');
      res.end(`<script nonce="${nonce}">window.ready=true</script>`);
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/page`;
  try {
    const first = await fetch(url);
    await first.text();
    const next = await fetch(url);
    expect(next.headers.get('x-cache-status')).toBe('HIT');
    expect(next.headers.get('content-security-policy')).toContain('nonce-nonce2');
    expect(await next.text()).toContain('nonce="nonce2"');
  } finally {
    await handler.destroy();
    server.closeAllConnections();
    await new Promise<void>(r => server.close(() => r()));
  }
});

it('separates artifact builds without requiring an APP_VERSION environment variable', async () => {
  const { createMemoryCacheStore } = await import('../plugin/isrCacheStore');
  const store = createMemoryCacheStore();
  const first = await fixture(
    (_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end('build-a');
    },
    { store, ...{ buildId: 'artifact-a' } }
  );
  const second = await fixture(
    (_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end('build-b');
    },
    { store, ...{ buildId: 'artifact-b' } }
  );
  try {
    await (await fetch(first.url + '/page')).text();
    expect(await (await fetch(second.url + '/page')).text()).toBe('build-b');
  } finally {
    await first.close();
    await second.close();
  }
});

it('clearing a handler fences renders that started before the clear', async () => {
  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>(resolve => {
    release = resolve;
  });
  const ready = new Promise<void>(resolve => {
    started = resolve;
  });
  let renders = 0;
  const f = await fixture(async (_req, res) => {
    const count = ++renders;
    if (count === 1) {
      started();
      await pending;
    }
    res.setHeader('content-type', 'text/html');
    res.end(String(count));
  });
  try {
    const first = fetch(f.url + '/page');
    await ready;
    f.handler.clear();
    release();
    await (await first).text();
    expect(await (await fetch(f.url + '/page')).text()).toBe('2');
  } finally {
    release();
    await f.close();
  }
});

it('rejects a nonce-bearing cached representation when its template metadata is missing', async () => {
  const { createMemoryCacheStore } = await import('../plugin/isrCacheStore');
  const store = createMemoryCacheStore();
  let count = 0;
  const handler = createIsrCacheHandler({ renderMode: 'isr', revalidate: 60 }, { store });
  const server = http.createServer((req, res) => {
    const nonce = `nonce${++count}`;
    res.setHeader('content-security-policy', `script-src 'nonce-${nonce}'`);
    handler(req, res, () => {
      res.setHeader('content-type', 'text/html');
      res.end(`<script nonce="${nonce}">window.currentNonce="${nonce}"</script>`);
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/page`;
  try {
    await (await fetch(url)).text();
    const cached = [...store.entries()][0][1];
    delete cached.nonceTemplate;
    const next = await fetch(url);
    const body = await next.text();
    expect(body).toContain('nonce2');
    expect(body).not.toContain('nonce1');
  } finally {
    await handler.destroy();
    server.closeAllConnections();
    await new Promise<void>(r => server.close(() => r()));
  }
});
