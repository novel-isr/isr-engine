/**
 * A/B Variant Middleware —— anonId 确定性 hash 分桶（自研 ISR 原生实现）
 *
 * 设计原则（跟前一版的根本区别）：
 *   - **不再把变体编码进 cookie**（旧版：`ab=hero=bold|pricing=control`，每次写 cookie
 *     → 响应带 Set-Cookie → ISR 缓存全站失效）
 *   - 用 RequestContext 里的 anonId（engine 入口已经保证存在 + 写 Set-Cookie 是入口
 *     middleware 的事，跟变体决策完全解耦）做确定性 hash 分桶：
 *
 *       variant = pickByBucket(exp.variants, exp.weights,
 *                              fnv1a(anonId + ':' + expKey) % 10000)
 *
 *     同一 anonId × 同一 experiment 永远拿同一 variant；engine 升级实验也不需要
 *     rewrite cookie。
 *
 * 一致性 + 缓存：ctx.experiments 由本 middleware 写入；ISR cache 把它的 stable
 * digest 拼进 cache key —— 不同变体走不同 cache entry，同变体多用户共享 entry。
 *
 * 用法：
 *
 *   import { createABVariantMiddleware, getVariant } from '@novel-isr/engine';
 *
 *   app.use(createABVariantMiddleware({
 *     experiments: {
 *       'home-hero': { variants: ['classic', 'hero-v2'], weights: [50, 50] },
 *       'pricing-page': { variants: ['control', 'discount-banner'], weights: [70, 30] },
 *     },
 *   }));
 *
 *   // Server Component：
 *   import { getVariant } from '@novel-isr/engine';
 *   const v = getVariant('home-hero');
 *
 * 注意：本 middleware **完全不写 cookie**。anonId cookie 由 engine 入口 middleware
 * （createServerRequestContext + applyAnonCookie）落，跟实验配置变化解耦。
 */
import type { Request, Response, NextFunction } from 'express';
import { getRequestContext } from '../context/RequestContext';
import { fnv1a32 } from '../utils/hash';

export { getVariant } from './abVariantContext';

export interface ExperimentConfig {
  /** 变体列表 */
  variants: readonly string[];
  /** 权重（与 variants 同长；和不必为 100）；不传 → 平均分 */
  weights?: readonly number[];
}

export interface ABVariantOptions {
  /** A/B testing 定义：testName → { variants, weights } */
  experiments: Record<string, ExperimentConfig>;
  /**
   * 自定义分桶逻辑（覆盖默认 fnv1a(anonId + ':' + name)）；如按 userId / geo / device。
   * 必须是 **确定性函数**（同输入永远同输出），否则 ISR cache 会反复 MISS。
   */
  assigner?: (anonId: string, name: string, exp: ExperimentConfig) => string;
}

/** 总桶数；10000 给到 0.01% 权重精度，业界通行做法 */
const BUCKET_SPACE = 10000;

/**
 * 按权重 + bucket 索引选 variant。
 * 把 weights 累加得到分段边界，bucket 落在哪段就选哪个 variant。
 * 同一 (variants, weights, bucket) → 永远同一结果（确定性）。
 */
function pickByBucket(
  variants: readonly string[],
  weights: readonly number[] | undefined,
  bucket: number
): string {
  // 默认平均分
  const w = weights && weights.length === variants.length ? weights : variants.map(() => 1);
  const total = w.reduce((a, b) => a + b, 0);
  // bucket ∈ [0, BUCKET_SPACE)；按 weights 比例切片
  let cursor = 0;
  for (let i = 0; i < variants.length; i++) {
    cursor += (w[i] / total) * BUCKET_SPACE;
    if (bucket < cursor) return variants[i];
  }
  return variants[variants.length - 1];
}

/** 默认分桶：fnv1a(anonId + ':' + experimentKey) % BUCKET_SPACE。稳定、无外部依赖 */
function defaultAssigner(anonId: string, name: string, exp: ExperimentConfig): string {
  const bucket = fnv1a32(`${anonId}:${name}`) % BUCKET_SPACE;
  return pickByBucket(exp.variants, exp.weights, bucket);
}

export function createABVariantMiddleware(options: ABVariantOptions) {
  const { experiments, assigner = defaultAssigner } = options;

  return function abMiddleware(_req: Request, _res: Response, next: NextFunction): void {
    const ctx = getRequestContext();
    if (!ctx) {
      // 没有 RequestContext → engine 入口没接上，跳过实验（不破坏渲染）
      next();
      return;
    }

    const anonId = ctx.anonId;
    const assignments: Record<string, string> = {};
    for (const [name, exp] of Object.entries(experiments)) {
      assignments[name] = assigner(anonId, name, exp);
    }

    // 写到两个字段：experiments 是 SST，flags 是 getVariant() 历史 API 的兼容路径
    ctx.experiments = { ...(ctx.experiments ?? {}), ...assignments };
    ctx.flags = { ...(ctx.flags ?? {}), ...assignments };

    next();
  };
}
