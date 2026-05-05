import { describe, it, expect, vi } from 'vitest';
import {
  createRateLimiter,
  createRateLimitStoreFromRuntime,
  createMemoryRateLimitStore,
  createRedisRateLimitStore,
  extractClientIp,
  type RedisLikeClient,
} from '../RateLimiter';
import type { Request, Response } from 'express';

function mockRes() {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let body: unknown = null;
  let ended = false;
  const res = {
    setHeader: (k: string, v: string) => (headers[k] = v),
    status: (s: number) => {
      statusCode = s;
      return res;
    },
    type: () => res,
    json: (b: unknown) => {
      body = b;
      ended = true;
      return res;
    },
    send: (b: unknown) => {
      body = b;
      ended = true;
      return res;
    },
  } as unknown as Response & {
    headers: Record<string, string>;
    statusCode: number;
    body: unknown;
    ended: boolean;
  };
  Object.defineProperty(res, 'headers', { get: () => headers });
  Object.defineProperty(res, 'statusCode', { get: () => statusCode });
  Object.defineProperty(res, 'body', { get: () => body });
  Object.defineProperty(res, 'ended', { get: () => ended });
  return res;
}

function mockReq(ip = '127.0.0.1', path = '/'): Request {
  return { ip, path } as Request;
}

describe('RateLimiter', () => {
  it('放行窗口内请求 + 限流超量', async () => {
    const mw = createRateLimiter({ windowMs: 10_000, max: 3 });
    const req = mockReq();
    let nextCalled = 0;
    const next = () => void nextCalled++;

    for (let i = 0; i < 3; i++) {
      const res = mockRes();
      await mw(req, res, next);
      expect(res.headers['RateLimit-Limit']).toBe('3');
    }
    expect(nextCalled).toBe(3);

    // 第 4 次应被拒
    const res4 = mockRes();
    await mw(req, res4, next);
    expect(res4.statusCode).toBe(429);
    expect(res4.body).toEqual({ error: 'Too Many Requests' });
    expect(res4.headers['Retry-After']).toBeDefined();
    expect(nextCalled).toBe(3);
  });

  it('skip 函数命中 → 直接放行不计数', async () => {
    const mw = createRateLimiter({
      windowMs: 10_000,
      max: 1,
      skip: req => req.path === '/health',
    });
    let nextCalled = 0;
    const next = () => void nextCalled++;

    for (let i = 0; i < 5; i++) {
      await mw(mockReq('1.1.1.1', '/health'), mockRes(), next);
    }
    expect(nextCalled).toBe(5);
  });

  it('默认跳过静态资源和开发态模块请求，不消耗页面限流配额', async () => {
    const mw = createRateLimiter({ windowMs: 10_000, max: 1 });
    let nextCalled = 0;
    const next = () => void nextCalled++;

    await mw(mockReq('1.1.1.1', '/assets/index.js'), mockRes(), next);
    await mw(mockReq('1.1.1.1', '/src/components/Header/index.tsx'), mockRes(), next);
    await mw(mockReq('1.1.1.1', '/@vite/client'), mockRes(), next);

    const page1 = mockRes();
    await mw(mockReq('1.1.1.1', '/books'), page1, next);
    expect(page1.statusCode).toBe(200);

    const page2 = mockRes();
    await mw(mockReq('1.1.1.1', '/books'), page2, next);
    expect(page2.statusCode).toBe(429);
    expect(nextCalled).toBe(4);
  });

  it('支持 runtime 传入自定义跳过 path / prefix / extension', async () => {
    const mw = createRateLimiter({
      windowMs: 10_000,
      max: 1,
      skipPaths: ['/internal/ping'],
      skipPathPrefixes: ['/internal/static/'],
      skipExtensions: ['.wasm'],
    });
    let nextCalled = 0;
    const next = () => void nextCalled++;

    await mw(mockReq('2.2.2.2', '/internal/ping'), mockRes(), next);
    await mw(mockReq('2.2.2.2', '/internal/static/runtime.bin'), mockRes(), next);
    await mw(mockReq('2.2.2.2', '/worker.wasm'), mockRes(), next);

    const page1 = mockRes();
    await mw(mockReq('2.2.2.2', '/reviews'), page1, next);
    expect(page1.statusCode).toBe(200);

    const page2 = mockRes();
    await mw(mockReq('2.2.2.2', '/reviews'), page2, next);
    expect(page2.statusCode).toBe(429);
    expect(nextCalled).toBe(4);
  });

  it('keyGenerator 区分 key', async () => {
    const mw = createRateLimiter({ windowMs: 10_000, max: 1 });
    const next = () => {};

    const r1a = mockRes();
    await mw(mockReq('1.1.1.1'), r1a, next);
    expect(r1a.statusCode).toBe(200);

    const r1b = mockRes();
    await mw(mockReq('1.1.1.1'), r1b, next);
    expect(r1b.statusCode).toBe(429);

    // 不同 IP 不互相影响
    const r2a = mockRes();
    await mw(mockReq('2.2.2.2'), r2a, next);
    expect(r2a.statusCode).toBe(200);
  });

  it('memory store 自然 reset', async () => {
    const store = createMemoryRateLimitStore();
    const k = 'k';
    const a = await store.incr(k, 50);
    expect(a.count).toBe(1);
    const b = await store.incr(k, 50);
    expect(b.count).toBe(2);
    await new Promise(r => setTimeout(r, 60));
    const c = await store.incr(k, 50);
    expect(c.count).toBe(1);
  });
});

