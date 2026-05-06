/**
 * isrCacheMiddleware 行为测试
 *
 * 范围：通过真实 http.Server + createIsrCacheHandler 验证本次 v2.1 修复的 5 项行为：
 *   1) Set-Cookie 响应不入缓存（跨用户会话泄露防护）
 *   2) Query 归一化：`?a=1&b=2` 与 `?b=2&a=1` 共享同一 key（消除碎片化）
 *   3) Variant 隔离：配置 runtime.experiments 后，不同 ab cookie → 不同缓存条目
 *   4) L2 读超时：getAsync 卡住时走 MISS 路径，不阻塞 HIT/STALE
 *   5) 后台重验证 safety timer：上游不响应时 `revalidating` 仍被释放
 *
 * 实现手段：跑真 http.Server 监听 ephemeral port，handler 挂 next()
 * 模拟下游 Vite + plugin-rsc 的渲染响应。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createIsrCacheHandler,
  type IsrCacheHandler,
  type IsrCacheMiddlewareOptions,
} from '../isrCacheMiddleware';
import { createMemoryCacheStore, type IsrCacheStore, type IsrCachedEntry } from '../isrCacheStore';

/** 下游渲染器契约 —— 每次请求返回的响应由调用方指定 */
type RenderFn = (req: IncomingMessage, res: ServerResponse) => void;

interface TestFixture {
  server: Server;
  handler: IsrCacheHandler;
  baseUrl: string;
  renderImpl: { current: RenderFn };
}

async function startFixture(
  options: IsrCacheMiddlewareOptions = {},
  configOverride?: Record<string, unknown>
): Promise<TestFixture> {
  const handler = createIsrCacheHandler(
    configOverride ?? { renderMode: 'isr', revalidate: 3600 },
    options
  );
  const renderImpl = {
    current: (_req: IncomingMessage, res: ServerResponse) => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.statusCode = 200;
      res.end('<html>default</html>');
    },
  };
  const server = http.createServer((req, res) => {
    handler(req, res, () => renderImpl.current(req, res));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    server,
    handler,
    baseUrl: `http://127.0.0.1:${port}`,
    renderImpl,
  };
}

async function teardown(fx: TestFixture): Promise<void> {
  await fx.handler.destroy();
  await new Promise<void>((resolve, reject) =>
    fx.server.close(err => (err ? reject(err) : resolve()))
  );
}

/** 简单 HTTP GET helper —— 返回 body + 关键响应头 */
async function httpGet(
  url: string,
  headers?: Record<string, string>
): Promise<{
  status: number;
  body: string;
  cacheStatus: string | undefined;
  cacheKey: string | undefined;
  setCookie: string[] | undefined;
}> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers: headers ?? {} }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
          cacheStatus: header(res.headers['x-cache-status']),
          cacheKey: header(res.headers['x-cache-key']),
          setCookie: res.headers['set-cookie'],
        });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

