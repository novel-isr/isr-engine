/**
 * PromMetrics 单元测试
 *
 * 覆盖：
 *   - recordHttpRequest 增长 counter / observe histogram
 *   - registry 输出 Prometheus 文本格式
 *   - 桶覆盖 1ms - 5s 范围
 */
import { describe, it, expect } from 'vitest';
import { promRegistry, recordHttpRequest, httpRequestsTotal, cacheHitsTotal } from '../PromMetrics';

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
