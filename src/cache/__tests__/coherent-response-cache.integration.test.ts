import { randomUUID } from 'node:crypto';
import net from 'node:net';
import http from 'node:http';
import tls from 'node:tls';
import type { AddressInfo } from 'node:net';
import Redis from 'ioredis';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RedisCacheAdapter } from '../RedisCacheAdapter';
import { createCoherentCacheStore } from '../../plugin/coherentCacheStore';
import type { IsrCachedEntry } from '../../plugin/isrCacheStore';
import {
  createIsrCacheHandler,
  type IsrInvalidationBus,
  type IsrInvalidationTarget,
} from '../../plugin/isrCacheMiddleware';
import { cacheTag } from '../../rsc/cacheTag';

const url = process.env.ISR_TEST_REDIS_URL;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

function entry(body = 'old', tags = ['posts']): IsrCachedEntry {
  const now = Date.now();
  return {
    body: Buffer.from(body),
    headers: { 'content-type': 'text/html' },
    contentType: 'text/html',
    statusCode: 200,
    storedAt: now,
    expiresAt: now + 60_000,
    hardExpiresAt: now + 120_000,
    tags,
    pathTag: '__isr_path:/page',
  };
}

describe.skipIf(!url)('coherent response protocol against real Redis', () => {
  let client: Redis;
  let prefix: string;
  let cleanup: Array<() => Promise<void>>;

  beforeEach(async () => {
    prefix = `coherent-integration:${randomUUID()}:`;
    cleanup = [];
    client = new Redis(url!, {
      connectTimeout: 1_000,
      commandTimeout: 1_000,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    client.on('error', () => undefined);
    expect(await client.ping()).toBe('PONG');
  });

  async function namespaceKeys() {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const result = await client.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 100);
      cursor = result[0];
      keys.push(...result[1]);
    } while (cursor !== '0');
    return keys;
  }

  afterEach(async () => {
    try {
      for (const dispose of cleanup.reverse()) await dispose();
      const keys = await namespaceKeys();
      for (const key of keys) await client.del(key);
    } finally {
      client.disconnect();
    }
  });

  function pod(namespace = 'shared', redisUrl = url!) {
    const adapter = new RedisCacheAdapter({
      url: redisUrl,
      keyPrefix: prefix,
      enableFallback: true,
      connectTimeout: 300,
      commandTimeout: 300,
      maxRetries: 0,
    });
    const backend = adapter.createResponseCacheBackend(namespace);
    const store = createCoherentCacheStore({ backend, max: 2 });
    cleanup.push(() => adapter.destroy());
    cleanup.push(() => store.destroy());
    return { adapter, backend, store };
  }

  it('seeds a build snapshot at most once across eviction, restart and invalidation', async () => {
    const first = pod();
    const second = pod();
    const seed = entry('build');
    const lease = await first.store.coherence.beginRender();
    expect(await first.store.coherence.seed!('build:GET:/page', seed, lease)).toBe(true);
    expect((await second.store.getAsync!('build:GET:/page'))?.body.toString()).toBe('build');
    // Simulate remote value eviction without deleting the durable control marker.
    const keys = await namespaceKeys();
    const valueKey = keys.find(key => key.includes(':entry:'))!;
    expect(valueKey).toBeDefined();
    await client.del(valueKey);
    const restarted = pod();
    expect(
      await restarted.store.coherence.seed!(
        'build:GET:/page',
        seed,
        await restarted.store.coherence.beginRender()
      )
    ).toBe(false);
    expect(await restarted.store.getAsync!('build:GET:/page')).toBeUndefined();
    await second.store.invalidateByTag!('posts');
    expect(
      await restarted.store.coherence.seed!(
        'build:GET:/other',
        seed,
        await restarted.store.coherence.beginRender()
      )
    ).toBe(false);
  });

  it('never seeds an evicted runtime generation during the original build window', async () => {
    const first = pod();
    const second = pod();
    const lease = await first.backend.capture();
    const runtime = entry('runtime');
    runtime.staticSeedUntil = Date.now() + 120_000;
    expect(await first.store.coherence.commit('build:GET:/page', runtime, lease)).toBe(true);
    const valueKey = (await namespaceKeys()).find(key => key.includes(':entry:'))!;
    await client.del(valueKey);
    expect(
      await second.store.coherence.seed!(
        'build:GET:/page',
        entry('build'),
        await second.backend.capture()
      )
    ).toBe(false);
  });

  it('disables immutable seeding after clear and metadata repair', async () => {
    const first = pod();
    await first.backend.clear();
    expect(
      await first.store.coherence.seed!(
        'build:GET:/page',
        entry('build'),
        await first.store.coherence.beginRender()
      )
    ).toBe(false);
    const second = pod('repair');
    await second.backend.capture();
    for (const key of await namespaceKeys()) {
      if (key.endsWith(':invalidated') || key.endsWith(':expiry')) await client.del(key);
    }
    expect(
      await second.store.coherence.seed!(
        'build:GET:/page',
        entry('build'),
        await second.store.coherence.beginRender()
      )
    ).toBe(false);
  });

  it('rejects a pre-invalidation render from another pod without Pub/Sub', async () => {
    const first = pod();
    const second = pod();
    const lease = await first.store.coherence.beginRender();
    await second.store.invalidateByTag!('posts');
    expect(await first.store.coherence.commit('GET:/page', entry(), lease)).toBe(false);
    expect(await first.store.getAsync!('GET:/page')).toBeUndefined();
    expect(await second.store.getAsync!('GET:/page')).toBeUndefined();
    const freshLease = await first.store.coherence.beginRender();
    expect(await first.store.coherence.commit('GET:/page', entry('new'), freshLease)).toBe(true);
    expect((await second.store.getAsync!('GET:/page'))?.body.toString()).toBe('new');
  });

  it('never leaves readable stale content when commit races tag invalidation', async () => {
    const first = pod();
    const second = pod();
    for (let i = 0; i < 20; i++) {
      const lease = await first.backend.capture();
      const key = `race:${i}`;
      await Promise.all([
        first.backend.commit(key, { body: 'old' }, lease, ['posts'], 60_000),
        second.backend.invalidateTag('posts'),
      ]);
      expect((await first.backend.read(key)).value).toBeUndefined();
      expect((await second.backend.read(key)).value).toBeUndefined();
    }
  });

  it('does not invalidate a replacement that no longer carries the old tag', async () => {
    const first = pod();
    const second = pod();
    await first.backend.commit(
      'key',
      { body: 'old' },
      await first.backend.capture(),
      ['posts'],
      60_000
    );
    await second.backend.commit(
      'key',
      { body: 'new' },
      await second.backend.capture(),
      ['other'],
      60_000
    );
    await first.backend.invalidateTag('posts');
    expect((await second.backend.read('key')).value).toEqual({ body: 'new' });
  });

  it('revalidates cached snapshots after same-revision replacement and removal', async () => {
    const first = pod();
    const second = pod();
    const lease = await first.backend.capture();
    await first.backend.commit('key', { body: 'old' }, lease, ['posts'], 60_000);
    const cached = await second.backend.read('key');
    await first.backend.commit('key', { body: 'new' }, lease, ['posts'], 60_000);
    expect((await second.backend.read('key', cached)).value).toEqual({ body: 'new' });
    await first.backend.remove('key');
    expect((await second.backend.read('key', cached)).value).toBeUndefined();
  });

  it('does not serve a cached snapshot after its Redis entry TTL expires', async () => {
    const first = pod();
    const lease = await first.backend.capture();
    await first.backend.commit('key', { body: 'old' }, lease, ['posts'], 20);
    const cached = await first.backend.read('key');
    expect(cached.value).toEqual({ body: 'old' });
    await new Promise(resolve => setTimeout(resolve, 40));
    expect((await first.backend.read('key', cached)).value).toBeUndefined();
  });

  it('validates a warm L1 against durable remote tag invalidation', async () => {
    const first = pod();
    const second = pod();
    const lease = await first.store.coherence.beginRender();
    await first.store.coherence.commit('GET:/page', entry(), lease);
    expect((await second.store.getAsync!('GET:/page'))?.body.toString()).toBe('old');
    expect(second.store.get('GET:/page')).toBeUndefined();
    await first.store.invalidateByTag!('posts');
    expect(await second.store.getAsync!('GET:/page')).toBeUndefined();
  });

  it('does not resurrect a late read-through response after remote invalidation', async () => {
    const first = pod();
    const second = pod();
    const lease = await first.store.coherence.beginRender();
    await first.store.coherence.commit('GET:/page', entry(), lease);
    const fetched = deferred<void>();
    const release = deferred<void>();
    const read = second.backend.read.bind(second.backend);
    let delay = true;
    second.backend.read = async (...args) => {
      const result = await read(...args);
      if (delay) {
        delay = false;
        fetched.resolve();
        await release.promise;
      }
      return result;
    };
    const oldRead = second.store.getAsync!('GET:/page');
    await fetched.promise;
    await first.store.invalidateByTag!('posts');
    release.resolve();
    await oldRead;
    expect(await second.store.getAsync!('GET:/page')).toBeUndefined();
  });

  it('invalidates path tags across HTML, Flight, query and HEAD keys', async () => {
    const first = pod();
    const second = pod();
    const keys = ['GET:/page', 'GET:/page_.rsc', 'GET:/page?sort=new', 'HEAD:/page'];
    for (const key of keys) {
      const lease = await first.store.coherence.beginRender();
      expect(await first.store.coherence.commit(key, entry(), lease)).toBe(true);
    }
    await second.store.invalidateByTag!('__isr_path:/page');
    for (const key of keys) expect(await first.store.getAsync!(key)).toBeUndefined();
  });

  it('preserves unrelated entries and entries in a different namespace', async () => {
    const first = pod();
    const second = pod('other');
    for (const current of [first, second]) {
      await current.store.coherence.commit(
        'GET:/page',
        entry(),
        await current.store.coherence.beginRender()
      );
      await current.store.coherence.commit(
        'GET:/unrelated',
        { ...entry('unrelated', ['other']), pathTag: '__isr_path:/unrelated' },
        await current.store.coherence.beginRender()
      );
    }
    await first.store.invalidateByTag!('posts');
    expect(await first.store.getAsync!('GET:/page')).toBeUndefined();
    expect((await first.store.getAsync!('GET:/unrelated'))?.body.toString()).toBe('unrelated');
    expect((await second.store.getAsync!('GET:/page'))?.body.toString()).toBe('old');
  });

  it('evicts only L1 when processing a broadcast hint', async () => {
    const first = pod();
    const second = pod();
    await first.store.coherence.commit(
      'GET:/page',
      entry(),
      await first.store.coherence.beginRender()
    );
    await second.store.getAsync!('GET:/page');
    second.store.evictByTag!('posts');
    expect((await first.store.getAsync!('GET:/page'))?.body.toString()).toBe('old');
    expect((await second.store.getAsync!('GET:/page'))?.body.toString()).toBe('old');
  });

  it('rejects old leases after only this test namespace is erased and recreated', async () => {
    const first = pod();
    const lease = await first.backend.capture();
    const keys = await namespaceKeys();
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) await client.del(key);
    const second = pod();
    const replacement = await second.backend.capture();
    expect(replacement.incarnation).not.toBe(lease.incarnation);
    expect(await first.backend.commit('GET:/page', { body: 'old' }, lease, ['posts'], 60_000)).toBe(
      false
    );
    expect((await second.backend.read('GET:/page')).value).toBeUndefined();
  });

  it.each(['invalidated', 'expiry'] as const)(
    'fails closed when only the %s metadata key is evicted',
    async metadataKind => {
      const first = pod();
      const second = pod();
      const oldLease = await first.backend.capture();
      expect(await first.backend.commit('key', { body: 'old' }, oldLease, ['posts'], 60_000)).toBe(
        true
      );
      await second.backend.invalidateTag('posts');
      const postInvalidation = await second.backend.capture();
      // Do not read the entry before eviction: READ would delete the old entry
      // and mask resurrection after losing only the invalidation metadata.
      const keys = await namespaceKeys();
      const metadata = keys.find(key => key.endsWith(`:${metadataKind}`));
      expect(metadata).toBeDefined();
      expect(await client.del(metadata!)).toBe(1);
      expect((await first.backend.read('key')).value).toBeUndefined();
      const recovered = await first.backend.capture();
      expect(recovered.incarnation).not.toBe(postInvalidation.incarnation);
      expect(await first.backend.commit('late', { body: 'old' }, oldLease, ['posts'], 60_000)).toBe(
        false
      );
      expect(
        await first.backend.commit('late', { body: 'old' }, postInvalidation, ['posts'], 60_000)
      ).toBe(false);
      expect(
        await first.backend.commit('fresh', { body: 'new' }, recovered, ['posts'], 60_000)
      ).toBe(true);
      await second.backend.invalidateTag('posts');
      expect((await first.backend.read('fresh')).value).toBeUndefined();
    }
  );

  it('limits inventory to its own namespace and keeps same-name replacements isolated', async () => {
    const first = pod('inventory-first');
    const second = pod('inventory-second');
    await first.backend.commit(
      'same',
      { body: 'first' },
      await first.backend.capture(),
      [],
      60_000
    );
    await second.backend.commit(
      'same',
      { body: 'second' },
      await second.backend.capture(),
      [],
      60_000
    );
    await second.backend.commit(
      'secret',
      { body: 'private inventory' },
      await second.backend.capture(),
      [],
      60_000
    );
    expect((await first.backend.inspect!(100)).map(item => item.key)).toEqual(['same']);
    expect((await second.backend.inspect!(100)).map(item => item.key).sort()).toEqual([
      'same',
      'secret',
    ]);
    await first.backend.commit(
      'same',
      { body: 'replacement' },
      await first.backend.capture(),
      [],
      60_000
    );
    expect((await first.backend.read('same')).value).toEqual({ body: 'replacement' });
    expect((await second.backend.read('same')).value).toEqual({ body: 'second' });
    expect(await first.backend.inspect!(100)).toHaveLength(1);
    await first.backend.commit(
      'another',
      { body: 'another' },
      await first.backend.capture(),
      [],
      60_000
    );
    expect(await first.backend.inspect!(1)).toHaveLength(1);
  });

  it('treats response-v1 as an eviction hint and bridges legacy broadcasts to durable invalidation', async () => {
    const first = pod();
    const second = pod();
    let receive!: (target: IsrInvalidationTarget) => Promise<void> | void;
    const bus: IsrInvalidationBus = {
      publish: async () => undefined,
      subscribe: listener => {
        receive = listener;
        return () => undefined;
      },
    };
    const handler = createIsrCacheHandler({}, { store: second.store, invalidationBus: bus });
    cleanup.push(() => handler.destroy());
    await first.store.coherence.commit(
      'GET:/page',
      entry(),
      await first.store.coherence.beginRender()
    );
    expect((await second.store.getAsync!('GET:/page'))?.body.toString()).toBe('old');
    expect(second.store.size).toBe(1);
    await first.store.invalidateByTag!('posts');
    const postInvalidation = await first.backend.capture();
    await receive({ kind: 'tag', value: 'posts', protocol: 'response-v1' });
    expect(second.store.size).toBe(0);
    expect(await second.backend.capture()).toEqual(postInvalidation);
    expect(await second.store.coherence.commit('GET:/page', entry('new'), postInvalidation)).toBe(
      true
    );
    expect((await first.store.getAsync!('GET:/page'))?.body.toString()).toBe('new');
    await receive({ kind: 'tag', value: 'posts' });
    const afterLegacy = await second.backend.capture();
    expect(afterLegacy.incarnation).toBe(postInvalidation.incarnation);
    expect(BigInt(afterLegacy.revision)).toBe(BigInt(postInvalidation.revision) + 1n);
    expect(await first.store.getAsync!('GET:/page')).toBeUndefined();
    expect(await first.store.coherence.commit('GET:/late', entry('old'), postInvalidation)).toBe(
      false
    );
  });

  it('clear fences pre-clear renders and invalidates other pod warm entries', async () => {
    const first = pod();
    const second = pod();
    const lease = await first.store.coherence.beginRender();
    await first.store.coherence.commit('GET:/page', entry(), lease);
    await second.store.getAsync!('GET:/page');
    await second.backend.clear();
    expect(await first.store.coherence.commit('GET:/late', entry(), lease)).toBe(false);
    expect(await first.store.getAsync!('GET:/page')).toBeUndefined();
    expect(await second.store.getAsync!('GET:/page')).toBeUndefined();
  });

  async function httpPod(
    current: ReturnType<typeof pod>,
    render: (req: http.IncomingMessage, res: http.ServerResponse) => void
  ) {
    const handler = createIsrCacheHandler(
      { renderMode: 'isr', revalidate: 60 },
      { store: current.store }
    );
    const server = http.createServer((req, res) => handler(req, res, () => render(req, res)));
    cleanup.push(() => handler.destroy());
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    cleanup.push(async () => {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    });
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('fences a real HTTP render admitted before another handler invalidates without a bus', async () => {
    const first = pod();
    const second = pod();
    const started = deferred<void>();
    const release = deferred<void>();
    const committed = deferred<boolean>();
    const commit = first.backend.commit.bind(first.backend);
    first.backend.commit = async (...args) => {
      const stored = await commit(...args);
      committed.resolve(stored);
      return stored;
    };
    const firstUrl = await httpPod(first, (_req, res) => {
      cacheTag('posts');
      started.resolve();
      void release.promise.then(() => {
        res.setHeader('content-type', 'text/html');
        res.end('old');
      });
    });
    const secondUrl = await httpPod(second, (_req, res) => {
      cacheTag('posts');
      res.setHeader('content-type', 'text/html');
      res.end('new');
    });
    const rendering = fetch(firstUrl + '/page');
    await started.promise;
    try {
      await second.store.invalidateByTag!('posts');
    } finally {
      release.resolve();
    }
    const response = await rendering;
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('old');
    expect(await committed.promise).toBe(false);
    const key = response.headers.get('x-cache-key')!;
    expect(await second.store.getAsync!(key)).toBeUndefined();
    expect(await (await fetch(secondUrl + '/page')).text()).toBe('new');
    const next = await fetch(secondUrl + '/page');
    expect(await next.text()).toBe('new');
    expect(next.headers.get('x-cache-status')).toBe('HIT');
  });

  it('keeps HTTP origin available without caching when render admission is disconnected', async () => {
    const first = await interruptiblePod();
    await first.backend.capture();
    await first.disconnect();
    let renders = 0;
    const base = await httpPod(first, (_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(`uncached:${++renders}`);
    });
    for (let i = 1; i <= 2; i++) {
      const response = await fetch(base + '/page');
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(`uncached:${i}`);
      expect(response.headers.get('x-cache-status')).toBe('BYPASS');
    }
    expect(first.store.size).toBe(0);
  });

  async function interruptiblePod() {
    const upstream = new URL(url!);
    const sockets = new Set<net.Socket>();
    const proxy = net.createServer(socket => {
      const remote =
        upstream.protocol === 'rediss:'
          ? tls.connect({
              host: upstream.hostname,
              port: Number(upstream.port || 6379),
              servername: upstream.hostname,
            })
          : net.createConnection({ host: upstream.hostname, port: Number(upstream.port || 6379) });
      for (const connection of [socket, remote]) {
        sockets.add(connection);
        connection.on('close', () => sockets.delete(connection));
        connection.on('error', () => {
          socket.destroy();
          remote.destroy();
        });
      }
      socket.pipe(remote).pipe(socket);
    });
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
    cleanup.push(async () => {
      for (const socket of sockets) socket.destroy();
      if (proxy.listening) await new Promise<void>(resolve => proxy.close(() => resolve()));
    });
    const local = new URL(url!);
    local.protocol = 'redis:';
    local.hostname = '127.0.0.1';
    local.port = String((proxy.address() as AddressInfo).port);
    const first = pod('interrupted', local.href);
    return {
      ...first,
      async disconnect() {
        for (const socket of sockets) socket.destroy();
        if (proxy.listening) await new Promise<void>(resolve => proxy.close(() => resolve()));
      },
    };
  }

  it('rejects durable operations on an interrupted connection even with fallback enabled', async () => {
    const first = await interruptiblePod();
    const lease = await first.backend.capture();
    await first.backend.commit('key', { body: 'old' }, lease, ['posts'], 60_000);
    await first.disconnect();
    await expect(first.backend.invalidateTag('posts')).rejects.toThrow();
    await expect(first.backend.capture()).rejects.toThrow();
    await expect(
      first.backend.commit('late', { body: 'old' }, lease, ['posts'], 60_000)
    ).rejects.toThrow();
    await expect(first.backend.read('key')).rejects.toThrow();
    await expect(first.backend.clear()).rejects.toThrow();
  });
});