/**
 * v2.1 修复：默认 `req.ip` 无法识别代理后真实客户端 IP，导致攻击者通过代理绕过限流。
 * 新增 `trustProxy` 选项 + `extractClientIp` helper，按优先级读取头部。
 */
describe('RateLimiter —— extractClientIp 真实 IP 提取', () => {
  const mk = (headers: Record<string, string | string[]>, ip?: string): Request =>
    ({
      ip,
      headers,
    }) as unknown as Request;

  it('trustProxy=false → 忽略代理头，只用 req.ip', () => {
    const req = mk(
      {
        'cf-connecting-ip': '1.2.3.4',
        'x-real-ip': '5.6.7.8',
        'x-forwarded-for': '9.10.11.12',
      },
      '127.0.0.1'
    );
    expect(extractClientIp(req, false)).toBe('127.0.0.1');
  });

  it('trustProxy=true + CF-Connecting-IP 优先级最高', () => {
    const req = mk(
      {
        'cf-connecting-ip': '1.2.3.4',
        'x-real-ip': '5.6.7.8',
        'x-forwarded-for': '9.10.11.12',
      },
      '127.0.0.1'
    );
    expect(extractClientIp(req, true)).toBe('1.2.3.4');
  });

  it('trustProxy=true + 无 CF 头 → 用 X-Real-IP', () => {
    const req = mk({ 'x-real-ip': '5.6.7.8', 'x-forwarded-for': '9.10.11.12' }, '127.0.0.1');
    expect(extractClientIp(req, true)).toBe('5.6.7.8');
  });

  it('trustProxy=true + 只有 XFF → 取最左（原始客户端）', () => {
    const req = mk({ 'x-forwarded-for': '203.0.113.5, 10.0.0.1, 10.0.0.2' }, '10.0.0.2');
    expect(extractClientIp(req, true)).toBe('203.0.113.5');
  });

  it('trustProxy=true + 全无代理头 → 回退 req.ip', () => {
    expect(extractClientIp(mk({}, '198.51.100.1'), true)).toBe('198.51.100.1');
  });

  it('req.ip 也无 → "unknown"', () => {
    expect(extractClientIp(mk({}), true)).toBe('unknown');
    expect(extractClientIp(mk({}), false)).toBe('unknown');
  });

  it('头部为数组时取第一项', () => {
    const req = mk({ 'cf-connecting-ip': ['1.1.1.1', '2.2.2.2'] });
    expect(extractClientIp(req, true)).toBe('1.1.1.1');
  });
});

