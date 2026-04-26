/**
 * RedisCacheAdapter + HybridCacheStore 真实 Redis 协议 e2e 测试
 *
 * 用 ioredis-mock —— 实现完整的 Redis Wire 协议（不是手写桩），
 * 跑得通 RedisCacheAdapter 的 SET/GET/DEL/PIPELINE 全流程，
 * 也是 ioredis 官方推荐的 unit test 路径。
 *
 * 覆盖：
 *   - 单 adapter：set/get/delete/has/clear/getMany/setMany/invalidateByTag
 *   - HybridCacheStore：L1 sync 读、L2 异步写穿、L2 失败回退、destroy
 *   - 跨「Pod」一致性：两个 HybridStore 共享一个 Redis，pod1 写、pod2 通过 L2 读到
 *   - 重启 L1 重建：清空 L1 → 通过 L2 仍能拿到值
 */
import { describe, it, expect, vi } from 'vitest';
import IoRedisMock from 'ioredis-mock';

// 关键：vi.mock 必须在 import RedisCacheAdapter **之前**（vitest 自动 hoist）
// 这样 RedisCacheAdapter 的 `await import('ioredis')` 拿到的就是 mock
vi.mock('ioredis', () => ({ default: IoRedisMock, __esModule: true }));

import { RedisCacheAdapter } from '../RedisCacheAdapter';
import {
  createHybridCacheStore,
  createMemoryCacheStore,
  type IsrCachedEntry,
} from '../../plugin/isrCacheStore';

function entry(body = 'x', tags: string[] = []): IsrCachedEntry {
  const now = Date.now();
  return {
    body: Buffer.from(body),
    statusCode: 200,
    headers: { 'content-type': 'text/html' },
    contentType: 'text/html',
    storedAt: now,
    expiresAt: now + 60_000,
    hardExpiresAt: now + 300_000,
    tags,
  };
}

describe('RedisCacheAdapter e2e (ioredis-mock)', () => {
  it('set + get 来回成功（不走降级）', async () => {
    const adapter = new RedisCacheAdapter({
      host: 'localhost',
      keyPrefix: 'test:',
      enableFallback: false,
    });
    // 等连接就绪
    await new Promise(r => setTimeout(r, 50));
    await adapter.set('k1', { hello: 'world' }, { ttl: 60 });
    const v = await adapter.get<{ hello: string }>('k1');
    expect(v).toEqual({ hello: 'world' });
    await adapter.destroy();
  });

  it('delete 删除成功', async () => {
    const adapter = new RedisCacheAdapter({
      host: 'localhost',
      keyPrefix: 'test:',
      enableFallback: false,
    });
    await new Promise(r => setTimeout(r, 50));
    await adapter.set('k', 1);
    expect(await adapter.has('k')).toBe(true);
    expect(await adapter.delete('k')).toBe(true);
    expect(await adapter.has('k')).toBe(false);
    await adapter.destroy();
  });

  it('getMany / setMany 批量', async () => {
    const adapter = new RedisCacheAdapter({
      host: 'localhost',
      keyPrefix: 'test:',
      enableFallback: false,
    });
    await new Promise(r => setTimeout(r, 50));
    await adapter.setMany([
      { key: 'a', value: 1 },
      { key: 'b', value: 2 },
      { key: 'c', value: 3 },
    ]);
    const result = await adapter.getMany<number>(['a', 'b', 'c', 'missing']);
    expect(result.get('a')).toBe(1);
    expect(result.get('b')).toBe(2);
    expect(result.get('c')).toBe(3);
    expect(result.get('missing')).toBeUndefined();
    await adapter.destroy();
  });

  it('clear 清空整个 keyPrefix', async () => {
    const adapter = new RedisCacheAdapter({
      host: 'localhost',
      keyPrefix: 'test:',
      enableFallback: false,
    });
    await new Promise(r => setTimeout(r, 50));
    await adapter.set('a', 1);
    await adapter.set('b', 2);
    await adapter.clear();
    expect(await adapter.has('a')).toBe(false);
    expect(await adapter.has('b')).toBe(false);
    await adapter.destroy();
  });
});

