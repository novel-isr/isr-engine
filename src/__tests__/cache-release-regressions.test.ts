import { it, expect } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ISRConfig, RuntimeConfig, RouteRule } from '../types';
import type { ICacheAdapter, CacheSetOptions } from '../cache/ICacheAdapter';
import type { IsrCacheMiddlewareOptions } from '../plugin/isrCacheMiddleware';

import { createIsrCacheHandler } from '../plugin/isrCacheMiddleware';
import { createHybridCacheStore } from '../plugin/isrCacheStore';
import { revalidatePath, revalidateTag } from '../rsc/revalidate';

async function fixture(
  render: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  options: IsrCacheMiddlewareOptions = {},
  config: { routes?: Record<string, RouteRule>; runtime?: Partial<RuntimeConfig> } = {}
) {
  const handler = createIsrCacheHandler(
    { renderMode: 'isr', revalidate: 3600, ...config } as Partial<ISRConfig>,
    options
  );
  const server = http.createServer((req, res) => handler(req, res, () => render(req, res)));
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