describe('RateLimiter —— trustProxy 集成行为', () => {
  function mkProxyReq(headers: Record<string, string>, ip = '10.0.0.1'): Request {
    return { ip, headers, path: '/' } as unknown as Request;
  }

  it('trustProxy=true + 两请求同一真实 IP（经代理）→ 被正确合并计数限流', async () => {
    const mw = createRateLimiter({
      windowMs: 10_000,
      max: 2,
      trustProxy: true,
    });
    const next = (): void => {};

    // 两个"不同 socket"(req.ip 不同) 但同一真实 IP 的请求
    const req1 = mkProxyReq({ 'cf-connecting-ip': '203.0.113.99' }, '10.0.0.1');
    const req2 = mkProxyReq({ 'cf-connecting-ip': '203.0.113.99' }, '10.0.0.2');
    const req3 = mkProxyReq({ 'cf-connecting-ip': '203.0.113.99' }, '10.0.0.3');

    const r1 = mockRes();
    const r2 = mockRes();
    const r3 = mockRes();
    await mw(req1, r1, next);
    await mw(req2, r2, next);
    await mw(req3, r3, next);

    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r3.statusCode).toBe(429);
  });
});

describe('RateLimiter —— BENCH_DISABLE_RATE_LIMIT 逃生开关', () => {
  it('env=1 → 所有请求放行（即使超 max）', async () => {
    const original = process.env.BENCH_DISABLE_RATE_LIMIT;
    process.env.BENCH_DISABLE_RATE_LIMIT = '1';
    try {
      const mw = createRateLimiter({ windowMs: 10_000, max: 1 });
      let nextCalled = 0;
      const next = (): void => void nextCalled++;
      // 跑 5 次同 IP，远超 max=1
      for (let i = 0; i < 5; i++) {
        const res = mockRes();
        await mw(mockReq('1.1.1.1'), res, next);
        expect(res.statusCode).toBe(200); // 没有被 429 拦下
      }
      expect(nextCalled).toBe(5);
    } finally {
      if (original === undefined) delete process.env.BENCH_DISABLE_RATE_LIMIT;
      else process.env.BENCH_DISABLE_RATE_LIMIT = original;
    }
  });

  it('env 未设 → 正常限流', async () => {
    delete process.env.BENCH_DISABLE_RATE_LIMIT;
    const mw = createRateLimiter({ windowMs: 10_000, max: 1 });
    const next = (): void => {};
    const r1 = mockRes();
    await mw(mockReq('2.2.2.2'), r1, next);
    expect(r1.statusCode).toBe(200);
    const r2 = mockRes();
    await mw(mockReq('2.2.2.2'), r2, next);
    expect(r2.statusCode).toBe(429);
  });

  it('env 不是 "1" 的其他值不触发逃生', async () => {
    const original = process.env.BENCH_DISABLE_RATE_LIMIT;
    process.env.BENCH_DISABLE_RATE_LIMIT = 'true'; // 不等于 '1' 的字符串
    try {
      const mw = createRateLimiter({ windowMs: 10_000, max: 1 });
      const next = (): void => {};
      const r1 = mockRes();
      await mw(mockReq('3.3.3.3'), r1, next);
      const r2 = mockRes();
      await mw(mockReq('3.3.3.3'), r2, next);
      // 'true' ≠ '1' → 应该照常限流
      expect(r2.statusCode).toBe(429);
    } finally {
      if (original === undefined) delete process.env.BENCH_DISABLE_RATE_LIMIT;
      else process.env.BENCH_DISABLE_RATE_LIMIT = original;
    }
  });

  it('runtime 翻开关 → 立即生效（不需重建中间件）', async () => {
    delete process.env.BENCH_DISABLE_RATE_LIMIT;
    const mw = createRateLimiter({ windowMs: 10_000, max: 1 });
    const next = (): void => {};

    // 第 1 次：限流 max=1 → ok
    const r1 = mockRes();
    await mw(mockReq('4.4.4.4'), r1, next);
    expect(r1.statusCode).toBe(200);

    // 第 2 次：超 max → 429
    const r2 = mockRes();
    await mw(mockReq('4.4.4.4'), r2, next);
    expect(r2.statusCode).toBe(429);

    // 翻开关 → 应该立刻放行
    process.env.BENCH_DISABLE_RATE_LIMIT = '1';
    try {
      const r3 = mockRes();
      await mw(mockReq('4.4.4.4'), r3, next);
      expect(r3.statusCode).toBe(200);
    } finally {
      delete process.env.BENCH_DISABLE_RATE_LIMIT;
    }
  });
});

