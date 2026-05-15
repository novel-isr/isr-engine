/**
 * ICacheAdapter.inspect() 单元测试
 *
 * 验证 inventory 端点的数据源契约：
 *   - MemoryCacheAdapter：返回元数据 + 跳过已过期但未 evict 的 entry + 守 limit
 *   - RedisCacheAdapter：通过 ioredis-mock 验证 SCAN 路径不阻塞 + 守 limit + keyPrefix 边界
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import IoRedisMock from 'ioredis-mock';
import { MemoryCacheAdapter } from '../MemoryCacheAdapter';
import { RedisCacheAdapter } from '../RedisCacheAdapter';

// 强制把 ioredis 替换成 ioredis-mock —— 与同目录其他 Redis 测试保持一致。
// 不加 vi.mock 会让 RedisCacheAdapter 动态 import 真 ioredis 连真 Redis,
// 而且 dynamic import 的模块缓存会污染同一 worker 里其他测试的 mock 状态。
vi.mock('ioredis', () => ({ default: IoRedisMock, __esModule: true }));

describe('MemoryCacheAdapter.inspect()', () => {
  it('返回所有未过期 entry 的元数据', async () => {
    const adapter = new MemoryCacheAdapter({ capacity: 10, defaultTTL: 0, cleanupInterval: 0 });
    await adapter.set('a', 'value-a', { ttl: 60, tags: ['t1'] });
    await adapter.set('b', { complex: 'object' }, { ttl: 120 });

    const items = await adapter.inspect(0);
    expect(items).toHaveLength(2);
    const byKey = Object.fromEntries(items.map(i => [i.key, i]));
    expect(byKey.a.tags).toEqual(['t1']);
    expect(byKey.a.ttlSecondsRemaining).toBeGreaterThan(0);
    expect(byKey.a.ttlSecondsRemaining).toBeLessThanOrEqual(60);
    expect(byKey.a.storedAt).toBeGreaterThan(0);
    expect(byKey.b.tags).toEqual([]);
    expect(byKey.b.sizeBytes).toBeGreaterThan(0);
    await adapter.destroy();
  });

  it('limit 截断（cap=2 时只返 2 条）', async () => {
    const adapter = new MemoryCacheAdapter({ capacity: 100, defaultTTL: 0, cleanupInterval: 0 });
    for (let i = 0; i < 10; i++) await adapter.set(`k${i}`, i);
    const items = await adapter.inspect(2);
    expect(items).toHaveLength(2);
    await adapter.destroy();
  });

  it('已过期 entry 不在 inspect 结果中（惰性跳过）', async () => {
    const adapter = new MemoryCacheAdapter({ capacity: 10, defaultTTL: 0, cleanupInterval: 0 });
    await adapter.set('alive', 1, { ttl: 60 });
    await adapter.set('dead', 2, { ttl: 1 });
    // 等 TTL 过期
    await new Promise(r => setTimeout(r, 1100));
    const items = await adapter.inspect(0);
    const keys = items.map(i => i.key);
    expect(keys).toContain('alive');
    expect(keys).not.toContain('dead');
    await adapter.destroy();
  });

  it('无 TTL 的 entry → ttlSecondsRemaining=undefined', async () => {
    const adapter = new MemoryCacheAdapter({ capacity: 10, defaultTTL: 0, cleanupInterval: 0 });
    await adapter.set('forever', 'x'); // 无 TTL
    const items = await adapter.inspect(0);
    expect(items[0].ttlSecondsRemaining).toBeUndefined();
    await adapter.destroy();
  });
});

describe('RedisCacheAdapter.inspect() —— ioredis-mock', () => {
  // ioredis-mock 默认实例间共享数据 —— 每个测试前清空，避免上一个测试残留 key
  // 污染下一个测试或其他 test file（如 RedisCacheAdapter.e2e.test.ts）。
  beforeEach(async () => {
    const cleaner = new IoRedisMock();
    await cleaner.flushall();
    await cleaner.quit();
  });

  it('SCAN 返回 keyPrefix 内所有 key + STRLEN/TTL 元数据', async () => {
    const adapter = new RedisCacheAdapter({
      host: 'localhost',
      keyPrefix: 'inv-test:',
      enableFallback: false,
    });
    await new Promise(r => setTimeout(r, 200)); // 等连接
    await adapter.set('a', 1, { ttl: 60 });
    await adapter.set('b', 2, { ttl: 120 });
    await adapter.set('c', { nested: 'data' }, { ttl: 30 });

    const items = await adapter.inspect(0);
    const keys = items.map(i => i.key).sort();
    expect(keys).toEqual(['a', 'b', 'c']);
    for (const item of items) {
      expect(item.sizeBytes).toBeGreaterThan(0);
      expect(item.ttlSecondsRemaining).toBeGreaterThan(0);
      expect(item.storedAt).toBeUndefined(); // Redis 不存 storedAt
      expect(item.tags).toEqual([]); // tags 反查代价高，不解
    }
    await adapter.destroy();
  });

  it('limit 截断（cap=2）', async () => {
    const adapter = new RedisCacheAdapter({
      host: 'localhost',
      keyPrefix: 'inv-test-limit:',
      enableFallback: false,
    });
    await new Promise(r => setTimeout(r, 200));
    for (let i = 0; i < 10; i++) {
      await adapter.set(`k${i}`, i, { ttl: 60 });
    }
    const items = await adapter.inspect(2);
    expect(items).toHaveLength(2);
    await adapter.destroy();
  });

  it('keyPrefix 边界 —— 不会扫到其他 prefix 的 key', async () => {
    const a1 = new RedisCacheAdapter({
      host: 'localhost',
      keyPrefix: 'app1:',
      enableFallback: false,
    });
    const a2 = new RedisCacheAdapter({
      host: 'localhost',
      keyPrefix: 'app2:',
      enableFallback: false,
    });
    await new Promise(r => setTimeout(r, 200));
    await a1.set('shared-key-name', 'app1-value', { ttl: 60 });
    await a2.set('shared-key-name', 'app2-value', { ttl: 60 });

    const items1 = await a1.inspect(0);
    expect(items1).toHaveLength(1);
    // ioredis-mock 对 keyPrefix 的 SCAN 行为：返回值已自动剥前缀（与 ioredis 真实行为一致）
    expect(items1[0].key).toBe('shared-key-name');
    await a1.destroy();
    await a2.destroy();
  });
});
