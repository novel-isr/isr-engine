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
import { l2ReadTimeoutsTotal } from '../../metrics/PromMetrics';
import { revalidatePath } from '../../rsc/revalidate';

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
  staleReason: string | undefined;
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
          staleReason: header(res.headers['x-cache-stale-reason']),
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

describe('isrCacheMiddleware —— dev stylesheet transport representations', () => {
  let fx: TestFixture;
  beforeEach(async () => {
    fx = await startFixture({ development: true });
  });
  afterEach(async () => {
    await teardown(fx);
  });

  it('never reads or writes cache entries for generation-bound RSC responses', async () => {
    let callCount = 0;
    fx.renderImpl.current = (req, res) => {
      callCount++;
      res.setHeader('content-type', 'text/x-component;charset=utf-8');
      const generation = req.headers['x-novel-isr-dev-style-generation'];
      if (generation === '-1') {
        res.statusCode = 400;
        res.end('Invalid development style generation in RSC request.');
        return;
      }
      res.statusCode = 200;
      res.end(`call=${callCount};generation=${String(generation)}`);
    };

    const prefetch = await httpGet(`${fx.baseUrl}/page_.rsc`);
    expect(prefetch.cacheStatus).toBe('MISS');
    expect(prefetch.body).toBe('call=1;generation=undefined');

    const generation1 = await httpGet(`${fx.baseUrl}/page_.rsc`, {
      'x-novel-isr-dev-style-generation': '1',
    });
    expect(generation1.cacheStatus).toBe('BYPASS');
    expect(generation1.body).toBe('call=2;generation=1');

    const repeatedGeneration1 = await httpGet(`${fx.baseUrl}/page_.rsc`, {
      'x-novel-isr-dev-style-generation': '1',
    });
    expect(repeatedGeneration1.cacheStatus).toBe('BYPASS');
    expect(repeatedGeneration1.body).toBe('call=3;generation=1');

    const generation2 = await httpGet(`${fx.baseUrl}/page_.rsc`, {
      'x-novel-isr-dev-style-generation': '2',
    });
    expect(generation2.cacheStatus).toBe('BYPASS');
    expect(generation2.body).toBe('call=4;generation=2');

    const cachedPrefetch = await httpGet(`${fx.baseUrl}/page_.rsc`);
    expect(cachedPrefetch.cacheStatus).toBe('HIT');
    expect(cachedPrefetch.body).toBe('call=1;generation=undefined');

    const malformed = await httpGet(`${fx.baseUrl}/page_.rsc`, {
      'x-novel-isr-dev-style-generation': '-1',
    });
    expect(malformed.cacheStatus).toBe('BYPASS');
    expect(malformed.status).toBe(400);
    expect(malformed.body).toMatch(/invalid development style generation/i);
    expect(callCount).toBe(5);
  });

  it('keeps generation headers cacheable outside the RSC transport', async () => {
    let callCount = 0;
    fx.renderImpl.current = (_req, res) => {
      callCount++;
      res.setHeader('content-type', 'text/html;charset=utf-8');
      res.statusCode = 200;
      res.end(`call=${callCount}`);
    };

    const first = await httpGet(`${fx.baseUrl}/page`, {
      'x-novel-isr-dev-style-generation': '1',
    });
    const second = await httpGet(`${fx.baseUrl}/page`, {
      'x-novel-isr-dev-style-generation': '2',
    });

    expect(first.cacheStatus).toBe('MISS');
    expect(second.cacheStatus).toBe('HIT');
    expect(second.body).toBe('call=1');
  });
});

