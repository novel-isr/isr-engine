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

export const invalidatorRunsTotal = new Counter({
  name: 'isr_invalidator_runs_total',
  help: 'Total revalidate dispatches (one increment per revalidatePath/Tag call with ≥1 invalidator)',
  labelNames: ['kind'] as const, // 'path' | 'tag'
  registers: [promRegistry],
});

export const invalidatorFailuresTotal = new Counter({
  name: 'isr_invalidator_failures_total',
  help: 'Per-invalidator failures during revalidate dispatch (one increment per failing invalidator)',
  labelNames: ['kind'] as const, // 'path' | 'tag'
  registers: [promRegistry],
});

/** 一行调用更新所有计数 —— 给 isrCacheMiddleware / 中间件用 */
export function recordHttpRequest(opts: {
  method: string;
  route: string;
  status: number;
  mode: string;
  cache: string;
  durationMs: number;
}): void {
  httpRequestsTotal.inc({
    method: opts.method,
    route: opts.route,
    status: String(opts.status),
    mode: opts.mode,
    cache: opts.cache,
  });
  httpRequestDurationSeconds.observe(
    { method: opts.method, route: opts.route, mode: opts.mode, cache: opts.cache },
    opts.durationMs / 1000
  );
  if (opts.cache) cacheHitsTotal.inc({ status: opts.cache });
}

/** Express / connect 中间件：暴露 /metrics 端点（Prometheus text exposition format）*/
export function createPrometheusMetricsMiddleware(path = '/metrics') {
  return async function (
    req: { url?: string; method?: string },
    res: {
      setHeader(k: string, v: string): void;
      end(body?: string): void;
      statusCode: number;
    },
    next: () => void
  ): Promise<void> {
    if (req.url !== path || req.method !== 'GET') return next();
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
