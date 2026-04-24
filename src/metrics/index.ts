/**
 * Metrics 模块导出
 */

export { MetricsCollector } from './MetricsCollector';
export type { RequestRecord, MetricsSnapshot } from './MetricsCollector';

export {
  promRegistry,
  httpRequestsTotal,
  httpRequestDurationSeconds,
  cacheEntriesGauge,
  cacheRevalidatingGauge,
  cacheHitsTotal,
  recordHttpRequest,
  createPrometheusMetricsMiddleware,
} from './PromMetrics';