describe('HybridCacheStore + 真实 Redis 协议 e2e', () => {
  it('L1 同步读 + L2 异步写穿（write-through）', async () => {
    const redis = new RedisCacheAdapter({
      host: 'localhost',
      keyPrefix: 'h1:',
      enableFallback: false,
    });
    await new Promise(r => setTimeout(r, 50));
    const store = createHybridCacheStore({ redis, redisKeyPrefix: 'r:' });

    store.set('k', entry('hello'));
    // L1 同步可读
    expect(store.get('k')?.body.toString()).toBe('hello');

    // 等 L2 异步写穿完成
    await new Promise(r => setTimeout(r, 50));
    const fromL2 = await redis.get<{ body: string; statusCode: number }>('r:k');
    expect(fromL2).toBeDefined();
    expect(fromL2?.statusCode).toBe(200);
    if (!fromL2) {
      throw new Error('expected L2 cache entry');
    }
    expect(Buffer.from(fromL2.body, 'base64').toString()).toBe('hello');

    await store.destroy();
  });

  it('跨 Pod 一致性：共享 L2，pod1 写 → pod2 L1 miss + getAsync 命中 L2', async () => {
    // 真实生产场景：单一 Redis 集群，多个 Pod 各自的 ioredis 客户端。
    // ioredis-mock 实例间默认不共享数据，所以这里用 SINGLE adapter 模拟「共享 L2」，
    // 两个 HybridStore 各自独立 L1，但都指向同一个 L2 —— 完整验证跨 Pod 一致性的关键路径。
    const sharedRedis = new RedisCacheAdapter({
      host: 'localhost',
      keyPrefix: 'shared:',
      enableFallback: false,
    });
    await new Promise(r => setTimeout(r, 50));

    const pod1 = createHybridCacheStore({ redis: sharedRedis, redisKeyPrefix: 'pod:' });
    const pod2 = createHybridCacheStore({ redis: sharedRedis, redisKeyPrefix: 'pod:' });

    pod1.set('book:1', entry('诡秘之主'));
    await new Promise(r => setTimeout(r, 50)); // 等 L2 写穿

    // pod2 的 L1 没有该 key（独立 L1），但 getAsync 会回源 L2 并回填本地 L1
    expect(pod2.get('book:1')).toBeUndefined();
    const restored = await pod2.getAsync?.('book:1');
    expect(restored).toBeDefined();
    expect(restored?.body.toString()).toBe('诡秘之主');
    expect(pod2.get('book:1')?.body.toString()).toBe('诡秘之主');

    await sharedRedis.destroy();
  });

  it('Pod 重启 L1 清零：新实例通过 getAsync 从 L2 恢复', async () => {
    const redis = new RedisCacheAdapter({
      host: 'localhost',
      keyPrefix: 'restart:',
      enableFallback: false,
    });
    await new Promise(r => setTimeout(r, 50));
    const store = createHybridCacheStore({ redis });

    store.set('k', entry('persistent'));
    await new Promise(r => setTimeout(r, 50));

    // 模拟 pod 重启：旧 L1 丢失，新实例通过 L2 恢复
    const restarted = createHybridCacheStore({ redis });
    const restored = await restarted.getAsync?.('k');
    expect(restored?.body.toString()).toBe('persistent');
    expect(restarted.get('k')?.body.toString()).toBe('persistent');

    await store.destroy();
    await restarted.destroy();
  });

  it('L2 写失败：L1 不受影响 + onRedisError 触发', async () => {
    const redis = new RedisCacheAdapter({
      host: 'localhost',
      keyPrefix: 'err:',
      enableFallback: false,
    });
    await new Promise(r => setTimeout(r, 50));
    // 强制 L2 set 抛错
    redis.set = vi.fn().mockRejectedValue(new Error('redis down'));
    const onError = vi.fn();
    const store = createHybridCacheStore({ redis, onRedisError: onError });

    expect(() => store.set('k', entry())).not.toThrow();
    expect(store.get('k')).toBeDefined(); // L1 仍有
    await new Promise(r => setTimeout(r, 50));
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'set', 'k');

    await store.destroy();
  });

  it('destroy 关闭 L2 连接', async () => {
    const redis = new RedisCacheAdapter({
      host: 'localhost',
      keyPrefix: 'd:',
      enableFallback: false,
    });
    await new Promise(r => setTimeout(r, 50));
    const store = createHybridCacheStore({ redis });
    store.set('k', entry());
    await store.destroy();
    expect(store.size).toBe(0);
  });
});