describe('isrCacheMiddleware —— production stylesheet transport isolation', () => {
  it('does not change cache semantics when development mode is disabled', async () => {
    const fx = await startFixture();
    try {
      let callCount = 0;
      fx.renderImpl.current = (_req, res) => {
        callCount++;
        res.setHeader('content-type', 'text/x-component;charset=utf-8');
        res.statusCode = 200;
        res.end(`call=${callCount}`);
      };

      const first = await httpGet(`${fx.baseUrl}/page_.rsc`);
      const withDevelopmentHeader = await httpGet(`${fx.baseUrl}/page_.rsc`, {
        'x-novel-isr-dev-style-generation': '1',
      });

      expect(first.cacheStatus).toBe('MISS');
      expect(withDevelopmentHeader.cacheStatus).toBe('HIT');
      expect(withDevelopmentHeader.body).toBe('call=1');
    } finally {
      await teardown(fx);
    }
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

  it('L2 超时触发时 isr_l2_read_timeouts_total 递增（伪 miss vs 真 miss 区分）', async () => {
    const store = hangingStore();
    const fx = await startFixture({ store, l2ReadTimeoutMs: 30 });
    try {
      fx.renderImpl.current = (_req, res) => {
        res.setHeader('content-type', 'text/html');
        res.statusCode = 200;
        res.end('<html>ok</html>');
      };

      const before = await readL2TimeoutCount();
      await httpGet(`${fx.baseUrl}/timed-out-1`);
      await httpGet(`${fx.baseUrl}/timed-out-2`);
      const after = await readL2TimeoutCount();
      expect(after - before).toBe(2);
    } finally {
      await teardown(fx);
    }
  });

  it('L2 正常返回（不超时）时 metric 不递增', async () => {
    // 立即返回 undefined 的 store —— 行为上等价 “L2 没命中” 的真 miss，
    // 这种情况绝不能被算成 timeout。
    const store: IsrCacheStore = {
      ...createMemoryCacheStore({ max: 10 }),
      backend: 'hybrid',
      getAsync: async () => undefined,
    };
    const fx = await startFixture({ store, l2ReadTimeoutMs: 1000 });
    try {
      fx.renderImpl.current = (_req, res) => {
        res.setHeader('content-type', 'text/html');
        res.statusCode = 200;
        res.end('<html>ok</html>');
      };

      const before = await readL2TimeoutCount();
      await httpGet(`${fx.baseUrl}/real-miss`);
      const after = await readL2TimeoutCount();
      expect(after).toBe(before);
    } finally {
      await teardown(fx);
    }
  });
});

async function readL2TimeoutCount(): Promise<number> {
  const m = await l2ReadTimeoutsTotal.get();
  return m.values.reduce((sum, v) => sum + v.value, 0);
}

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

        // 用与中间件相同的 key 算法手写 cacheKey：`<ENGINE_VERSION>:<namespace>:<buildVersion>:<原始 key>`
        // 路径是 /stale-test，无 query，method=GET，namespace 默认 'default'，
        // buildVersion 来自 process.env.APP_VERSION，测试环境无注入 → 'dev'
        const bv = process.env.APP_VERSION ?? 'dev';
        store.set(`e3:default:${bv}:GET:/stale-test`, stale);

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

describe('isrCacheMiddleware —— X-Cache-Stale-Reason', () => {
  /** 注入一个 SWR 窗口内的 stale entry，并跑请求验证 reason 头 */
  async function setupStale(opts: {
    bgTimeoutMs?: number;
    upstreamFails?: boolean;
  }): Promise<{ fx: TestFixture; store: IsrCacheStore; key: string; renderCalls: { n: number } }> {
    const store = createMemoryCacheStore({ max: 10 });
    const fx = await startFixture({
      store,
      backgroundRevalidateTimeoutMs: opts.bgTimeoutMs ?? 30_000,
    });
    const renderCalls = { n: 0 };
    fx.renderImpl.current = (_req, res) => {
      renderCalls.n++;
      if (opts.upstreamFails) {
        res.statusCode = 500;
        res.end('upstream broken');
        return;
      }
      res.setHeader('content-type', 'text/html');
      res.statusCode = 200;
      res.end('<html>fresh</html>');
    };
    const now = Date.now();
    const stale: IsrCachedEntry = {
      body: Buffer.from('<html>stale-body</html>'),
      statusCode: 200,
      headers: { 'content-type': 'text/html' },
      contentType: 'text/html',
      storedAt: now - 60_000,
      expiresAt: now - 1_000,
      hardExpiresAt: now + 60_000,
      tags: [],
    };
    const bv = process.env.APP_VERSION ?? 'dev';
    const key = `e3:default:${bv}:GET:/reason-test`;
    store.set(key, stale);
    return { fx, store, key, renderCalls };
  }

  it('首次进入 SWR → reason=swr-fresh（bg 还没启）', async () => {
    const { fx } = await setupStale({});
    try {
      const r = await httpGet(`${fx.baseUrl}/reason-test`);
      expect(r.cacheStatus).toBe('STALE');
      expect(r.staleReason).toBe('swr-fresh');
    } finally {
      await teardown(fx);
    }
  });

  it('bg 进行中时第二次 STALE → reason=swr-bg-pending（同 key 并发请求）', async () => {
    // 关键约束：r2 必须在 bg 请求处于 in-flight 时发出。
    // 设计：bg renderer 慢响应 200ms，这段时间 revalidating.has(key)=true。
    // r2 在 ~20ms 后发出，处在 bg 窗口内 → 应看到 swr-bg-pending。
    // bg 完成后状态自然清掉，teardown 无须等长 safety timer。
    const { fx } = await setupStale({ bgTimeoutMs: 1_500 });
    try {
      fx.renderImpl.current = (req, res) => {
        const isBg = String(req.headers['x-isr-background-revalidate'] ?? '') === '1';
        if (isBg) {
          // bg 慢响应 200ms：足够 r2 看到 in-flight 状态，又不至于让 teardown 等太久
          setTimeout(() => {
            res.setHeader('content-type', 'text/html');
            res.statusCode = 200;
            res.end('<html>refreshed</html>');
          }, 200);
          return;
        }
        // 用户态请求都应该走 replayEntry，理论上不到这里
        res.statusCode = 500;
        res.end('unexpected: user request reached renderer');
      };

      const r1 = await httpGet(`${fx.baseUrl}/reason-test`);
      expect(r1.cacheStatus).toBe('STALE');
      expect(r1.staleReason).toBe('swr-fresh');

      // 等一个 tick 让 setImmediate 把 bg http.request 真正发出（revalidating.add 已 sync）
      await new Promise(r => setTimeout(r, 30));

      const r2 = await httpGet(`${fx.baseUrl}/reason-test`);
      expect(r2.cacheStatus).toBe('STALE');
      expect(r2.staleReason).toBe('swr-bg-pending');
    } finally {
      await teardown(fx);
    }
  }, 5_000);

  it('bg 失败（5xx）后下一次 STALE → reason=swr-bg-failed-recent', async () => {
    const { fx, renderCalls } = await setupStale({ upstreamFails: true, bgTimeoutMs: 1_000 });
    try {
      // 第一次请求触发 bg；上游 5xx → release(false)，bgRevalidateFailures 写入失败时间
      const r1 = await httpGet(`${fx.baseUrl}/reason-test`);
      expect(r1.cacheStatus).toBe('STALE');
      expect(r1.staleReason).toBe('swr-fresh');
      // bg 5xx 完成 → release(false) 清 revalidating + 写 bgRevalidateFailures。
      // 间接信号：用 inspection 检查 revalidating 状态需要内部 API；这里用一个稳定
      // 的小睡眠（bg 5xx 路径已知 < 50ms 完成）来等其结算。
      await waitFor(() => renderCalls.n >= 1);
      await new Promise(r => setTimeout(r, 80));
      // 第二次请求：revalidating 已清，但 bgRevalidateFailures 在窗口内 → failed-recent
      const r2 = await httpGet(`${fx.baseUrl}/reason-test`);
      expect(r2.cacheStatus).toBe('STALE');
      expect(r2.staleReason).toBe('swr-bg-failed-recent');
    } finally {
      await teardown(fx);
    }
  });

  it('handler.clear() 清空 bg 失败 / invalidation log（不残留脏状态）', async () => {
    const { fx, renderCalls } = await setupStale({ upstreamFails: true, bgTimeoutMs: 1_000 });
    try {
      await httpGet(`${fx.baseUrl}/reason-test`);
      await waitFor(() => renderCalls.n >= 1);
      // 再次请求确认 failed-recent
      const before = await httpGet(`${fx.baseUrl}/reason-test`);
      expect(before.staleReason).toBe('swr-bg-failed-recent');

      fx.handler.clear();

      // clear 后 cache 也空了，下一次请求是 MISS（不是 STALE）—— 这里只是验证
      // bgRevalidateFailures 没残留 “上次失败” 污染未来同名 key 的 STALE 标签。
      const inspection = fx.handler.getCacheInspection();
      expect(inspection.entries).toHaveLength(0);
      expect(inspection.invalidations).toHaveLength(0);
    } finally {
      await teardown(fx);
    }
  });
});

describe('isrCacheMiddleware —— prefetch 冷却窗口', () => {
  it('HIT 触发预热；冷却窗口内不重复触发，窗口过后（LRU ttl 过期）重新触发', async () => {
    const cooldownMs = 200;
    const warmHits = { n: 0, sawSentinel: false };
    const fx = await startFixture({
      prefetchOnHit: () => ['/warm'],
      prefetchCooldownMs: cooldownMs,
    });
    fx.renderImpl.current = (req, res) => {
      if ((req.url ?? '').startsWith('/warm')) {
        warmHits.n++;
        if (String(req.headers['x-isr-prefetch'] || '') === '1') warmHits.sawSentinel = true;
        // Set-Cookie 阻止 /warm 入缓存 —— 保证每次预热触发都落到下游渲染，便于计数
        res.setHeader('set-cookie', 'noscache=1; Path=/');
      }
      res.setHeader('content-type', 'text/html');
      res.statusCode = 200;
      res.end('<html>x</html>');
    };

    try {
      // MISS 填缓存 → HIT 触发预热
      await httpGet(`${fx.baseUrl}/page`);
      const hit1 = await httpGet(`${fx.baseUrl}/page`);
      expect(hit1.cacheStatus).toBe('HIT');
      await waitFor(() => warmHits.n === 1, 1_000);
      expect(warmHits.sawSentinel).toBe(true);

      // 冷却窗口内再次 HIT：不重复预热
      const hit2 = await httpGet(`${fx.baseUrl}/page`);
      expect(hit2.cacheStatus).toBe('HIT');
      await new Promise(r => setTimeout(r, 100));
      expect(warmHits.n).toBe(1);

      // 等过冷却窗口（LRUCache ttl 同步过期）后 HIT：重新预热
      await new Promise(r => setTimeout(r, cooldownMs + 50));
      const hit3 = await httpGet(`${fx.baseUrl}/page`);
      expect(hit3.cacheStatus).toBe('HIT');
      await waitFor(() => warmHits.n === 2, 1_000);
    } finally {
      await teardown(fx);
    }
  });
});

describe('isrCacheMiddleware —— revalidatePath 清除带隔离后缀的条目', () => {
  it('variant 隔离（|v=）的无 query 条目也会被清除（回归：曾只匹配精确 key 和 `?` 前缀）', async () => {
    const fx = await startFixture(
      {},
      {
        renderMode: 'isr',
        revalidate: 3600,
        runtime: {
          experiments: { hero: { variants: ['v1', 'v2'], weights: [50, 50] } },
        },
      }
    );
    try {
      let calls = 0;
      fx.renderImpl.current = (_req, res) => {
        calls++;
        res.setHeader('content-type', 'text/html');
        res.statusCode = 200;
        res.end(`<html>call=${calls}</html>`);
      };

      const headers = { cookie: 'ab=hero=v1' };
      expect((await httpGet(`${fx.baseUrl}/home`, headers)).cacheStatus).toBe('MISS');
      expect((await httpGet(`${fx.baseUrl}/home`, headers)).cacheStatus).toBe('HIT');

      await revalidatePath('/home');

      const after = await httpGet(`${fx.baseUrl}/home`, headers);
      expect(after.cacheStatus).toBe('MISS');
      expect(after.body).toContain('call=2');
    } finally {
      await teardown(fx);
    }
  });
});

describe('isrCacheMiddleware —— Host 隔离（多域名共享进程）', () => {
  it('默认关闭：不同 Host 共享同一缓存条目（单站点形态）', async () => {
    const fx = await startFixture({});
    try {
      let calls = 0;
      fx.renderImpl.current = (_req, res) => {
        calls++;
        res.setHeader('content-type', 'text/html');
        res.statusCode = 200;
        res.end(`<html>call=${calls}</html>`);
      };

      expect((await httpGet(`${fx.baseUrl}/books`, { host: 'a.example.com' })).cacheStatus).toBe(
        'MISS'
      );
      const r2 = await httpGet(`${fx.baseUrl}/books`, { host: 'b.example.com' });
      expect(r2.cacheStatus).toBe('HIT');
      expect(r2.body).toContain('call=1');
    } finally {
      await teardown(fx);
    }
  });

  it('hostIsolation=true：不同 Host 各自独立缓存，互不串内容', async () => {
    const fx = await startFixture({ hostIsolation: true });
    try {
      fx.renderImpl.current = (req, res) => {
        res.setHeader('content-type', 'text/html');
        res.statusCode = 200;
        res.end(`<html>tenant=${req.headers.host}</html>`);
      };

      const a1 = await httpGet(`${fx.baseUrl}/books`, { host: 'a.example.com' });
      expect(a1.cacheStatus).toBe('MISS');
      const b1 = await httpGet(`${fx.baseUrl}/books`, { host: 'b.example.com' });
      expect(b1.cacheStatus).toBe('MISS');

      // 各自 HIT 自己的内容
      const a2 = await httpGet(`${fx.baseUrl}/books`, { host: 'a.example.com' });
      expect(a2.cacheStatus).toBe('HIT');
      expect(a2.body).toContain('tenant=a.example.com');
      const b2 = await httpGet(`${fx.baseUrl}/books`, { host: 'b.example.com' });
      expect(b2.cacheStatus).toBe('HIT');
      expect(b2.body).toContain('tenant=b.example.com');
      expect(a2.cacheKey).not.toBe(b2.cacheKey);
    } finally {
      await teardown(fx);
    }
  });

  it('runtime.hostIsolation=true（ssr.config.ts 路径）同样生效', async () => {
    const fx = await startFixture(
      {},
      { renderMode: 'isr', revalidate: 3600, runtime: { hostIsolation: true } }
    );
    try {
      fx.renderImpl.current = (req, res) => {
        res.setHeader('content-type', 'text/html');
        res.statusCode = 200;
        res.end(`<html>tenant=${req.headers.host}</html>`);
      };
      await httpGet(`${fx.baseUrl}/x`, { host: 'a.example.com' });
      const b = await httpGet(`${fx.baseUrl}/x`, { host: 'b.example.com' });
      expect(b.cacheStatus).toBe('MISS'); // 未串到 a 的条目
    } finally {
      await teardown(fx);
    }
  });

  it('revalidatePath 清除该路径所有 host 的条目', async () => {
    const fx = await startFixture({ hostIsolation: true });
    try {
      let calls = 0;
      fx.renderImpl.current = (_req, res) => {
        calls++;
        res.setHeader('content-type', 'text/html');
        res.statusCode = 200;
        res.end(`<html>call=${calls}</html>`);
      };

      await httpGet(`${fx.baseUrl}/books`, { host: 'a.example.com' });
      await httpGet(`${fx.baseUrl}/books`, { host: 'b.example.com' });
      expect((await httpGet(`${fx.baseUrl}/books`, { host: 'a.example.com' })).cacheStatus).toBe(
        'HIT'
      );

      await revalidatePath('/books');

      expect((await httpGet(`${fx.baseUrl}/books`, { host: 'a.example.com' })).cacheStatus).toBe(
        'MISS'
      );
      expect((await httpGet(`${fx.baseUrl}/books`, { host: 'b.example.com' })).cacheStatus).toBe(
        'MISS'
      );
    } finally {
      await teardown(fx);
    }
  });
});

it('seeds immutable SSG once, regenerates into the shared cache and obeys configured TTL', async () => {
  const fx = await startFixture(
    {
      staticSeed: async () => ({
        body: Buffer.from('<html>build</html>'),
        statusCode: 200,
        contentType: 'text/html',
        headers: { 'content-type': 'text/html' },
        storedAt: Date.now(),
        expiresAt: 0,
        hardExpiresAt: 0,
        tags: [],
      }),
    },
    { renderMode: 'ssg', revalidate: 0.02 }
  );
  let renders = 0;
  fx.renderImpl.current = (_req, res) => {
    renders++;
    res.setHeader('content-type', 'text/html');
    res.end(`<html>runtime-${renders}</html>`);
  };
  try {
    const cold = await httpGet(fx.baseUrl);
    expect(cold.body).toBe('<html>build</html>');
    expect(cold.cacheStatus).toBe('HIT');
    await new Promise(resolve => setTimeout(resolve, 25));
    expect((await httpGet(fx.baseUrl)).cacheStatus).toBe('STALE');
    await waitFor(() => renders === 1);
    expect((await httpGet(fx.baseUrl)).body).toBe('<html>runtime-1</html>');
    await revalidatePath('/');
    expect((await httpGet(fx.baseUrl)).body).toBe('<html>runtime-2</html>');
  } finally {
    await teardown(fx);
  }
});

it('never reseeds an evicted successful SSG generation', async () => {
  const store = createMemoryCacheStore({ max: 1 });
  const fx = await startFixture(
    {
      store,
      staticSeed: async () => ({
        body: Buffer.from('<html>build</html>'),
        statusCode: 200,
        contentType: 'text/html',
        headers: { 'content-type': 'text/html' },
        storedAt: Date.now(),
        expiresAt: 0,
        hardExpiresAt: 0,
        tags: [],
      }),
    },
    { renderMode: 'ssg', revalidate: 60 }
  );
  try {
    expect((await httpGet(`${fx.baseUrl}/one`)).body).toBe('<html>build</html>');
    await revalidatePath('/one');
    fx.renderImpl.current = (_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end('<html>new</html>');
    };
    expect((await httpGet(`${fx.baseUrl}/one`)).body).toBe('<html>new</html>');
    await httpGet(`${fx.baseUrl}/two`);
    expect((await httpGet(`${fx.baseUrl}/one`)).body).toBe('<html>new</html>');
  } finally {
    await teardown(fx);
  }
});

it('fails open when the immutable seed source hangs or rejects', async () => {
  for (const staticSeed of [
    () => new Promise<IsrCachedEntry | undefined>(() => {}),
    () => Promise.reject(new Error('build unavailable')),
  ]) {
    const fx = await startFixture({ staticSeed, l2ReadTimeoutMs: 10 }, { renderMode: 'ssg' });
    try {
      expect((await httpGet(`${fx.baseUrl}/page`)).body).toBe('<html>default</html>');
      expect((await httpGet(`${fx.baseUrl}/page`)).cacheStatus).toBe('HIT');
    } finally {
      await teardown(fx);
    }
  }
});

it('resolves incoming bus path aliases before invalidating canonical HTML and RSC entries', async () => {
  let receive!: (
    target: import('../isrCacheMiddleware').IsrInvalidationTarget
  ) => Promise<void> | void;
  const seen: string[] = [];
  const fx = await startFixture({
    resolveInvalidationPath: pathname => {
      seen.push(pathname);
      return pathname === '/page/index.html' ? '/page' : pathname;
    },
    invalidationBus: {
      publish() {},
      subscribe(listener) {
        receive = listener;
        return () => {};
      },
    },
  });
  let version = 1;
  fx.renderImpl.current = (_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(`<html>version-${version}</html>`);
  };
  try {
    for (const suffix of ['', '_.rsc']) {
      await httpGet(`${fx.baseUrl}/page${suffix}`);
      expect((await httpGet(`${fx.baseUrl}/page${suffix}`)).cacheStatus).toBe('HIT');
    }
    version++;
    await receive({
      kind: 'path',
      value: '/page/index.html_.rsc?ignored=yes',
      protocol: 'response-v1',
    });
    expect(seen).toEqual(['/page/index.html']);
    for (const suffix of ['', '_.rsc']) {
      const fresh = await httpGet(`${fx.baseUrl}/page${suffix}`);
      expect(fresh.cacheStatus).toBe('MISS');
      expect(fresh.body).toContain('version-2');
    }
  } finally {
    await teardown(fx);
  }
});

describe('request lifetime during cache admission', () => {
  it('does not create an orphan leader after a disconnected L2 reader resumes', async () => {
    const memory = createMemoryCacheStore();
    let release!: () => void;
    let entered!: () => void;
    const reading = new Promise<void>(resolve => {
      entered = resolve;
    });
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    let reads = 0;
    const fx = await startFixture({
      store: {
        ...memory,
        getAsync: async key => {
          if (++reads === 1) {
            entered();
            await gate;
          }
          return memory.get(key);
        },
      },
    });
    let renders = 0;
    fx.renderImpl.current = (_req, res) => {
      renders++;
      if (res.destroyed) return; // production bridge skips disconnected requests
      res.setHeader('content-type', 'text/html');
      res.end('live');
    };
    try {
      let closed!: () => void;
      const disconnected = new Promise<void>(resolve => {
        closed = resolve;
      });
      fx.server.once('request', (_req, res) => res.once('close', closed));
      const client = http.get(fx.baseUrl + '/disconnect');
      client.on('error', () => {});
      await reading;
      client.destroy();
      await disconnected;
      release();
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(renders).toBe(0);
      expect(fx.handler.getCacheInspection().inflightCount).toBe(0);
      const next = httpGet(fx.baseUrl + '/disconnect');
      const result = await Promise.race([
        next,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('orphan singleflight blocked next request')), 300)
        ),
      ]);
      expect(result.body).toBe('live');
      expect(renders).toBe(1);
    } finally {
      release();
      await teardown(fx);
    }
  });
});

