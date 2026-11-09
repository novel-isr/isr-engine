import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RedisCacheAdapter } from '../RedisCacheAdapter';
import { RedisInvalidationBus } from '../RedisInvalidationBus';
import { createHybridCacheStore, type IsrCachedEntry } from '../../plugin/isrCacheStore';
import { createIsrCacheHandler } from '../../plugin/isrCacheMiddleware';
import { revalidatePath, revalidateTag } from '../../rsc/revalidate';

const url = process.env.ISR_TEST_REDIS_URL;
const responsePrefix = 'response:';

describe.skipIf(!url)('durable invalidation against real Redis', () => {
  let client: Redis;
  let prefix: string;
  let cleanup: Array<() => Promise<void>>;

  beforeEach(async () => {
    prefix = `isr-integration:${randomUUID()}:`;
    cleanup = [];
    client = new Redis(url!, {
      connectTimeout: 2_000,
      commandTimeout: 2_000,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    // An explicitly configured integration service must fail loudly when unavailable.
    client.on('error', () => {});
    expect(await client.ping()).toBe('PONG');
  });

  afterEach(async () => {
    for (const dispose of cleanup.reverse()) await dispose();
    try {
      let cursor = '0';
      do {
        const [next, keys] = await client.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 100);
        cursor = next;
        if (keys.length) await client.del(...keys);
      } while (cursor !== '0');
    } finally {
      client.disconnect();
    }
  });

  function pod(bus?: RedisInvalidationBus) {
    const adapter = new RedisCacheAdapter({
      url,
      keyPrefix: prefix,
      enableFallback: false,
      connectTimeout: 2_000,
      commandTimeout: 2_000,
      maxRetries: 0,
    });
    const store = createHybridCacheStore({
      max: 1,
      redis: adapter,
      redisKeyPrefix: responsePrefix,
    });
    const handler = createIsrCacheHandler({}, { store, invalidationBus: bus });
    cleanup.push(() => handler.destroy());
    return { adapter, store, handler };
  }

  function entry(pathname: string, tags = ['posts']): IsrCachedEntry {
    const now = Date.now();
    return {
      body: Buffer.from('old content'),
      statusCode: 200,
      headers: { 'content-type': 'text/html' },
      contentType: 'text/html',
      storedAt: now,
      expiresAt: now + 60_000,
      hardExpiresAt: now + 120_000,
      tags,
      pathTag: `__isr_path:${pathname}`,
    };
  }

  async function persist(
    store: ReturnType<typeof createHybridCacheStore>,
    key: string,
    value: IsrCachedEntry
  ) {
    store.set(key, value);
    // getAsync waits for the actual asynchronous write-through queue.
    expect((await store.getAsync?.(key))?.body.toString()).toBe('old content');
    expect(await client.exists(`${prefix}${responsePrefix}${key}`)).toBe(1);
  }

  it('revalidatePath removes evicted HTML, RSC and HEAD representations from L2', async () => {
    const { adapter, store, handler } = pod();
    const server = http.createServer((req, res) =>
      handler(req, res, () => {
        res.setHeader(
          'content-type',
          req.url?.includes('_.rsc') ? 'text/x-component' : 'text/html'
        );
        res.end('old content');
      })
    );
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve()))
      );
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    async function render(pathname: string, method = 'GET') {
      const response = await fetch(base + pathname, { method });
      await response.text();
      expect(response.status).toBe(200);
      const key = [...store.keys()][0];
      expect(key).toBeDefined();
      await store.getAsync?.(key);
      expect(await client.exists(`${prefix}${responsePrefix}${key}`)).toBe(1);
      return key;
    }
    const keys = [
      await render('/old?sort=new'),
      await render('/old_.rsc'),
      await render('/old', 'HEAD'),
    ];
    const other = await render('/other');
    for (const key of keys) expect(store.get(key)).toBeUndefined();

    await revalidatePath('/old');

    for (const key of keys) {
      expect(await client.exists(`${prefix}${responsePrefix}${key}`)).toBe(0);
      expect(await adapter.get(`${responsePrefix}${key}`)).toBeUndefined();
      expect(await store.getAsync?.(key)).toBeUndefined();
    }
    expect(await adapter.has(`${responsePrefix}${other}`)).toBe(true);
  });

  it('revalidateTag independently removes tagged entries after L1 eviction', async () => {
    const { adapter, store } = pod();
    await persist(store, 'GET:/tagged', entry('/tagged', ['posts']));
    await persist(store, 'GET:/other', entry('/other', ['other']));
    expect(store.get('GET:/tagged')).toBeUndefined();
    expect(await client.smembers(`${prefix}__tag:posts`)).toContain(
      `${prefix}${responsePrefix}GET:/tagged`
    );

    await revalidateTag('posts');

    expect(await client.exists(`${prefix}${responsePrefix}GET:/tagged`)).toBe(0);
    expect(await adapter.get(`${responsePrefix}GET:/tagged`)).toBeUndefined();
    expect(await store.getAsync?.('GET:/tagged')).toBeUndefined();
    expect(await adapter.has(`${responsePrefix}GET:/other`)).toBe(true);
  });

  it('Redis broadcast clears the other pod L1 without a process-local revalidation call', async () => {
    const channel = `${prefix}invalidate`;
    const firstBus = new RedisInvalidationBus({ url, channel });
    const secondBus = new RedisInvalidationBus({ url, channel });
    const first = pod(firstBus);
    const second = pod(secondBus);
    await vi.waitFor(
      async () => {
        expect(await client.pubsub('NUMSUB', channel)).toEqual([channel, 2]);
      },
      { timeout: 3_000 }
    );
    await persist(first.store, 'GET:/shared', entry('/shared'));
    expect((await second.store.getAsync?.('GET:/shared'))?.body.toString()).toBe('old content');
    expect(second.store.get('GET:/shared')).toBeDefined();

    // Publishing directly avoids the global invalidator registry clearing both
    // in-process pods and accidentally masking a broken Redis subscription.
    await firstBus.publish({ kind: 'tag', value: 'posts' });

    await vi.waitFor(() => expect(second.store.get('GET:/shared')).toBeUndefined(), {
      timeout: 3_000,
    });
    expect(first.store.get('GET:/shared')).toBeDefined();
    await vi.waitFor(
      async () => expect(await client.exists(`${prefix}${responsePrefix}GET:/shared`)).toBe(0),
      { timeout: 3_000 }
    );
    expect(await second.store.getAsync?.('GET:/shared')).toBeUndefined();
  });
});
