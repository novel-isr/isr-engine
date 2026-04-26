/**
 * bench-utils —— bench.mjs 的可测试工具函数
 *
 * autocannon 默认 percentile 集包含 p50/p75/p90/p97_5/p99/p99_9 —— 没有原生 p95。
 * 之前 bench.mjs 直接把 `r.latency.p97_5` 当 P95 上报（偏高 ~15-20%），会误伤 CI gate。
 *
 * 本模块导出 extractP95() —— 三段式 fallback：
 *   1) 优先从底层 hdr-histogram.getValueAtPercentile(95) 精确取（autocannon 透出的话）
 *   2) 退化：用 P90 + P97.5 的线性插值（精度损失 < 5%，远好于直接 P97.5）
 *   3) 兜底：返回 P97.5 字面值（保留旧行为，不至于崩）
 */

/**
 * @param {{ latency?: { histogram?: { getValueAtPercentile?: (p: number) => number };
 *   p90?: number; p97_5?: number } }} result autocannon 返回的 result 对象
 * @returns {number} P95 延迟（ms），找不到时返回 0
 */
export function extractP95(result) {
  const h = result?.latency?.histogram;
  if (h && typeof h.getValueAtPercentile === 'function') {
    const v = h.getValueAtPercentile(95);
    if (Number.isFinite(v) && v > 0) return +v.toFixed(2);
  }
  const p90 = result?.latency?.p90;
  const p975 = result?.latency?.p97_5;
  if (typeof p90 === 'number' && typeof p975 === 'number') {
    // P95 在 P90 与 P97.5 之间的位置：(95-90)/(97.5-90) = 5/7.5 ≈ 0.667
    return +(p90 + (p975 - p90) * (5 / 7.5)).toFixed(2);
  }
  return typeof p975 === 'number' ? +p975.toFixed(2) : 0;
}

/** 简单的 sleep helper —— 给档间 cooldown 用 */
export const sleep = ms => new Promise(r => setTimeout(r, ms));