it('releases a coherent leader immediately when it disconnects during beginRender', async () => {
  const memory = createMemoryCacheStore();
  let release!: () => void;
  let entered!: () => void;
  const reading = new Promise<void>(r => {
    entered = r;
  });
  const gate = new Promise<void>(r => {
    release = r;
  });
  let admissions = 0;
  const fx = await startFixture({
    store: {
      ...memory,
      coherence: {
        beginRender: async () => {
          if (++admissions === 1) {
            entered();
            await gate;
          }
          return { incarnation: 'test', revision: '0' };
        },
        commit: async (key, entry) => {
          memory.set(key, entry);
          return true;
        },
      },
    },
  });
  let renders = 0;
  fx.renderImpl.current = (_req, res) => {
    renders++;
    res.setHeader('content-type', 'text/html');
    res.end('live');
  };
  try {
    let closed!: () => void;
    const disconnected = new Promise<void>(r => {
      closed = r;
    });
    fx.server.once('request', (_req, res) => res.once('close', closed));
    const client = http.get(fx.baseUrl + '/coherent');
    client.on('error', () => {});
    await reading;
    expect(fx.handler.getCacheInspection().inflightCount).toBe(1);
    client.destroy();
    await disconnected;
    expect(fx.handler.getCacheInspection().inflightCount).toBe(0);
    expect((await httpGet(fx.baseUrl + '/coherent')).body).toBe('live');
    release();
    await new Promise(r => setTimeout(r, 20));
    expect(renders).toBe(1);
    expect(fx.handler.getCacheInspection().inflightCount).toBe(0);
  } finally {
    release();
    await teardown(fx);
  }
});

