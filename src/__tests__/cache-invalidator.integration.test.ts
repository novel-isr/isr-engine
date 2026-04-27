/**
 * Cache + Invalidator integration —— 验证 IsrCacheStore 与 revalidate 注册表的协作契约
 *
 * **范围说明**（v2.1 起准确命名）：
 *   本文件 *不* 启动 ISREngine / Express server / RSC handler。那是真正的端到端
 *   测试范畴，需要 fixture entry.server.tsx —— 用 bench/fixture/ 跑端到端覆盖。
 *
 *   本文件聚焦多模块协作契约（中间件层 + revalidate 分发层）：
 *
 *     IsrCacheStore  ←──── invalidator (registerInvalidator)
 *          ▲                          ▲
 *          │ 写入 cache entry          │ revalidatePath/Tag 调用时分发
 *          │                          │
 *     middleware (mock)          rsc/revalidate
 *
 * 这是过去 12% 测试覆盖率里最薄的一环——单测覆盖了各模块独立行为，
 * 但 "中间件注册的 invalidator 真的会清缓存吗 / 失败的 invalidator 不会留下脏状态吗"
 * 没有验证。本文件填这个洞。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryCacheStore, type IsrCachedEntry } from '../plugin/isrCacheStore';
import {
  createIsrCacheHandler,
  type IsrInvalidationBus,
  type IsrInvalidationTarget,
} from '../plugin/isrCacheMiddleware';
import { registerInvalidator, revalidatePath, revalidateTag, RevalidationError } from '../rsc';

/** 模拟一条 ISR 缓存条目 —— 字段与 isrCacheMiddleware 的真实写入对齐 */
function entry(tags: string[]): IsrCachedEntry {
  const now = Date.now();
  return {
    body: Buffer.from('<html>ok</html>'),
    statusCode: 200,
    headers: { 'content-type': 'text/html' },
    contentType: 'text/html',
    storedAt: now,
    expiresAt: now + 60_000,
    hardExpiresAt: now + 360_000,
    tags,
  };
}

/**
 * 模拟 isrCacheMiddleware 的 invalidator 注册逻辑（逐字符复刻关键路径）：
 *   - kind=tag → 遍历 entries，匹配 tag 即删
 *   - kind=path → 命中 GET:path / GET:path_.rsc 等 key 即删
 */
function wireInvalidator(cache: ReturnType<typeof createMemoryCacheStore>): () => void {
  return registerInvalidator(target => {
    if (target.kind === 'tag') {
      for (const [key, e] of Array.from(cache.entries())) {
        if (e.tags.includes(target.value)) cache.delete(key);
      }
    } else {
      const keys = [`GET:${target.value}`, `GET:${target.value}_.rsc`, `GET:${target.value}/_.rsc`];
      for (const key of Array.from(cache.keys())) {
        if (keys.includes(key) || keys.some(k => key.startsWith(`${k}?`))) {
          cache.delete(key);
        }
      }
    }
  });
}

describe('ISR engine lifecycle —— cache + invalidator integration', () => {
  let cache: ReturnType<typeof createMemoryCacheStore>;
  let unregister: () => void;

  beforeEach(() => {
    cache = createMemoryCacheStore({ max: 100 });
    unregister = wireInvalidator(cache);
  });

  afterEach(async () => {
    unregister();
    await cache.destroy();
  });

  it('startup → write → read HIT', () => {
    cache.set('GET:/books', entry(['books']));
    const got = cache.get('GET:/books');
    expect(got).toBeDefined();
    expect(got?.tags).toEqual(['books']);
  });

  it('revalidateTag clears all entries with matching tag', async () => {
    cache.set('GET:/books', entry(['books']));
    cache.set('GET:/books/1', entry(['books', 'book:1']));
    cache.set('GET:/books/2', entry(['books', 'book:2']));
    cache.set('GET:/about', entry(['static']));
    expect(cache.size).toBe(4);

    await revalidateTag('books');

    expect(cache.get('GET:/books')).toBeUndefined();
    expect(cache.get('GET:/books/1')).toBeUndefined();
    expect(cache.get('GET:/books/2')).toBeUndefined();
    expect(cache.get('GET:/about')).toBeDefined(); // 不带 'books' tag，保留
    expect(cache.size).toBe(1);
  });

  it('revalidateTag with subset tag clears only that subset', async () => {
    cache.set('GET:/books/1', entry(['books', 'book:1']));
    cache.set('GET:/books/2', entry(['books', 'book:2']));

    await revalidateTag('book:1');

    expect(cache.get('GET:/books/1')).toBeUndefined();
    expect(cache.get('GET:/books/2')).toBeDefined();
  });

  it('revalidatePath clears specific path + its _.rsc twin', async () => {
    cache.set('GET:/books/1', entry(['books']));
    cache.set('GET:/books/1_.rsc', entry(['books']));
    cache.set('GET:/books/2', entry(['books']));

    await revalidatePath('/books/1');

    expect(cache.get('GET:/books/1')).toBeUndefined();
    expect(cache.get('GET:/books/1_.rsc')).toBeUndefined();
    expect(cache.get('GET:/books/2')).toBeDefined();
  });

  it('revalidatePath also clears entries with query string', async () => {
    cache.set('GET:/books?page=1', entry(['books']));
    cache.set('GET:/books?page=2', entry(['books']));
    cache.set('GET:/about?foo=bar', entry(['static']));

    await revalidatePath('/books');

    expect(cache.get('GET:/books?page=1')).toBeUndefined();
    expect(cache.get('GET:/books?page=2')).toBeUndefined();
    expect(cache.get('GET:/about?foo=bar')).toBeDefined();
  });

  it('concurrent revalidateTag calls converge correctly', async () => {
    for (let i = 0; i < 50; i++) {
      cache.set(`GET:/books/${i}`, entry(['books']));
    }
    expect(cache.size).toBe(50);

    // 5 个并发 revalidateTag 调用 —— 不能 race（重复扫描 / 漏扫）
    await Promise.all([
      revalidateTag('books'),
      revalidateTag('books'),
      revalidateTag('books'),
      revalidateTag('books'),
      revalidateTag('books'),
    ]);

    expect(cache.size).toBe(0);
  });

  it('shutdown unregisters invalidator —— 后续 revalidate 不再清除', async () => {
    cache.set('GET:/books', entry(['books']));

    unregister();
    await revalidateTag('books');

    // invalidator 已 unregister，cache 应保留
    expect(cache.get('GET:/books')).toBeDefined();

    // 重新注册供 afterEach unregister （无副作用）
    unregister = wireInvalidator(cache);
  });

  it('cache.destroy() releases resources', async () => {
    cache.set('GET:/books', entry(['books']));
    expect(cache.size).toBe(1);

    await cache.destroy();
    expect(cache.size).toBe(0);
  });
});

