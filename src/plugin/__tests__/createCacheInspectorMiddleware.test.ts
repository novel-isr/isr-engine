/**
 * createCacheInspectorMiddleware 行为测试
 *
 * 覆盖：
 *   - disabled 时端点 404（透传 next 不响应）
 *   - enabled + public 不需要 token
 *   - enabled + 非 public：缺 token → 401，错 token → 403，对 token → 200
 *   - status / limit 过滤
 *   - 永远不返回 body（只返回 size + 元数据）
 *   - invalidations 字段含最近 invalidate 时间
 *   - 路径前缀正确（query string 不影响匹配）
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createIsrCacheHandler, type IsrCacheHandler } from '../isrCacheMiddleware';
import { createMemoryCacheStore, type IsrCachedEntry } from '../isrCacheStore';
import { createCacheInspectorMiddleware } from '../createCacheInspectorMiddleware';
import { resolveOpsConfig } from '../../server/opsConfig';
import { revalidateTag } from '../../rsc';

interface Fixture {
  server: Server;
  baseUrl: string;
  handler: IsrCacheHandler;
}

async function startFixture(opts: {
  inventoryEnabled?: boolean;
  inventoryPublic?: boolean;
  authToken?: string;
}): Promise<Fixture> {
  const handler = createIsrCacheHandler(
    {
      renderMode: 'isr',
      revalidate: 3600,
      server: {
        port: 0,
        ops: {
          authToken: opts.authToken,
          tokenHeader: 'x-isr-admin-token',
          health: { enabled: true, public: true },
          metrics: { enabled: false, public: false },
          inventory: {
            enabled: opts.inventoryEnabled ?? true,
            public: opts.inventoryPublic ?? false,
          },
        },
      },
    } as never,
    { store: createMemoryCacheStore({ max: 100 }) }
  );
  const ops = resolveOpsConfig(
    {
      server: {
        port: 0,
        ops: {
          authToken: opts.authToken,
          tokenHeader: 'x-isr-admin-token',
          health: { enabled: true, public: true },
          metrics: { enabled: false, public: false },
          inventory: {
            enabled: opts.inventoryEnabled ?? true,
            public: opts.inventoryPublic ?? false,
          },
        },
      },
    } as never,
    // 用 production 模式跑测试 —— 业务实际部署形态，能验证 prod 默认下的鉴权语义
    'production'
  );

  const inspector = createCacheInspectorMiddleware(handler, ops);
  const server = http.createServer((req, res) => {
    inspector(req, res, () => {
      // 非 inventory 请求 → 404，方便测试断言 “disabled 时透传到这里”
      res.statusCode = 404;
      res.end('not found');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}`, handler };
}

async function teardown(fx: Fixture): Promise<void> {
  await fx.handler.destroy();
  await new Promise<void>((resolve, reject) =>
    fx.server.close(err => (err ? reject(err) : resolve()))
  );
}

interface JsonResponse {
  status: number;
  body: string;
  json?: unknown;
}

async function httpRequest(url: string, headers?: Record<string, string>): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers: headers ?? {} }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        let json: unknown = undefined;
        try {
          json = JSON.parse(body);
        } catch {
          /* 不是 JSON */
        }
        resolve({ status: res.statusCode ?? 0, body, json });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

