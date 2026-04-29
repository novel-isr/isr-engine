/**
 * PromMetrics 单元测试
 *
 * 覆盖：
 *   - recordHttpRequest 增长 counter / observe histogram
 *   - registry 输出 Prometheus 文本格式
 *   - 桶覆盖 1ms - 5s 范围
 */
import { describe, it, expect } from 'vitest';
import {
  promRegistry,
  recordHttpRequest,
  httpRequestsTotal,
  cacheHitsTotal,
  normalizeRoute,
  addRouteNormalizeRule,
  createPrometheusMetricsMiddleware,
} from '../PromMetrics';

describe('PromMetrics', () => {
  it('recordHttpRequest 增长 isr_http_requests_total', async () => {
    const before = (await getCounterValue('isr_http_requests_total')) ?? 0;
    recordHttpRequest({
      method: 'GET',
      route: '/test',
      status: 200,
      mode: 'isr',
      cache: 'HIT',
      durationMs: 5,
    });
    const after = (await getCounterValue('isr_http_requests_total')) ?? 0;
    expect(after).toBeGreaterThan(before);
  });

  it('recordHttpRequest 同时增长 isr_cache_hits_total', async () => {
    const before = (await getCounterValue('isr_cache_hits_total', { status: 'STALE' })) ?? 0;
    recordHttpRequest({
      method: 'GET',
      route: '/x',
      status: 200,
      mode: 'isr',
      cache: 'STALE',
      durationMs: 12,
    });
    const after = (await getCounterValue('isr_cache_hits_total', { status: 'STALE' })) ?? 0;
    expect(after - before).toBe(1);
  });

  it('promRegistry.metrics() 输出 Prometheus 文本格式', async () => {
    const text = await promRegistry.metrics();
    expect(text).toContain('# HELP isr_http_requests_total');
    expect(text).toContain('# TYPE isr_http_requests_total counter');
    expect(text).toContain('# TYPE isr_http_request_duration_seconds histogram');
    // prom-client 自动加 buckets
    expect(text).toMatch(/isr_http_request_duration_seconds_bucket\{[^}]*le="0\.005"/);
    expect(text).toMatch(/isr_http_request_duration_seconds_bucket\{[^}]*le="5"/);
  });

  it('contentType 是 OpenMetrics / text', () => {
    expect(promRegistry.contentType).toMatch(/text\/plain|application\/openmetrics/);
  });

  it('counters & histograms 已注册', () => {
    const names = promRegistry.getMetricsAsArray().map(m => m.name);
    expect(names).toContain('isr_http_requests_total');
    expect(names).toContain('isr_http_request_duration_seconds');
    expect(names).toContain('isr_cache_entries');
    expect(names).toContain('isr_cache_revalidating_inflight');
    expect(names).toContain('isr_cache_hits_total');
  });

  it('counter labelNames 与 inc() 调用一致', async () => {
    httpRequestsTotal.reset();
    httpRequestsTotal.inc({
      method: 'POST',
      route: '/a',
      status: '500',
      mode: 'ssr',
      cache: 'BYPASS',
    });
    const text = await promRegistry.metrics();
    expect(text).toMatch(
      /isr_http_requests_total\{method="POST",route="\/a",status="500",mode="ssr",cache="BYPASS"\} 1/
    );
  });

  it('cacheHitsTotal 按状态聚合', async () => {
    cacheHitsTotal.reset();
    cacheHitsTotal.inc({ status: 'HIT' }, 3);
    cacheHitsTotal.inc({ status: 'MISS' }, 2);
    const text = await promRegistry.metrics();
    expect(text).toMatch(/isr_cache_hits_total\{status="HIT"\} 3/);
    expect(text).toMatch(/isr_cache_hits_total\{status="MISS"\} 2/);
  });
});

/**
 * v2.1 修复：route 直接作为 label 会让 Prometheus label 基数爆炸
 * （`/books/123`、`/books/124` 各占一个 time series）。
 * normalizeRoute 把动态段归一：`:id` / `:uuid` / `:hash`。
 */
describe('normalizeRoute —— label cardinality 控制', () => {
  it('纯数字段 → :id', () => {
    expect(normalizeRoute('/books/123')).toBe('/books/:id');
    expect(normalizeRoute('/users/42/posts/99')).toBe('/users/:id/posts/:id');
  });

  it('UUID v4 → :uuid', () => {
    expect(normalizeRoute('/orders/4e2a5b8c-1d3f-4a7e-9b2c-5d6e7f8a9b0c')).toBe('/orders/:uuid');
  });

  it('长 hex → :hash（如 sha256 commit sha）', () => {
    expect(normalizeRoute('/assets/a1b2c3d4e5f67890abcdef1234567890')).toBe('/assets/:hash');
  });

  it('base64url-ish 长串 → :hash', () => {
    expect(normalizeRoute('/share/abc_def-ghiJKLmnop0123456789')).toBe('/share/:hash');
  });

  it('保留纯静态路径段', () => {
    expect(normalizeRoute('/about')).toBe('/about');
    expect(normalizeRoute('/books/list')).toBe('/books/list');
    expect(normalizeRoute('/')).toBe('/');
  });

  it('混合段：动态 + 静态交错', () => {
    expect(normalizeRoute('/api/v1/users/123/profile')).toBe('/api/v1/users/:id/profile');
  });

  it('空路由保持为 /', () => {
    expect(normalizeRoute('')).toBe('/');
  });

  it('addRouteNormalizeRule —— 自定义业务规则优先（slug 段归一）', () => {
    // eg 小说站想把 /books/my-novel-title → /books/:slug 而非默认规则
    addRouteNormalizeRule(seg => {
      if (seg.startsWith('novel-')) return ':slug';
      return null;
    });
    expect(normalizeRoute('/books/novel-abc-123')).toBe('/books/:slug');
    // 仍然保留默认规则
    expect(normalizeRoute('/books/123')).toBe('/books/:id');
  });

  it('recordHttpRequest 使用归一化路由，避免 /books/42 / /books/43 炸 label', async () => {
    httpRequestsTotal.reset();
    recordHttpRequest({
      method: 'GET',
      route: '/books/42',
      status: 200,
      mode: 'isr',
      cache: 'HIT',
      durationMs: 1,
    });
    recordHttpRequest({
      method: 'GET',
      route: '/books/43',
      status: 200,
      mode: 'isr',
      cache: 'HIT',
      durationMs: 1,
    });
    const text = await promRegistry.metrics();
    // 两次请求都归一化到 `/books/:id`，counter 值应为 2
    expect(text).toMatch(/isr_http_requests_total\{[^}]*route="\/books\/:id"[^}]*\} 2/);
    // 不应出现具体 id
    expect(text).not.toMatch(/route="\/books\/42"/);
    expect(text).not.toMatch(/route="\/books\/43"/);
  });
});

