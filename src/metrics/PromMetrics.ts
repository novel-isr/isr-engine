/**
 * PromMetrics —— prom-client 包装，导出 Prometheus 文本格式
 *
 * 设计：
 *   - prom-client 是 Node 生态的事实标准（Grafana / Datadog / Prometheus 直接抓取）
 *   - 单 Registry，避免污染全局；用户业务可拿 `promRegistry` 自行注册自家 metric
 *   - 响应时间用 Histogram（带桶），不是平均值 —— 才能正确算 P95/P99
 *   - 默认采集 process_*（CPU / RSS / event-loop lag）—— 一行 collectDefaultMetrics
 */
import { Counter, Histogram, Gauge, Registry, collectDefaultMetrics } from 'prom-client';

export const promRegistry = new Registry();

collectDefaultMetrics({ register: promRegistry, prefix: 'isr_' });

// ─── 业务指标（与 isr-engine 概念一致）───

export const httpRequestsTotal = new Counter({
  name: 'isr_http_requests_total',
  help: 'Total ISR HTTP requests',
  labelNames: ['method', 'route', 'status', 'mode', 'cache'] as const,
  registers: [promRegistry],
});

export const httpRequestDurationSeconds = new Histogram({
  name: 'isr_http_request_duration_seconds',
  help: 'ISR HTTP request duration',
  labelNames: ['method', 'route', 'mode', 'cache'] as const,
  // 桶：1ms - 5s（覆盖 HIT 极快到 SSR 慢路径）
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [promRegistry],
});

export const cacheEntriesGauge = new Gauge({
  name: 'isr_cache_entries',
  help: 'Current ISR cache entries (L1 LRU size)',
  labelNames: ['backend'] as const,
  registers: [promRegistry],
});

export const cacheRevalidatingGauge = new Gauge({
  name: 'isr_cache_revalidating_inflight',
  help: 'Number of in-flight background revalidations',
  registers: [promRegistry],
});

export const cacheHitsTotal = new Counter({
  name: 'isr_cache_hits_total',
  help: 'ISR cache hits',
  labelNames: ['status'] as const, // HIT / STALE / MISS / BYPASS / REVALIDATING
  registers: [promRegistry],
});

// ─── 失效（revalidatePath / revalidateTag）—— 分别记总调用数与失败数 ───
//
// 这两个对生产排错很关键：
//   - revalidatePath / revalidateTag 是 Server Action 的关键路径，失败意味着用户看到旧数据
//   - 失败率 = failures / runs，告警阈值通常设 1%
//   - kind 标签拆 path / tag，因为这俩失败通常对应不同的根因（路由匹配 vs tag 索引）
//   - target 标签是归一化路径或 tag 名，让 Grafana 能定位到具体业务对象（如 /books/:id）。
//     必须走 normalizeRoute 防止 /books/123 / /books/124 各起一条时间序列导致基数爆炸；
//     tag 本身就是业务定义的有限集合（如 'books' / 'book:123'），不再二次归一化。

export const invalidatorRunsTotal = new Counter({
  name: 'isr_invalidator_runs_total',
  help: 'Total revalidate dispatches (one increment per revalidatePath/Tag call with ≥1 invalidator)',
  labelNames: ['kind', 'target'] as const, // kind='path'|'tag'; target=normalized path or tag value
  registers: [promRegistry],
});

export const invalidatorFailuresTotal = new Counter({
  name: 'isr_invalidator_failures_total',
  help: 'Per-invalidator failures during revalidate dispatch (one increment per failing invalidator)',
  labelNames: ['kind', 'target'] as const,
  registers: [promRegistry],
});

// L2（Redis 等异步后端）读超时计数 —— 命中 raceWithTimeout 的兜底返回 undefined。
// 缓存中间件把 L2 超时降级为 miss，业务侧看不到错误但 cache hit rate 会被拖低。
// 单独 counter 让 SRE 能区分 “真 miss”（数据没缓存过）vs “伪 miss”（Redis 抖动）。
export const l2ReadTimeoutsTotal = new Counter({
  name: 'isr_l2_read_timeouts_total',
  help: 'L2 cache async read timeouts (raceWithTimeout fired before underlying promise resolved)',
  registers: [promRegistry],
});

