/**
 * bench/utils.extractP95 —— v2.1 P95 校正逻辑的回归网
 *
 * 锁住的关键行为：
 *   1) 有 hdr-histogram → 精确取 P95（不再用 P97.5 冒充）
 *   2) 无 histogram → P90 + P97.5 线性插值（精度 < 5% 损失）
 *   3) 都没有 → 退化到 P97.5 字面值（保留旧行为不崩）
 *   4) 完全空 → 返回 0
 *
 * 这是 v2.1 修复中"latency_p95_ms 字段"的正确性根源 —— CI gate 与
 * baseline 比较都依赖此函数，必须确定性。
 */
import { describe, it, expect } from 'vitest';
import { extractP95 } from '../utils.mjs';

describe('extractP95 —— 优先用 hdr-histogram', () => {
  it('histogram.getValueAtPercentile(95) 返回有效值时，直接采用', () => {
    const result = {
      latency: {
        p90: 100,
        p97_5: 200,
        histogram: {
          getValueAtPercentile: p => (p === 95 ? 150 : 0),
        },
      },
    };
    expect(extractP95(result)).toBe(150);
  });

  it('histogram 返回 0 / NaN / -1 → 走 fallback 插值', () => {
    for (const bad of [0, NaN, -1, Infinity]) {
      const result = {
        latency: {
          p90: 100,
          p97_5: 200,
          histogram: {
            getValueAtPercentile: () => bad,
          },
        },
      };
      // P95 应该走插值：100 + (200-100) * 5/7.5 ≈ 166.67
      expect(extractP95(result)).toBeCloseTo(166.67, 1);
    }
  });

  it('histogram 不存在 → 走 P90+P97.5 插值', () => {
    const result = { latency: { p90: 50, p97_5: 80 } };
    // 50 + (80-50) * 5/7.5 = 50 + 20 = 70
    expect(extractP95(result)).toBe(70);
  });

  it('插值公式：P90=10, P97.5=10 → 返回 10（边界稳定）', () => {
    expect(extractP95({ latency: { p90: 10, p97_5: 10 } })).toBe(10);
  });

  it('插值公式：P90=0, P97.5=100 → 66.67', () => {
    expect(extractP95({ latency: { p90: 0, p97_5: 100 } })).toBeCloseTo(66.67, 1);
  });
});

describe('extractP95 —— 兜底退化', () => {
  it('只有 p97_5 无 p90 → 返回 p97_5 字面值（不崩）', () => {
    expect(extractP95({ latency: { p97_5: 42 } })).toBe(42);
  });

  it('完全没数据 → 0', () => {
    expect(extractP95({})).toBe(0);
    expect(extractP95(undefined)).toBe(0);
    expect(extractP95(null)).toBe(0);
    expect(extractP95({ latency: {} })).toBe(0);
  });

  it('p97_5 是字符串（污染 input）→ 0', () => {
    expect(extractP95({ latency: { p97_5: 'not-a-number' } })).toBe(0);
  });
});

describe('extractP95 —— 输出格式', () => {
  it('保留 2 位小数（.toFixed(2)）', () => {
    const result = {
      latency: {
        histogram: {
          getValueAtPercentile: () => 123.4567,
        },
      },
    };
    expect(extractP95(result)).toBe(123.46);
  });

  it('返回 number 类型（非 string）', () => {
    expect(typeof extractP95({ latency: { p90: 1, p97_5: 2 } })).toBe('number');
  });
});

describe('extractP95 —— 真实场景对比（旧行为 vs 新行为）', () => {
  it('典型 ISR HIT 场景：P90=1ms / P97.5=3ms → 旧行为 3ms（高估），新行为 ≈ 2.33ms', () => {
    const result = { latency: { p90: 1, p97_5: 3 } };
    // 旧代码（直接用 p97_5）：3
    // 新代码（线性插值）：1 + (3-1) * 5/7.5 = 1 + 1.333... ≈ 2.33
    const got = extractP95(result);
    expect(got).toBeCloseTo(2.33, 1);
    // 关键断言：新值严格小于旧值（消除 +20% 高估偏差）
    expect(got).toBeLessThan(result.latency.p97_5);
  });

  it('典型 SSR 场景：P90=20ms / P97.5=50ms → 新行为 ≈ 40ms', () => {
    const got = extractP95({ latency: { p90: 20, p97_5: 50 } });
    expect(got).toBeCloseTo(40, 0);
  });
});