describe('createPrometheusMetricsMiddleware —— token 认证（v2.1 修复）', () => {
  function mockReqRes(
    url = '/metrics',
    method = 'GET',
    authorization?: string
  ): {
    req: { url: string; method: string; headers: Record<string, string | string[] | undefined> };
    res: {
      setHeader(k: string, v: string): void;
      end(body?: string): void;
      statusCode: number;
      headers: Record<string, string>;
      body: string | undefined;
      ended: boolean;
    };
    next: () => void;
    nextCount: { n: number };
  } {
    const headers: Record<string, string> = {};
    let body: string | undefined;
    let ended = false;
    const res = {
      setHeader(k: string, v: string) {
        headers[k] = v;
      },
      end(b?: string) {
        body = b;
        ended = true;
      },
      statusCode: 200,
      get headers() {
        return headers;
      },
      get body() {
        return body;
      },
      get ended() {
        return ended;
      },
    };
    const nextCount = { n: 0 };
    const next = (): void => {
      nextCount.n++;
    };
    return {
      req: {
        url,
        method,
        headers: authorization ? { authorization } : {},
      },
      res,
      next,
      nextCount,
    };
  }

  it('未配置 token → 匿名可访问（显式默认策略）', async () => {
    const mw = createPrometheusMetricsMiddleware('/metrics');
    const { req, res } = mockReqRes();
    await mw(req, res, () => {});
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('# HELP');
  });

  it('配置 token + 正确 Bearer → 放行', async () => {
    const mw = createPrometheusMetricsMiddleware({ token: 'secret-123' });
    const { req, res } = mockReqRes('/metrics', 'GET', 'Bearer secret-123');
    await mw(req, res, () => {});
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('# HELP');
  });

  it('配置 token + 错误 Bearer → 401 + WWW-Authenticate', async () => {
    const mw = createPrometheusMetricsMiddleware({ token: 'secret-123' });
    const { req, res } = mockReqRes('/metrics', 'GET', 'Bearer wrong-token');
    await mw(req, res, () => {});
    expect(res.statusCode).toBe(401);
    expect(res.headers['WWW-Authenticate']).toContain('Bearer');
    expect(res.body).toBe('Unauthorized');
  });

  it('配置 token + 缺少 Authorization 头 → 401', async () => {
    const mw = createPrometheusMetricsMiddleware({ token: 'secret-123' });
    const { req, res } = mockReqRes('/metrics', 'GET', undefined);
    await mw(req, res, () => {});
    expect(res.statusCode).toBe(401);
  });

  it('非 /metrics 路径 → 透传 next()', async () => {
    const mw = createPrometheusMetricsMiddleware({ token: 'secret' });
    const { req, res, next, nextCount } = mockReqRes('/other', 'GET');
    await mw(req, res, next);
    expect(nextCount.n).toBe(1);
    expect(res.ended).toBe(false);
  });

  it('非 GET 方法 → 透传 next()', async () => {
    const mw = createPrometheusMetricsMiddleware({ token: 'secret' });
    const { req, res, next, nextCount } = mockReqRes('/metrics', 'POST');
    await mw(req, res, next);
    expect(nextCount.n).toBe(1);
  });

  it('token="" / false 视为未配置', async () => {
    const mw1 = createPrometheusMetricsMiddleware({ token: '' });
    const { req: r1, res: s1 } = mockReqRes();
    await mw1(r1, s1, () => {});
    expect(s1.statusCode).toBe(200);

    const mw2 = createPrometheusMetricsMiddleware({ token: false });
    const { req: r2, res: s2 } = mockReqRes();
    await mw2(r2, s2, () => {});
    expect(s2.statusCode).toBe(200);
  });

  it('旧签名 createPrometheusMetricsMiddleware("/custom") 仍兼容', async () => {
    const mw = createPrometheusMetricsMiddleware('/my-metrics');
    const { req, res } = mockReqRes('/my-metrics');
    await mw(req, res, () => {});
    expect(res.statusCode).toBe(200);

    // 默认路径下不触发
    const { req: r2, res: s2, next, nextCount } = mockReqRes('/metrics');
    await mw(r2, s2, next);
    expect(nextCount.n).toBe(1);
  });
});

async function getCounterValue(
  name: string,
  labels?: Record<string, string>
): Promise<number | undefined> {
  const m = promRegistry.getSingleMetric(name);
  if (!m) return undefined;
  const got = await m.get();
  if (!labels) {
    return got.values.reduce((sum, v) => sum + v.value, 0);
  }
  const v = got.values.find(v => Object.entries(labels).every(([k, vv]) => v.labels[k] === vv));
  return v?.value;
}