/**
 * 路由归一化 —— 防 Prometheus label 基数爆炸。
 *
 * 动态段（id / uuid / hex / 长 hash）直接作为 label 值会让时间序列数爆炸
 * （每个 /books/123 都是新序列），Prometheus 存储成本线性暴涨、查询变慢。
 *
 * 规则：
 *   - 纯数字段（1 ~ 20 位）   → `:id`
 *   - UUID v1-v5               → `:uuid`
 *   - 长 hex（≥16 字符全 hex）→ `:hash`
 *   - base64url/大小写混合长串（≥24 字符，含数字和字母）→ `:hash`
 *
 * 命中任意规则即替换；其他保留原样（`/books` `/about` 保留）。
 *
 * 可用 `addRouteNormalizeRule(pattern, replacement)` 扩展业务特有规则。
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LONG_HEX_RE = /^[0-9a-f]{16,}$/i;
const OPAQUE_ID_RE = /^[A-Za-z0-9_-]{24,}$/;
const PURE_DIGIT_RE = /^\d{1,20}$/;

export type RouteNormalizeRule = (segment: string) => string | null;
const customRules: RouteNormalizeRule[] = [];

export function addRouteNormalizeRule(rule: RouteNormalizeRule): void {
  customRules.push(rule);
}

export function normalizeRoute(route: string): string {
  if (!route || route === '/') return '/';
  const segments = route.split('/');
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!seg) continue;
    let replaced: string | null = null;
    for (const rule of customRules) {
      replaced = rule(seg);
      if (replaced) break;
    }
    if (replaced) {
      segments[i] = replaced;
      continue;
    }
    if (PURE_DIGIT_RE.test(seg)) {
      segments[i] = ':id';
    } else if (UUID_RE.test(seg)) {
      segments[i] = ':uuid';
    } else if (LONG_HEX_RE.test(seg)) {
      segments[i] = ':hash';
    } else if (OPAQUE_ID_RE.test(seg)) {
      segments[i] = ':hash';
    }
  }
  return segments.join('/');
}

/** 一行调用更新所有计数 —— 给 isrCacheMiddleware / 中间件用 */
export function recordHttpRequest(opts: {
  method: string;
  route: string;
  status: number;
  mode: string;
  cache: string;
  durationMs: number;
}): void {
  const route = normalizeRoute(opts.route);
  httpRequestsTotal.inc({
    method: opts.method,
    route,
    status: String(opts.status),
    mode: opts.mode,
    cache: opts.cache,
  });
  httpRequestDurationSeconds.observe(
    { method: opts.method, route, mode: opts.mode, cache: opts.cache },
    opts.durationMs / 1000
  );
  if (opts.cache) cacheHitsTotal.inc({ status: opts.cache });
}

export interface PrometheusMetricsMiddlewareOptions {
  /** 挂载路径；默认 `/metrics` */
  path?: string;
  /**
   * 要求客户端提供的 Bearer token。
   * 明确设 false/undefined/'' → 不做认证（仅建议用于纯内网 /k8s Pod 内暴露）。
   * 生产外网挂载**强烈建议**设 token，避免指标泄露业务信息（QPS、错误分布、路由列表）。
   */
  token?: string | false;
  /** 不通过时返回的状态码；默认 401 */
  unauthorizedStatus?: number;
}

/**
 * Express / connect 中间件：暴露 /metrics 端点（Prometheus text exposition format）
 *
 * 认证：可选 Bearer token —— 未设 token 时保持旧行为（匿名可访问）。
 * 生产建议：`createPrometheusMetricsMiddleware({ token: process.env.METRICS_TOKEN })`。
 */
export function createPrometheusMetricsMiddleware(
  pathOrOptions: string | PrometheusMetricsMiddlewareOptions = {}
) {
  const options: PrometheusMetricsMiddlewareOptions =
    typeof pathOrOptions === 'string' ? { path: pathOrOptions } : pathOrOptions;
  const path = options.path ?? '/metrics';
  const token = options.token && options.token !== '' ? options.token : null;
  const unauthorizedStatus = options.unauthorizedStatus ?? 401;

  return async function (
    req: { url?: string; method?: string; headers?: Record<string, string | string[] | undefined> },
    res: {
      setHeader(k: string, v: string): void;
      end(body?: string): void;
      statusCode: number;
    },
    next: () => void
  ): Promise<void> {
    if (req.url !== path || req.method !== 'GET') return next();

    if (token) {
      const authHeader = req.headers?.['authorization'];
      const raw = Array.isArray(authHeader) ? authHeader[0] : authHeader;
      const ok = typeof raw === 'string' && raw === `Bearer ${token}`;
      if (!ok) {
        res.statusCode = unauthorizedStatus;
        res.setHeader('WWW-Authenticate', 'Bearer realm="metrics"');
        res.end('Unauthorized');
        return;
      }
    }

    try {
      const body = await promRegistry.metrics();
      res.setHeader('content-type', promRegistry.contentType);
      res.statusCode = 200;
      res.end(body);
    } catch (err) {
      res.statusCode = 500;
      res.end(`metrics error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}
