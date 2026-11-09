import net from 'node:net';
import tls from 'node:tls';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RedisCacheAdapter } from '../RedisCacheAdapter';

const url = process.env.ISR_TEST_REDIS_URL;
function bounded<T>(task: Promise<T>, milliseconds = 1000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    task,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('operation exceeded lifecycle deadline')),
        milliseconds
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

describe.skipIf(!url)('Redis adapter connection recovery against real Redis', () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const dispose of cleanup.splice(0).reverse()) await dispose();
  });

  async function proxy(mode: 'reject' | 'blackhole' | 'forward') {
    const upstream = new URL(url!);
    const sockets = new Set<net.Socket>();
    let current = mode;
    let connections = 0;
    const server = net.createServer(socket => {
      connections++;
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => undefined);
      if (current === 'reject') {
        socket.destroy();
        return;
      }
      if (current === 'blackhole') return;
      const remote =
        upstream.protocol === 'rediss:'
          ? tls.connect({
              host: upstream.hostname,
              port: Number(upstream.port || 6379),
              servername: upstream.hostname,
            })
          : net.createConnection({ host: upstream.hostname, port: Number(upstream.port || 6379) });
      sockets.add(remote);
      remote.on('close', () => sockets.delete(remote));
      remote.on('error', () => {
        socket.destroy();
        remote.destroy();
      });
      socket.pipe(remote).pipe(socket);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    cleanup.push(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    });
    const local = new URL(url!);
    local.protocol = 'redis:';
    local.hostname = '127.0.0.1';
    local.port = String((server.address() as AddressInfo).port);
    return {
      url: local.href,
      get connections() {
        return connections;
      },
      recover() {
        current = 'forward';
        for (const socket of sockets) socket.destroy();
      },
    };
  }
  function adapter(redisUrl: string, connectTimeout = 80) {
    const instance = new RedisCacheAdapter({
      url: redisUrl,
      keyPrefix: `connection:${randomUUID()}:`,
      maxRetries: 0,
      retryDelay: 20,
      commandTimeout: 80,
      connectTimeout,
      enableFallback: true,
    });
    cleanup.push(() => instance.destroy());
    return instance;
  }

  it('recovers coherent and generic operations after initial failure beyond the per-request retry budget', async () => {
    const transport = await proxy('reject');
    const instance = adapter(transport.url);
    const backend = instance.createResponseCacheBackend('recovery');
    await expect(bounded(backend.capture())).rejects.toThrow();
    await bounded(instance.set('offline', 'local'));
    expect(await instance.get('offline')).toBe('local');
    transport.recover();
    await vi.waitFor(() => expect(instance.isConnected()).toBe(true), {
      timeout: 2000,
      interval: 20,
    });
    const lease = await bounded(backend.capture());
    expect(await backend.commit('key', { body: 'recovered' }, lease, [], 1000)).toBe(true);
    expect((await backend.read('key')).value).toEqual({ body: 'recovered' });
    await instance.set('online', 'remote', { ttl: 1 });
    expect(await instance.get('online')).toBe('remote');
    await backend.remove('key');
    await instance.delete('online');
  });

  it('bounds startup on a TCP connection that never becomes Redis-ready', async () => {
    const transport = await proxy('blackhole');
    const instance = adapter(transport.url);
    const backend = instance.createResponseCacheBackend('startup-deadline');
    await vi.waitFor(() => expect(transport.connections).toBeGreaterThan(0), {
      timeout: 1000,
      interval: 10,
    });
    expect(instance.isConnected()).toBe(false);
    await expect(bounded(backend.capture(), 500)).rejects.toThrow();
  });

  it('settles startup wait and stops reconnecting when destroyed before ready', async () => {
    const transport = await proxy('blackhole');
    const instance = adapter(transport.url, 10_000);
    const backend = instance.createResponseCacheBackend('shutdown');
    const capture = backend.capture();
    const rejected = expect(bounded(capture, 500)).rejects.toThrow();
    await vi.waitFor(() => expect(transport.connections).toBeGreaterThan(0), {
      timeout: 1000,
      interval: 10,
    });
    await bounded(instance.destroy(), 500);
    await rejected;
    const attempts = transport.connections;
    transport.recover();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(transport.connections).toBe(attempts);
    expect(instance.isConnected()).toBe(false);
  });
  it('does not create a Redis client when destroyed during module loading', async () => {
    type Loader = {
      loadRedisModule(): Promise<(new (...args: unknown[]) => import('ioredis').default) | null>;
    };
    const prototype = RedisCacheAdapter.prototype as unknown as Loader;
    const original = prototype.loadRedisModule;
    let release!: () => void;
    let loaded!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const finished = new Promise<void>(resolve => {
      loaded = resolve;
    });
    let constructors = 0;
    const spy = vi.spyOn(prototype, 'loadRedisModule').mockImplementationOnce(async () => {
      await gate;
      const Redis = await original.call(prototype);
      loaded();
      return (
        Redis &&
        new Proxy(Redis, {
          construct(target, args) {
            constructors++;
            return Reflect.construct(target, args);
          },
        })
      );
    });
    const instance = adapter(url!, 10_000);
    const backend = instance.createResponseCacheBackend('late-loader');
    const capture = expect(bounded(backend.capture(), 500)).rejects.toThrow();
    try {
      await bounded(instance.destroy(), 500);
      await capture;
    } finally {
      release();
      await finished;
      await new Promise(resolve => setImmediate(resolve));
      spy.mockRestore();
    }
    expect(constructors).toBe(0);
  });
});