describe('RateLimiter —— Redis Lua 原子脚本', () => {
  it('defineCommand 成功 → 走 Lua 一次 RTT 路径', async () => {
    const luaCall = vi.fn(async () => [1, 60_000] as [number, number]);
    const define = vi.fn();

    const redis: RedisLikeClient = {
      incr: vi.fn(),
      pexpire: vi.fn(),
      pttl: vi.fn(),
      defineCommand: (_name, _opts) => {
        define();
        // 模拟 ioredis 把 lua 脚本挂成客户端方法
        redis.isrRateLimitIncr = luaCall;
      },
    };

    const store = createRedisRateLimitStore(redis);
    const res = await store.incr('k', 60_000);
    expect(define).toHaveBeenCalled();
    expect(luaCall).toHaveBeenCalledWith('k', 60_000);
    expect(res.count).toBe(1);
    expect(res.resetMs).toBe(60_000);
    // 三段式命令一个都不应该被调到
    expect(redis.incr).not.toHaveBeenCalled();
    expect(redis.pexpire).not.toHaveBeenCalled();
    expect(redis.pttl).not.toHaveBeenCalled();
  });

  it('defineCommand 抛错 → 回退到 INCR + PEXPIRE + PTTL 三段式', async () => {
    const redis: RedisLikeClient = {
      incr: vi.fn(async () => 1),
      pexpire: vi.fn(async () => 1),
      pttl: vi.fn(async () => 30_000),
      defineCommand: () => {
        throw new Error('defineCommand not supported');
      },
    };

    const store = createRedisRateLimitStore(redis);
    const res = await store.incr('k', 60_000);

    expect(redis.incr).toHaveBeenCalledWith('k');
    expect(redis.pexpire).toHaveBeenCalledWith('k', 60_000);
    expect(redis.pttl).toHaveBeenCalledWith('k');
    expect(res.count).toBe(1);
    expect(res.resetMs).toBe(30_000);
  });

  it('count > 1 时不再 PEXPIRE（保留既有 TTL）', async () => {
    const redis: RedisLikeClient = {
      incr: vi.fn(async () => 5),
      pexpire: vi.fn(async () => 1),
      pttl: vi.fn(async () => 12_000),
      // 无 defineCommand → 走 fallback
    };

    const store = createRedisRateLimitStore(redis);
    await store.incr('k', 60_000);

    expect(redis.incr).toHaveBeenCalled();
    expect(redis.pexpire).not.toHaveBeenCalled();
    expect(redis.pttl).toHaveBeenCalled();
  });
});