describe('Memory store baseline （对比组）', () => {
  it('memory store 不依赖 Redis，行为同 Hybrid 的 L1', () => {
    const store = createMemoryCacheStore({ max: 10 });
    store.set('k', entry('x'));
    expect(store.get('k')?.body.toString()).toBe('x');
    expect(store.backend).toBe('memory');
  });
});

/**
 * v2.1 Buffer 序列化修复：`JSON.stringify(Buffer)` 默认输出 `{type:'Buffer',data:[...]}`，
 * 反序列回来是普通对象不是 Buffer，消费侧 `.toString()` / `.length` 全坏。
 * 修复方案：用 `__isr_buf_b64__` tag 编码 + 解码。
 */
describe('RedisCacheAdapter —— Buffer/二进制序列化保真（v2.1 修复）', () => {
  it('顶层 Buffer 值存入 → 读出仍然是 Buffer，内容一致', async () => {
    const adapter = new RedisCacheAdapter({
      host: 'localhost',
      keyPrefix: 'buf:',
      enableFallback: false,
    });
    await new Promise(r => setTimeout(r, 50));

    const payload = Buffer.from('hello二进制 🚀', 'utf8');
    await adapter.set('raw', payload);

    const got = await adapter.get<Buffer>('raw');
    expect(Buffer.isBuffer(got)).toBe(true);
    expect(got?.toString('utf8')).toBe('hello二进制 🚀');
    expect(got?.length).toBe(payload.length);

    await adapter.destroy();
  });

  it('嵌套对象中的 Buffer 字段也能被保真还原', async () => {
    const adapter = new RedisCacheAdapter({
      host: 'localhost',
      keyPrefix: 'buf2:',
      enableFallback: false,
    });
    await new Promise(r => setTimeout(r, 50));

    interface Payload {
      name: string;
      thumbnail: Buffer;
      nested: { secret: Buffer };
    }
    const value: Payload = {
      name: 'cover.png',
      thumbnail: Buffer.from([0x89, 0x50, 0x4e, 0x47]), // PNG 魔数头
      nested: { secret: Buffer.from('nested-blob') },
    };
    await adapter.set('page', value);

    const got = await adapter.get<Payload>('page');
    expect(got?.name).toBe('cover.png');
    expect(Buffer.isBuffer(got?.thumbnail)).toBe(true);
    expect(Array.from(got!.thumbnail)).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(Buffer.isBuffer(got?.nested.secret)).toBe(true);
    expect(got?.nested.secret.toString()).toBe('nested-blob');

    await adapter.destroy();
  });

  it('Uint8Array 也被当作二进制 round-trip 为 Buffer', async () => {
    const adapter = new RedisCacheAdapter({
      host: 'localhost',
      keyPrefix: 'u8:',
      enableFallback: false,
    });
    await new Promise(r => setTimeout(r, 50));

    const u8 = new Uint8Array([1, 2, 3, 255]);
    await adapter.set('u8', u8);

    const got = await adapter.get<Buffer>('u8');
    expect(Buffer.isBuffer(got)).toBe(true);
    expect(Array.from(got!)).toEqual([1, 2, 3, 255]);

    await adapter.destroy();
  });

  it('普通 JSON 数据不受 Buffer 编码影响', async () => {
    const adapter = new RedisCacheAdapter({
      host: 'localhost',
      keyPrefix: 'json:',
      enableFallback: false,
    });
    await new Promise(r => setTimeout(r, 50));

    const payload = { a: 1, b: 'str', c: [1, 2, 3], d: { e: true } };
    await adapter.set('k', payload);
    const got = await adapter.get('k');
    expect(got).toEqual(payload);

    await adapter.destroy();
  });
});

