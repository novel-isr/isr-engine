/**
 * isrCacheStore 单元测试
 *
 * 覆盖：
 *   - MemoryCacheStore：sync get/set/delete/clear/entries/keys
 *   - HybridCacheStore：L1 sync 不变；L2 写穿 + L1 miss 时 read-through
 *   - L2 写失败不影响 L1 + 不抛错
 *   - destroy 关闭 L2
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createMemoryCacheStore,
  createHybridCacheStore,
  type IsrCachedEntry,
} from '../isrCacheStore';
import type { ICacheAdapter } from '../../cache/ICacheAdapter';

function entry(body = 'x', tags: string[] = []): IsrCachedEntry {
  const now = Date.now();
  return {
    body: Buffer.from(body),
    statusCode: 200,
    headers: { 'content-type': 'text/html' },
    contentType: 'text/html',
    storedAt: now,
    expiresAt: now + 1000,
    hardExpiresAt: now + 5000,
    tags,
  };
}

function fakeRedis(): ICacheAdapter & { _store: Map<string, unknown> } {
  const _store = new Map<string, unknown>();
  const adapter = {
    _store,
    name: 'fake-redis',
    get: vi.fn(async (k: string) => _store.get(k)),
    set: vi.fn(async (k: string, v: unknown) => {
      _store.set(k, v);
    }),
    has: vi.fn(async (k: string) => _store.has(k)),
    delete: vi.fn(async (k: string) => _store.delete(k)),
    clear: vi.fn(async () => {
      _store.clear();
    }),
    getMany: vi.fn(async () => new Map()),
    setMany: vi.fn(async () => undefined),
    invalidateByTag: vi.fn(async () => 0),
    isConnected: vi.fn(() => true),
    destroy: vi.fn(async () => undefined),
  };
  return adapter as unknown as ICacheAdapter & { _store: Map<string, unknown> };
}

describe('createMemoryCacheStore', () => {
  it('sync get/set/delete/clear/size', () => {
    const s = createMemoryCacheStore({ max: 5 });
    expect(s.backend).toBe('memory');
    expect(s.get('a')).toBeUndefined();

    s.set('a', entry('A'));
    s.set('b', entry('B'));
    expect(s.size).toBe(2);
    expect(s.get('a')?.body.toString()).toBe('A');

    expect(s.delete('a')).toBe(true);
    expect(s.delete('a')).toBe(false);
    expect(s.size).toBe(1);

    s.clear();
    expect(s.size).toBe(0);
  });

  it('entries / keys 可遍历', () => {
    const s = createMemoryCacheStore();
    s.set('k1', entry('v1', ['t1']));
    s.set('k2', entry('v2', ['t2']));
    expect(Array.from(s.keys()).sort()).toEqual(['k1', 'k2']);
    const ents = Array.from(s.entries());
    expect(ents.map(e => e[0]).sort()).toEqual(['k1', 'k2']);
  });

  it('LRU 容量上限生效', () => {
    const s = createMemoryCacheStore({ max: 2 });
    s.set('a', entry('A'));
    s.set('b', entry('B'));
    s.set('c', entry('C'));
    expect(s.size).toBeLessThanOrEqual(2);
    expect(s.get('a')).toBeUndefined();
  });
});

describe('createHybridCacheStore', () => {
  let redis: ReturnType<typeof fakeRedis>;
  beforeEach(() => {
    redis = fakeRedis();
  });

  it('backend 标识为 hybrid', () => {
    const s = createHybridCacheStore({ redis });
    expect(s.backend).toBe('hybrid');
  });

  it('set 同步入 L1，异步写穿 L2（base64 编码 body）', async () => {
    const s = createHybridCacheStore({ redis, redisKeyPrefix: 'p:' });
    s.set('k', entry('hello'));
    expect(s.get('k')?.body.toString()).toBe('hello'); // L1 同步
    await new Promise(r => setImmediate(r)); // 等异步写穿
    expect(redis.set).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledWith(
      'p:k',
      expect.objectContaining({
        body: Buffer.from('hello').toString('base64'),
        statusCode: 200,
      }),
      expect.any(Object)
    );
  });

  it('getAsync 在 L1 miss 时回源 L2，并回填 L1', async () => {
    const s = createHybridCacheStore({ redis });
    redis._store.set('isr:resp:k', {
      body: Buffer.from('from-l2').toString('base64'),
      statusCode: 200,
      headers: { 'content-type': 'text/html' },
      contentType: 'text/html',
      storedAt: Date.now(),
      expiresAt: Date.now() + 1_000,
      hardExpiresAt: Date.now() + 5_000,
      tags: ['books'],
    });

    expect(s.get('k')).toBeUndefined();
    const restored = await s.getAsync?.('k');
    expect(restored?.body.toString()).toBe('from-l2');
    expect(s.get('k')?.body.toString()).toBe('from-l2');
    expect(redis.get).toHaveBeenCalledWith('isr:resp:k');
  });

  it('delete 同步删 L1 + 异步删 L2', async () => {
    const s = createHybridCacheStore({ redis });
    s.set('k', entry());
    s.delete('k');
    expect(s.get('k')).toBeUndefined(); // L1 同步
    await new Promise(r => setImmediate(r));
    expect(redis.delete).toHaveBeenCalledWith('isr:resp:k');
  });

  it('clear 同步清 L1 + 异步清 L2', async () => {
    const s = createHybridCacheStore({ redis });
    s.set('a', entry());
    s.clear();
    expect(s.size).toBe(0);
    await new Promise(r => setImmediate(r));
    expect(redis.clear).toHaveBeenCalled();
  });

  it('Redis 写失败不抛错，触发 onRedisError', async () => {
    redis.set = vi.fn(async () => {
      throw new Error('redis down');
    });
    const onErr = vi.fn();
    const s = createHybridCacheStore({ redis, onRedisError: onErr });
    expect(() => s.set('k', entry())).not.toThrow();
    await new Promise(r => setImmediate(r));
    expect(onErr).toHaveBeenCalledWith(expect.any(Error), 'set', 'k');
    // L1 仍然有值
    expect(s.get('k')).toBeDefined();
  });

  it('destroy 关闭 L2 适配器', async () => {
    const s = createHybridCacheStore({ redis });
    s.set('k', entry());
    await s.destroy();
    expect(s.size).toBe(0);
    expect(redis.destroy).toHaveBeenCalled();
  });
});