describe('ISR engine lifecycle —— failing invalidator does not poison registry', () => {
  let goodCache: ReturnType<typeof createMemoryCacheStore>;
  let badCache: ReturnType<typeof createMemoryCacheStore>;
  let unregisterGood: () => void;
  let unregisterBad: () => void;

  beforeEach(() => {
    goodCache = createMemoryCacheStore({ max: 100 });
    badCache = createMemoryCacheStore({ max: 100 });
    unregisterGood = wireInvalidator(goodCache);
    // 一个故意失败的 invalidator —— 模拟 Redis 回源错误
    unregisterBad = registerInvalidator(async () => {
      throw new Error('redis: ECONNREFUSED');
    });
  });

  afterEach(async () => {
    unregisterGood();
    unregisterBad();
    await goodCache.destroy();
    await badCache.destroy();
  });

  it('one invalidator failing does NOT prevent others from clearing cache', async () => {
    goodCache.set('GET:/books', entry(['books']));

    // revalidateTag 会抛 RevalidationError（含失败 invalidator 信息），
    // 但 goodCache 的 invalidator 仍然必须执行完——这是核心契约
    await expect(revalidateTag('books')).rejects.toBeInstanceOf(RevalidationError);

    expect(goodCache.get('GET:/books')).toBeUndefined(); // ✓ 真的清掉了
  });

  it('failure surfaces as RevalidationError with successCount + failureCount', async () => {
    goodCache.set('GET:/books', entry(['books']));

    try {
      await revalidatePath('/books');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RevalidationError);
      const re = err as RevalidationError;
      expect(re.successCount).toBe(1);
      expect(re.failureCount).toBe(1);
      expect(re.causes[0].message).toContain('ECONNREFUSED');
    }
  });

  it('after handling failure, subsequent revalidate still works', async () => {
    goodCache.set('GET:/books', entry(['books']));
    await revalidateTag('books').catch(() => {}); // 吃掉错误，模拟业务侧的 try/catch

    // 再次写入 + 失效 —— 注册表没坏，应该正常工作
    goodCache.set('GET:/books/2', entry(['books']));
    await revalidateTag('books').catch(() => {});

    expect(goodCache.get('GET:/books/2')).toBeUndefined();
  });
});

describe('ISR engine lifecycle —— invalidator unregister cleanup', () => {
  it('repeated register/unregister leaves no leak', async () => {
    const cache = createMemoryCacheStore({ max: 10 });

    for (let i = 0; i < 100; i++) {
      const u = wireInvalidator(cache);
      cache.set(`GET:/page${i}`, entry(['x']));
      await revalidateTag('x');
      u();
    }

    // 上面 100 个 register/unregister 后，registry 应该是空的——
    // 再 revalidate 不应该 throw（无 invalidator → 静默 no-op）
    cache.set('GET:/final', entry(['x']));
    await expect(revalidateTag('x')).resolves.toBeUndefined();
    // 但 cache 这次没人清——验证 unregister 真的生效了
    expect(cache.get('GET:/final')).toBeDefined();

    await cache.destroy();
  });
});

describe('ISR engine lifecycle —— cross-pod invalidation bus', () => {
  function createFakeBus(): IsrInvalidationBus & {
    published: IsrInvalidationTarget[];
    emit(target: IsrInvalidationTarget): Promise<void>;
  } {
    const listeners = new Set<(target: IsrInvalidationTarget) => Promise<void> | void>();
    return {
      published: [],
      publish(target) {
        this.published.push(target);
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async emit(target) {
        for (const listener of Array.from(listeners)) {
          await listener(target);
        }
      },
    };
  }

  it('local revalidate clears L1 and publishes to the bus', async () => {
    const cache = createMemoryCacheStore({ max: 10 });
    const bus = createFakeBus();
    const handler = createIsrCacheHandler({}, { store: cache, invalidationBus: bus });

    cache.set('GET:/books', entry(['books']));
    await revalidateTag('books');

    expect(cache.get('GET:/books')).toBeUndefined();
    expect(bus.published).toEqual([{ kind: 'tag', value: 'books' }]);

    await handler.destroy();
  });

  it('remote bus event clears this pod without re-publishing', async () => {
    const cache = createMemoryCacheStore({ max: 10 });
    const bus = createFakeBus();
    const handler = createIsrCacheHandler({}, { store: cache, invalidationBus: bus });

    cache.set('GET:/books/1', entry(['books', 'book:1']));
    await bus.emit({ kind: 'tag', value: 'books' });

    expect(cache.get('GET:/books/1')).toBeUndefined();
    expect(bus.published).toEqual([]);

    await handler.destroy();
  });
});