/** 注入预填条目的 fixture：fixture 直接持有 store 引用，跳过 HTTP 渲染路径 */
async function startFixtureWithStore(opts: {
  inventoryEnabled?: boolean;
  inventoryPublic?: boolean;
  authToken?: string;
  prefill?: (set: (key: string, entry: IsrCachedEntry) => void) => void;
}): Promise<Fixture & { store: ReturnType<typeof createMemoryCacheStore> }> {
  const store = createMemoryCacheStore({ max: 100 });
  if (opts.prefill) opts.prefill((k, e) => store.set(k, e));
  const inventoryEnabled = opts.inventoryEnabled ?? true;
  const inventoryPublic = opts.inventoryPublic ?? false;
  const handler = createIsrCacheHandler(
    {
      renderMode: 'isr',
      revalidate: 3600,
    } as never,
    { store }
  );
  const ops = resolveOpsConfig(
    {
      server: {
        port: 0,
        ops: {
          authToken: opts.authToken,
          tokenHeader: 'x-isr-admin-token',
          health: { enabled: true, public: true },
          metrics: { enabled: false, public: false },
          inventory: { enabled: inventoryEnabled, public: inventoryPublic },
        },
      },
    } as never,
    'production'
  );
  const inspector = createCacheInspectorMiddleware(handler, ops);
  const server = http.createServer((req, res) => {
    inspector(req, res, () => {
      res.statusCode = 404;
      res.end('not found');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}`, handler, store };
}

describe('createCacheInspectorMiddleware —— 鉴权', () => {
  let fx: Fixture;
  afterEach(async () => {
    await teardown(fx);
  });

  it('disabled 时端点透传到 next() → 404', async () => {
    fx = await startFixture({ inventoryEnabled: false });
    const r = await httpRequest(`${fx.baseUrl}/__isr/cache/inventory`);
    expect(r.status).toBe(404);
  });

  it('enabled + public=true（dev 默认形态）→ 无 token 也能访问', async () => {
    fx = await startFixture({ inventoryEnabled: true, inventoryPublic: true });
    const r = await httpRequest(`${fx.baseUrl}/__isr/cache/inventory`);
    expect(r.status).toBe(200);
    expect(r.json).toBeDefined();
  });

  it('enabled + 非 public + 无 token → opsConfig 已自动 disable，端点 404', async () => {
    // 生产策略：metrics/inventory 非 public 但没配 authToken 时自动 disable + 出 warning
    fx = await startFixture({ inventoryEnabled: true, inventoryPublic: false });
    const r = await httpRequest(`${fx.baseUrl}/__isr/cache/inventory`);
    expect(r.status).toBe(404);
  });

  it('enabled + 非 public + 配 token → 缺 Authorization 401', async () => {
    fx = await startFixture({
      inventoryEnabled: true,
      inventoryPublic: false,
      authToken: 'secret-1',
    });
    const r = await httpRequest(`${fx.baseUrl}/__isr/cache/inventory`);
    expect(r.status).toBe(401);
  });

  it('enabled + 非 public + 配 token + 错 token → 403', async () => {
    fx = await startFixture({
      inventoryEnabled: true,
      inventoryPublic: false,
      authToken: 'secret-1',
    });
    const r = await httpRequest(`${fx.baseUrl}/__isr/cache/inventory`, {
      authorization: 'Bearer wrong',
    });
    expect(r.status).toBe(403);
  });

  it('enabled + 非 public + 配 token + 对 token → 200', async () => {
    fx = await startFixture({
      inventoryEnabled: true,
      inventoryPublic: false,
      authToken: 'secret-1',
    });
    const r = await httpRequest(`${fx.baseUrl}/__isr/cache/inventory`, {
      authorization: 'Bearer secret-1',
    });
    expect(r.status).toBe(200);
  });

  it('非 inventory 路径 → 透传 next() → 404', async () => {
    fx = await startFixture({ inventoryEnabled: true, inventoryPublic: true });
    const r = await httpRequest(`${fx.baseUrl}/some-other-path`);
    expect(r.status).toBe(404);
  });

  it('POST 请求 → 透传 next()（端点只接 GET/HEAD）', async () => {
    fx = await startFixture({ inventoryEnabled: true, inventoryPublic: true });
    const r = await new Promise<{ status: number }>((resolve, reject) => {
      const req = http.request(`${fx.baseUrl}/__isr/cache/inventory`, { method: 'POST' }, res => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
      });
      req.on('error', reject);
      req.end();
    });
    expect(r.status).toBe(404);
  });
});

describe('createCacheInspectorMiddleware —— 响应内容', () => {
  let fx: Awaited<ReturnType<typeof startFixtureWithStore>>;
  beforeEach(async () => {
    fx = await startFixtureWithStore({ inventoryEnabled: true, inventoryPublic: true });
  });
  afterEach(async () => {
    await teardown(fx);
  });

  it('返回 backend / size / max 元数据', async () => {
    const r = await httpRequest(`${fx.baseUrl}/__isr/cache/inventory`);
    expect(r.status).toBe(200);
    const json = r.json as { backend: string; size: number; max: number };
    expect(json.backend).toBe('memory');
    expect(json.size).toBe(0);
    expect(json.max).toBe(100);
  });

  it('entries 含 fresh / stale / expired 三态', async () => {
    fx = await startFixtureWithStore({
      inventoryEnabled: true,
      inventoryPublic: true,
      prefill: set => {
        const now = Date.now();
        // fresh：未过 TTL
        set('GET:/fresh', {
          body: Buffer.from('a'),
          statusCode: 200,
          headers: {},
          contentType: 'text/html',
          storedAt: now - 1_000,
          expiresAt: now + 60_000,
          hardExpiresAt: now + 120_000,
          tags: [],
        });
        // stale：过 TTL 未过 hardExpire
        set('GET:/stale', {
          body: Buffer.from('bb'),
          statusCode: 200,
          headers: {},
          contentType: 'text/html',
          storedAt: now - 60_000,
          expiresAt: now - 1_000,
          hardExpiresAt: now + 60_000,
          tags: ['books'],
        });
        // expired：过 hardExpire
        set('GET:/expired', {
          body: Buffer.from('ccc'),
          statusCode: 200,
          headers: {},
          contentType: 'text/html',
          storedAt: now - 200_000,
          expiresAt: now - 100_000,
          hardExpiresAt: now - 1_000,
          tags: [],
        });
      },
    });

    const r = await httpRequest(`${fx.baseUrl}/__isr/cache/inventory`);
    const json = r.json as {
      entries: Array<{ key: string; status: string; sizeBytes: number; tags: string[] }>;
      size: number;
    };
    expect(json.size).toBe(3);
    const byKey = Object.fromEntries(json.entries.map(e => [e.key, e]));
    expect(byKey['GET:/fresh'].status).toBe('fresh');
    expect(byKey['GET:/stale'].status).toBe('stale');
    expect(byKey['GET:/expired'].status).toBe('expired');
    expect(byKey['GET:/fresh'].sizeBytes).toBe(1);
    expect(byKey['GET:/stale'].tags).toEqual(['books']);
  });

  it('?status=stale 只返回 stale 条目', async () => {
    fx = await startFixtureWithStore({
      inventoryEnabled: true,
      inventoryPublic: true,
      prefill: set => {
        const now = Date.now();
        set('GET:/fresh', {
          body: Buffer.from('a'),
          statusCode: 200,
          headers: {},
          contentType: 'text/html',
          storedAt: now,
          expiresAt: now + 60_000,
          hardExpiresAt: now + 120_000,
          tags: [],
        });
        set('GET:/stale', {
          body: Buffer.from('b'),
          statusCode: 200,
          headers: {},
          contentType: 'text/html',
          storedAt: now - 60_000,
          expiresAt: now - 1_000,
          hardExpiresAt: now + 60_000,
          tags: [],
        });
      },
    });

    const r = await httpRequest(`${fx.baseUrl}/__isr/cache/inventory?status=stale`);
    const json = r.json as { filtered: number; entries: Array<{ status: string }> };
    expect(json.filtered).toBe(1);
    expect(json.entries.every(e => e.status === 'stale')).toBe(true);
  });

  it('?limit=N 截断 entries 数组', async () => {
    fx = await startFixtureWithStore({
      inventoryEnabled: true,
      inventoryPublic: true,
      prefill: set => {
        const now = Date.now();
        for (let i = 0; i < 50; i++) {
          set(`GET:/k${i}`, {
            body: Buffer.from('x'),
            statusCode: 200,
            headers: {},
            contentType: 'text/html',
            storedAt: now - i * 1000, // 递增 age 让排序稳定
            expiresAt: now + 60_000,
            hardExpiresAt: now + 120_000,
            tags: [],
          });
        }
      },
    });

    const r = await httpRequest(`${fx.baseUrl}/__isr/cache/inventory?limit=10`);
    const json = r.json as { size: number; filtered: number; entries: unknown[] };
    expect(json.size).toBe(50);
    expect(json.filtered).toBe(50);
    expect(json.entries.length).toBe(10);
  });

  it('永远不返回 body —— 只返回 sizeBytes', async () => {
    fx = await startFixtureWithStore({
      inventoryEnabled: true,
      inventoryPublic: true,
      prefill: set => {
        set('GET:/secret', {
          body: Buffer.from('<html>SECRET-CONTENT-12345</html>'),
          statusCode: 200,
          headers: { 'set-cookie': 'session=secret' },
          contentType: 'text/html',
          storedAt: Date.now(),
          expiresAt: Date.now() + 60_000,
          hardExpiresAt: Date.now() + 120_000,
          tags: [],
        });
      },
    });

    const r = await httpRequest(`${fx.baseUrl}/__isr/cache/inventory`);
    expect(r.body).not.toContain('SECRET-CONTENT');
    expect(r.body).not.toContain('session=secret');
  });

  it('invalidations 字段含 revalidateTag 后的 lastInvalidatedMs', async () => {
    fx = await startFixtureWithStore({ inventoryEnabled: true, inventoryPublic: true });
    // 触发一次 tag 失效（handler 已注册 invalidator）
    await revalidateTag('books');

    const r = await httpRequest(`${fx.baseUrl}/__isr/cache/inventory`);
    const json = r.json as {
      invalidations: Array<{ target: string; lastInvalidatedMs: number; ageSeconds: number }>;
    };
    const found = json.invalidations.find(x => x.target === 'tag:books');
    expect(found).toBeDefined();
    expect(found!.lastInvalidatedMs).toBeGreaterThan(0);
    expect(found!.ageSeconds).toBeGreaterThanOrEqual(0);
  });

  it('Cache-Control: no-store —— 自身永远不被中间缓存', async () => {
    const r = await new Promise<Record<string, string | string[]>>((resolve, reject) => {
      http
        .get(`${fx.baseUrl}/__isr/cache/inventory`, res => {
          res.resume();
          res.on('error', reject);
          res.on('end', () => resolve(res.headers as never));
        })
        .on('error', reject);
    });
    expect(String(r['cache-control'] ?? '')).toContain('no-store');
  });
});

describe('createCacheInspectorMiddleware —— L2 视图（hybrid 模式）', () => {
  let fx: Awaited<ReturnType<typeof startFixtureWithStore>>;
  afterEach(async () => {
    await teardown(fx);
  });

  it('memory 模式 → l2.items 恒为空数组（不发 Redis 命令）', async () => {
    fx = await startFixtureWithStore({ inventoryEnabled: true, inventoryPublic: true });
    const r = await httpRequest(`${fx.baseUrl}/__isr/cache/inventory`);
    const json = r.json as { backend: string; l2: { scanned: number; items: unknown[] } };
    expect(json.backend).toBe('memory');
    expect(json.l2.scanned).toBe(0);
    expect(json.l2.items).toEqual([]);
  });

  it('?l2=false 显式关闭 L2 视图', async () => {
    fx = await startFixtureWithStore({ inventoryEnabled: true, inventoryPublic: true });
    const r = await httpRequest(`${fx.baseUrl}/__isr/cache/inventory?l2=false`);
    const json = r.json as { l2: { scanned: number; items: unknown[] } };
    expect(json.l2.items).toEqual([]);
  });

  it('?l2Limit 超过硬上限 500 时被截断', async () => {
    fx = await startFixtureWithStore({ inventoryEnabled: true, inventoryPublic: true });
    const r = await httpRequest(`${fx.baseUrl}/__isr/cache/inventory?l2Limit=99999`);
    const json = r.json as { filter: { l2Limit: number } };
    expect(json.filter.l2Limit).toBe(500); // L2_HARD_LIMIT
  });
});