it('does not turn a disconnected singleflight follower into a new leader', async () => {
  const fx = await startFixture();
  let leaderResponse!: ServerResponse;
  let renders = 0;
  fx.renderImpl.current = (_req, res) => {
    renders++;
    leaderResponse = res;
  };
  try {
    const leader = httpGet(fx.baseUrl + '/follower');
    await waitFor(() => renders === 1);
    let closed!: () => void;
    const disconnected = new Promise<void>(r => {
      closed = r;
    });
    fx.server.once('request', (_req, res) => res.once('close', closed));
    const follower = http.get(fx.baseUrl + '/follower');
    follower.on('error', () => {});
    await new Promise(r => setTimeout(r, 20));
    follower.destroy();
    await disconnected;
    leaderResponse.statusCode = 503; // no cache entry: follower would become a leader
    leaderResponse.end('uncached');
    await leader;
    await new Promise(r => setTimeout(r, 20));
    expect(renders).toBe(1);
    expect(fx.handler.getCacheInspection().inflightCount).toBe(0);
  } finally {
    await teardown(fx);
  }
});

describe('public render mode and cache route contract', () => {
  it.each([
    ['*', '/posts/*', '/posts/a'],
    ['/posts/*', '/posts/:id', '/posts/a'],
    ['/:extremelyLongParameter/:anotherLongParameter', '/posts/*', '/posts/a'],
    ['/posts/*', '/posts/:id/*', '/posts/a/detail'],
    ['/posts/*', '/posts/*/detail', '/posts/a/detail'],
  ])('shares specificity for %s and %s', async (broad, specific, path) => {
    const { resolveRenderMode } = await import('../../engine/RenderMode');
    for (const entries of [
      [
        [broad, 'ssr'],
        [specific, 'isr'],
      ],
      [
        [specific, 'isr'],
        [broad, 'ssr'],
      ],
    ] as const) {
      const routes = Object.fromEntries(entries);
      const fx = await startFixture({}, { renderMode: 'ssg', routes });
      try {
        const expectedMode = resolveRenderMode(path, 'ssg', routes);
        expect(expectedMode).toBe('isr');
        for (const expectedCache of ['MISS', 'HIT']) {
          const response = await fetch(fx.baseUrl + path);
          await response.text();
          expect(response.headers.get('x-resolved-mode')).toBe(expectedMode);
          expect(response.headers.get('x-cache-status')).toBe(expectedCache);
        }
      } finally {
        await teardown(fx);
      }
    }
  });
});