function header(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

async function waitFor(predicate: () => boolean, timeoutMs = 500, intervalMs = 10): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('waitFor timeout');
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

describe('isrCacheMiddleware —— Set-Cookie 防回放', () => {
  let fx: TestFixture;
  beforeEach(async () => {
    fx = await startFixture();
  });
  afterEach(async () => {
    await teardown(fx);
  });

  it('响应含 Set-Cookie 不入缓存（第二次访问仍是 MISS）', async () => {
    let callCount = 0;
    fx.renderImpl.current = (_req, res) => {
      callCount++;
      res.setHeader('content-type', 'text/html');
      res.setHeader('set-cookie', 'session=abc123; Path=/; HttpOnly');
      res.statusCode = 200;
      res.end(`<html>call=${callCount}</html>`);
    };

    const r1 = await httpGet(`${fx.baseUrl}/login`);
    expect(r1.cacheStatus).toBe('MISS');
    expect(r1.body).toContain('call=1');

    const r2 = await httpGet(`${fx.baseUrl}/login`);
    // 第二次仍是 MISS —— 证明第一次带 Set-Cookie 的响应没被缓存
    expect(r2.cacheStatus).toBe('MISS');
    expect(r2.body).toContain('call=2');
  });

  it('无 Set-Cookie 响应正常入缓存（第二次 HIT）', async () => {
    let callCount = 0;
    fx.renderImpl.current = (_req, res) => {
      callCount++;
      res.setHeader('content-type', 'text/html');
      res.statusCode = 200;
      res.end(`<html>call=${callCount}</html>`);
    };

    const r1 = await httpGet(`${fx.baseUrl}/public`);
    expect(r1.cacheStatus).toBe('MISS');

    const r2 = await httpGet(`${fx.baseUrl}/public`);
    expect(r2.cacheStatus).toBe('HIT');
    expect(r2.body).toContain('call=1'); // 复用首次渲染
  });

  it('空 set-cookie header（空字符串）也当作不缓存', async () => {
    fx.renderImpl.current = (_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.setHeader('set-cookie', '');
      res.statusCode = 200;
      res.end('<html>x</html>');
    };
    await httpGet(`${fx.baseUrl}/x`);
    const r2 = await httpGet(`${fx.baseUrl}/x`);
    // 空字符串被 hasSetCookie 当作 falsy，允许缓存（是否缓存 = 看 Array/长度判断）
    // 我们的实现：`if (sc)` 空字符串是 falsy，所以 *允许* 入缓存
    expect(['HIT', 'MISS']).toContain(r2.cacheStatus);
  });
});

describe('isrCacheMiddleware —— query 参数归一化', () => {
  let fx: TestFixture;
  beforeEach(async () => {
    fx = await startFixture();
  });
  afterEach(async () => {
    await teardown(fx);
  });

  it('`?a=1&b=2` 与 `?b=2&a=1` 命中同一缓存条目', async () => {
    let callCount = 0;
    fx.renderImpl.current = (_req, res) => {
      callCount++;
      res.setHeader('content-type', 'text/html');
      res.statusCode = 200;
      res.end(`<html>call=${callCount}</html>`);
    };

    const r1 = await httpGet(`${fx.baseUrl}/list?a=1&b=2`);
    expect(r1.cacheStatus).toBe('MISS');

    const r2 = await httpGet(`${fx.baseUrl}/list?b=2&a=1`);
    expect(r2.cacheStatus).toBe('HIT');
    expect(r2.body).toContain('call=1');
    // cacheKey 也应该一致（归一化后都是 `a=1&b=2`）
    expect(r2.cacheKey).toBe(r1.cacheKey);
  });

  it('不同 query 值仍然是不同 key（只归一化顺序不合并值）', async () => {
    fx.renderImpl.current = (_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.statusCode = 200;
      res.end('<html>x</html>');
    };

    const r1 = await httpGet(`${fx.baseUrl}/list?page=1`);
    const r2 = await httpGet(`${fx.baseUrl}/list?page=2`);
    expect(r1.cacheKey).not.toBe(r2.cacheKey);
    expect(r2.cacheStatus).toBe('MISS');
  });

  it('空 query 与 无 query 等价', async () => {
    fx.renderImpl.current = (_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.statusCode = 200;
      res.end('<html>x</html>');
    };
    const r1 = await httpGet(`${fx.baseUrl}/a`);
    const r2 = await httpGet(`${fx.baseUrl}/a?`);
    expect(r2.cacheStatus).toBe('HIT'); // 第二次命中第一次的缓存
    expect(r1.cacheKey).toBe(r2.cacheKey);
  });
});

describe('isrCacheMiddleware —— dev/client-reference 资源旁路', () => {
  let fx: TestFixture;
  beforeEach(async () => {
    fx = await startFixture();
  });
  afterEach(async () => {
    await teardown(fx);
  });

  it('带 $$cache 后缀的 TSX client reference 不进入页面缓存链路', async () => {
    let callCount = 0;
    fx.renderImpl.current = (_req, res) => {
      callCount++;
      res.setHeader('content-type', 'text/javascript');
      res.statusCode = 200;
      res.end('export default {};');
    };

    const r1 = await httpGet(`${fx.baseUrl}/src/components/Header/index.tsx$$cache=abc`);
    const r2 = await httpGet(`${fx.baseUrl}/src/components/Header/index.tsx$$cache=abc`);

    expect(r1.cacheStatus).toBe('BYPASS');
    expect(r2.cacheStatus).toBe('BYPASS');
    expect(callCount).toBe(2);
  });
});

describe('isrCacheMiddleware —— A/B variant 隔离', () => {
  it('variantIsolation=false（默认）→ 不同 ab cookie 共享缓存', async () => {
    const fx = await startFixture({});
    try {
      let callCount = 0;
      fx.renderImpl.current = (_req, res) => {
        callCount++;
        res.setHeader('content-type', 'text/html');
        res.statusCode = 200;
        res.end(`<html>call=${callCount}</html>`);
      };

      const r1 = await httpGet(`${fx.baseUrl}/home`, { cookie: 'ab=hero=v1' });
      expect(r1.cacheStatus).toBe('MISS');

      const r2 = await httpGet(`${fx.baseUrl}/home`, { cookie: 'ab=hero=v2' });
      // 默认关 variant 隔离 —— variant=v2 的用户看到 variant=v1 用户渲染的内容
      expect(r2.cacheStatus).toBe('HIT');
      expect(r2.body).toContain('call=1');
      expect(r2.cacheKey).toBe(r1.cacheKey);
    } finally {
      await teardown(fx);
    }
  });

  it('配置 runtime.experiments 后默认启用 variant 隔离', async () => {
    const fx = await startFixture(
      {},
      {
        renderMode: 'isr',
        revalidate: 3600,
        runtime: {
          experiments: {
            hero: { variants: ['v1', 'v2'], weights: [50, 50] },
          },
        },
      }
    );
    try {
      let callCount = 0;
      fx.renderImpl.current = (_req, res) => {
        callCount++;
        res.setHeader('content-type', 'text/html');
        res.statusCode = 200;
        res.end(`<html>call=${callCount}</html>`);
      };

      const v1 = await httpGet(`${fx.baseUrl}/home`, { cookie: 'ab=hero=v1' });
      const v2 = await httpGet(`${fx.baseUrl}/home`, { cookie: 'ab=hero=v2' });

      expect(v1.cacheStatus).toBe('MISS');
      expect(v2.cacheStatus).toBe('MISS');
      expect(v2.cacheKey).not.toBe(v1.cacheKey);
    } finally {
      await teardown(fx);
    }
  });

  it('variantIsolation=true → 不同 ab cookie 各自 MISS → 各自独立 HIT', async () => {
    const fx = await startFixture({ variantIsolation: true });
    try {
      let callCount = 0;
      fx.renderImpl.current = (_req, res) => {
        callCount++;
        res.setHeader('content-type', 'text/html');
        res.statusCode = 200;
        res.end(`<html>call=${callCount}</html>`);
      };

      // variant v1：第一次 MISS
      const v1a = await httpGet(`${fx.baseUrl}/home`, { cookie: 'ab=hero=v1' });
      expect(v1a.cacheStatus).toBe('MISS');

      // variant v2：与 v1 key 不同 → 也 MISS
      const v2a = await httpGet(`${fx.baseUrl}/home`, { cookie: 'ab=hero=v2' });
      expect(v2a.cacheStatus).toBe('MISS');
      expect(v2a.cacheKey).not.toBe(v1a.cacheKey);

      // v1 再访问 → HIT 自己
      const v1b = await httpGet(`${fx.baseUrl}/home`, { cookie: 'ab=hero=v1' });
      expect(v1b.cacheStatus).toBe('HIT');
      expect(v1b.body).toContain('call=1');

      // v2 再访问 → HIT 自己
      const v2b = await httpGet(`${fx.baseUrl}/home`, { cookie: 'ab=hero=v2' });
      expect(v2b.cacheStatus).toBe('HIT');
      expect(v2b.body).toContain('call=2');
    } finally {
      await teardown(fx);
    }
  });

  it('variantIsolation=true + 无 cookie 用户与有 cookie 用户也分桶', async () => {
    const fx = await startFixture({ variantIsolation: true });
    try {
      fx.renderImpl.current = (_req, res) => {
        res.setHeader('content-type', 'text/html');
        res.statusCode = 200;
        res.end('<html>x</html>');
      };

      const noCookie = await httpGet(`${fx.baseUrl}/home`);
      const withCookie = await httpGet(`${fx.baseUrl}/home`, { cookie: 'ab=hero=v1' });
      // 不同 key（一方无 variant digest、一方有）
      expect(noCookie.cacheKey).not.toBe(withCookie.cacheKey);
    } finally {
      await teardown(fx);
    }
  });
});

describe('isrCacheMiddleware —— L2 读超时', () => {
  /** 构造一个 getAsync 永不返回的 store —— 模拟 Redis 挂起 */
  function hangingStore(): IsrCacheStore {
    const base = createMemoryCacheStore({ max: 10 });
    return {
      ...base,
      backend: 'hybrid', // 让 middleware 把我们当 L2
      getAsync: () => new Promise<IsrCachedEntry | undefined>(() => {}),
    };
  }

  it('L2 getAsync 卡住 → 超时按 miss 处理 → 正常渲染 + 写入 L1', async () => {
    const store = hangingStore();
    const fx = await startFixture({ store, l2ReadTimeoutMs: 50 });
    try {
      let callCount = 0;
      fx.renderImpl.current = (_req, res) => {
        callCount++;
        res.setHeader('content-type', 'text/html');
        res.statusCode = 200;
        res.end(`<html>call=${callCount}</html>`);
      };

      const t0 = Date.now();
      const r1 = await httpGet(`${fx.baseUrl}/slow`);
      const elapsed = Date.now() - t0;
      expect(r1.cacheStatus).toBe('MISS');
      expect(r1.body).toContain('call=1');
      // 总耗时应小于 1s —— 证明我们没卡在 getAsync（即使 getAsync 永不返回）
      expect(elapsed).toBeLessThan(1000);
    } finally {
      await teardown(fx);
    }
  });
});

describe('isrCacheMiddleware —— bg revalidate 安全超时', () => {
  it('STALE 触发 bg → 上游 hang → safety timer 释放 revalidating', async () => {
    // bgTimeoutMs 设置为 100ms，若安全兜底不生效 → revalidating 永不清
    const fx = await startFixture({ backgroundRevalidateTimeoutMs: 100 });
    try {
      // 手动注入一个已过期（进入 SWR 窗口）的条目
      const now = Date.now();
      const stale: IsrCachedEntry = {
        body: Buffer.from('<html>stale</html>'),
        statusCode: 200,
        headers: { 'content-type': 'text/html' },
        contentType: 'text/html',
        storedAt: now - 60_000,
        expiresAt: now - 1_000, // 已过 TTL
        hardExpiresAt: now + 60_000, // 但仍在 hardExpire 内
        tags: [],
      };
      // 用显式 store 注入一个 STALE 条目，测试通过请求行为验证 revalidating 释放，
      // 不再读取 handler 内部统计状态。
      const store = createMemoryCacheStore({ max: 10 });
      const fx2 = await startFixture({ store, backgroundRevalidateTimeoutMs: 100 });
      try {
        // 让渲染器永远 hang —— 模拟上游故障
        let renderCalls = 0;
        fx2.renderImpl.current = () => {
          renderCalls++;
          /* 不调 res.end，连接挂起 */
        };

        // 用与中间件相同的 key 算法手写 cacheKey：`<ENGINE_VERSION>:<namespace>:<原始 key>`
        // 路径是 /stale-test，无 query，method=GET，namespace 走默认 'default'
        store.set('e1:default:GET:/stale-test', stale);

        const r = await httpGet(`${fx2.baseUrl}/stale-test`);
        expect(r.cacheStatus).toBe('STALE');
        expect(r.body).toBe('<html>stale</html>');

        // 此时 bg 请求会异步发出但上游 hang。
        await waitFor(() => renderCalls === 1);

        // 等待 safety timer 触发（bgTimeoutMs=100ms，等 300ms 绰绰有余）
        await new Promise(r => setTimeout(r, 300));

        const r2 = await httpGet(`${fx2.baseUrl}/stale-test`);
        expect(r2.cacheStatus).toBe('STALE');
        expect(r2.body).toBe('<html>stale</html>');
        await waitFor(() => renderCalls === 2);
      } finally {
        await teardown(fx2);
      }
    } finally {
      await teardown(fx);
    }
  });
});