describe('RateLimiter —— runtime store 解析', () => {
  it('默认 store 未指定 + 无 Redis 配置 → memory（开箱即用）', async () => {
    const resolved = await createRateLimitStoreFromRuntime({});
    expect(resolved.backend).toBe('memory');

    const first = await resolved.store.incr('ip:1', 60_000);
    const second = await resolved.store.incr('ip:1', 60_000);
    expect(first.count).toBe(1);
    expect(second.count).toBe(2);
  });

  it("默认 store 未指定 + 显式 store='memory' → 强制 memory，即使 runtime.redis 存在", async () => {
    const resolved = await createRateLimitStoreFromRuntime(
      { store: 'memory' },
      { url: 'redis://127.0.0.1:6379' }
    );
    expect(resolved.backend).toBe('memory');
  });

  it("store='redis' 缺少 Redis 配置时回退 memory，而不是启动失败", async () => {
    const resolved = await createRateLimitStoreFromRuntime({ store: 'redis' });
    expect(resolved.backend).toBe('memory');
  });

  it("store='auto' 只有检测到 Redis 配置才切换 Redis", async () => {
    const resolved = await createRateLimitStoreFromRuntime({ store: 'auto' });
    expect(resolved.backend).toBe('memory');
  });

  it('非法 store 值 → warn 一次 + 当 auto 处理（不静默吞）', async () => {
    const warnings: unknown[][] = [];
    const { logger } = await import('../../logger');
    const spy = vi.spyOn(logger, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args);
    });
    try {
      const resolved = await createRateLimitStoreFromRuntime({
        store: 'mem' as unknown as 'memory',
      });
      expect(resolved.backend).toBe('memory');
      expect(warnings.length).toBeGreaterThan(0);
      const flat = warnings.flat().join(' ');
      expect(flat).toContain('rate-limit');
      expect(flat).toContain('mem');
    } finally {
      spy.mockRestore();
    }
  });

  it('store 未指定 + runtime.redis 已配置 → 自动用 Redis（开箱即用 / 复用 Redis 真值源）', async () => {
    const clients: unknown[][] = [];
    class MockRedis {
      isrRateLimitIncr?: (key: string, windowMs: number) => Promise<[number, number]>;
      constructor(...args: unknown[]) {
        clients.push(args);
      }
      on = vi.fn();
      incr = vi.fn();
      pexpire = vi.fn();
      pttl = vi.fn();
      defineCommand = vi.fn(() => {
        this.isrRateLimitIncr = vi.fn(async () => [1, 60_000] as [number, number]);
      });
    }

    vi.doMock('ioredis', () => ({ default: MockRedis }));
    try {
      const resolved = await createRateLimitStoreFromRuntime(
        {}, // ← 不指定 store，期望 engine 自动切到 redis
        { url: 'redis://127.0.0.1:6379' }
      );
      expect(resolved.backend).toBe('redis');
    } finally {
      vi.doUnmock('ioredis');
    }
  });

  it("store='redis' + runtime.redis 时创建 Redis backend 并透传 keyPrefix", async () => {
    const clients: unknown[][] = [];
    class MockRedis {
      isrRateLimitIncr?: (key: string, windowMs: number) => Promise<[number, number]>;

      constructor(...args: unknown[]) {
        clients.push(args);
      }

      on = vi.fn();
      incr = vi.fn();
      pexpire = vi.fn();
      pttl = vi.fn();
      defineCommand = vi.fn(() => {
        this.isrRateLimitIncr = vi.fn(async () => [1, 60_000] as [number, number]);
      });
    }

    vi.doMock('ioredis', () => ({ default: MockRedis }));
    try {
      const resolved = await createRateLimitStoreFromRuntime(
        { store: 'redis', keyPrefix: 'novel:rl:' },
        { url: 'redis://127.0.0.1:6379', keyPrefix: 'novel:' }
      );
      expect(resolved.backend).toBe('redis');
      expect(clients[0]?.[0]).toBe('redis://127.0.0.1:6379');
      expect(clients[0]?.[1]).toMatchObject({ keyPrefix: 'novel:rl:' });
      await expect(resolved.store.incr('ip:1', 60_000)).resolves.toEqual({
        count: 1,
        resetMs: 60_000,
      });
    } finally {
      vi.doUnmock('ioredis');
    }
  });
});