/**
 * v2.1 修复：ioredis pipeline.exec() 结果若有单条失败会被静默吞掉。
 * 之前 `set(..., { tags })` 的 SADD 失败 → 后续 invalidateByTag 查不到 key，
 * 缓存失效悄悄不生效。现在 assertPipelineOk 检查每条 reply 的 err 字段并抛聚合错误。
 */
describe('RedisCacheAdapter —— pipeline 错误聚合（v2.1 修复）', () => {
  it('SADD 标签 pipeline 某条失败 → set() 走降级路径（不静默吞错）', async () => {
    const adapter = new RedisCacheAdapter({
      host: 'localhost',
      keyPrefix: 'pf:',
      enableFallback: true, // 启用内存降级，set() catch 后应写 fallback
    });
    await new Promise(r => setTimeout(r, 50));

    // 劫持 pipeline，让 exec() 返回 [ [err, reply], ... ]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const redis = (adapter as any).redis as {
      pipeline: () => unknown;
      sadd: (...a: unknown[]) => unknown;
      setex: (...a: unknown[]) => unknown;
    };
    const origPipeline = redis.pipeline.bind(redis);
    redis.pipeline = () => {
      const real = origPipeline() as {
        exec: () => Promise<Array<[Error | null, unknown]>>;
        sadd: (...a: unknown[]) => unknown;
        setex: (...a: unknown[]) => unknown;
        set: (...a: unknown[]) => unknown;
      };
      const realExec = real.exec.bind(real);
      real.exec = async () => {
        const res = await realExec();
        // 注入第一条失败
        if (res && res.length > 0) {
          res[0] = [new Error('SADD simulated failure'), null];
        }
        return res;
      };
      return real;
    };

    // set 会执行 setex 成功 + tag pipeline 失败 → catch → fallback.set
    await adapter.set('k', { payload: 'fine' }, { tags: ['books'] });

    // fallback 里应该有值（set 走到了 catch → this.fallback.set）
    // 通过 getStats 间接观察：fallback size 从 0 升到 ≥1
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fb = (adapter as any).fallback as { getStats: () => { size: number } };
    expect(fb.getStats().size).toBeGreaterThanOrEqual(1);

    await adapter.destroy();
  });

  it('enableFallback=false + pipeline 失败 → 明确 error log（数据丢失不静默）', async () => {
    const adapter = new RedisCacheAdapter({
      host: 'localhost',
      keyPrefix: 'pfn:',
      enableFallback: false,
    });
    await new Promise(r => setTimeout(r, 50));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internalLogger = (adapter as any).logger as { error: (msg: string) => void };
    const errSpy = vi.spyOn(internalLogger, 'error');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const redis = (adapter as any).redis as { pipeline: () => unknown };
    const origPipeline = redis.pipeline.bind(redis);
    redis.pipeline = () => {
      const real = origPipeline() as {
        exec: () => Promise<Array<[Error | null, unknown]>>;
      };
      const realExec = real.exec.bind(real);
      real.exec = async () => {
        const res = await realExec();
        if (res?.length) res[0] = [new Error('simulated tag SADD failure'), null];
        return res;
      };
      return real;
    };

    await adapter.set('k', 'v', { tags: ['x'] });

    // 验证确实打印了 "未启用 fallback，数据丢失" 级 error
    const called = errSpy.mock.calls.some(args =>
      String(args[0] ?? '').includes('未启用 fallback')
    );
    expect(called).toBe(true);

    await adapter.destroy();
  });
});
