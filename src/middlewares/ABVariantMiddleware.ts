/**
 * A/B Variant Middleware —— anonId 确定性 hash 分桶（自研 ISR 原生实现）
 *
 * 设计原则：
 *   - **不再把变体编码进 cookie**（旧版每次写 cookie → Set-Cookie → ISR 缓存失效）
 *   - 用 RequestContext.anonId（engine 入口保证存在）做确定性 hash 分桶：
 *
 *       variant = pickByBucket(exp.variants, exp.weights,
 *                              fnv1a(anonId + ':' + expKey) % 10000)
 *
 *     同一 anonId × 同一 experiment 永远拿同一 variant，engine 升级实验也不需要
 *     rewrite cookie。
 *
 * 数据源优先级（manifest > static）：
 *   - 如果 ManifestLoader 接上 → 从 manifest 拿 effective experiments（admin-server
 *     运营 60s 内可改），manifest 拉失败时 loader 内部按 fallbackOnError 策略回退
 *   - 没接 manifest → 用构造时传入的 static experiments
 *
 * 曝光上报：
 *   - 如果 ExposureQueue 接上 → 算完 ctx.experiments 后 fire-and-forget push 一条
 *   - 没接 queue → 跳过；A/B 仅在内存里跑（本地开发 / 不需要数据时的默认）
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
 *     },
 *     manifestLoader, // 可选：admin-server 拉取
 *     exposureQueue,  // 可选：曝光上报
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
import type { ExposureQueueInstance } from '../experiments/ExposureQueue';
import type { ManifestLoaderInstance } from '../experiments/ManifestLoader';

export { getVariant } from './abVariantContext';

export interface ExperimentConfig {
  /** 变体列表 */
  variants: readonly string[];
  /** 权重（与 variants 同长；和不必为 100）；不传 → 平均分 */
  weights?: readonly number[];
}

export interface ABVariantOptions {
  /** A/B testing 静态定义；manifestLoader 接上时仅作 fallback */
  experiments: Record<string, ExperimentConfig>;
  /**
   * 自定义分桶逻辑（覆盖默认 fnv1a(anonId + ':' + name)）；如按 userId / geo / device。
   * 必须是 **确定性函数**（同输入永远同输出），否则 ISR cache 会反复 MISS。
   */
  assigner?: (anonId: string, name: string, exp: ExperimentConfig) => string;
  /**
   * 实验定义动态拉取实例。接上时每请求从 loader 读 effective experiments；
   * 不接则用 options.experiments 静态配置。
   */
  manifestLoader?: ManifestLoaderInstance | null;
  /**
   * 曝光上报队列实例。接上时每请求 fire-and-forget push 一条 exposure 事件。
   */
  exposureQueue?: ExposureQueueInstance | null;
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

function stripQuery(url: string): string {
  const i = url.indexOf('?');
  return i === -1 ? url : url.slice(0, i);
}

export function createABVariantMiddleware(options: ABVariantOptions) {
  const { experiments: staticExperiments, assigner = defaultAssigner } = options;
  const { manifestLoader, exposureQueue } = options;

  return function abMiddleware(req: Request, _res: Response, next: NextFunction): void {
    const ctx = getRequestContext();
    if (!ctx) {
      // 没有 RequestContext → engine 入口没接上，跳过实验（不破坏渲染）
      next();
      return;
    }

    // manifest > static：manifest 拉成功时用它，否则回静态
    const effectiveExperiments = manifestLoader ? manifestLoader.getCurrent() : staticExperiments;

    const anonId = ctx.anonId;
    const assignments: Record<string, string> = {};
    for (const [name, exp] of Object.entries(effectiveExperiments)) {
      assignments[name] = assigner(anonId, name, exp);
    }

    // 写到两个字段：experiments 是 SST，flags 是 getVariant() 历史 API 的兼容路径
    ctx.experiments = { ...(ctx.experiments ?? {}), ...assignments };
    ctx.flags = { ...(ctx.flags ?? {}), ...assignments };

    // 曝光上报：fire-and-forget，永远不阻塞渲染
    if (exposureQueue && Object.keys(assignments).length > 0) {
      exposureQueue.push({
        anonId,
        userId: ctx.userId ?? null,
        requestId: ctx.requestId,
        experiments: assignments,
        path: stripQuery(req.url ?? '/'),
        ts: Date.now(),
      });
    }

    next();
  };
}
