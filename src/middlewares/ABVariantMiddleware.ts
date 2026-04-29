/**
 * A/B Variant Middleware —— 服务端实验分组（OKX/字节同款 cookie-sticky 模式）
 *
 * 设计取舍：
 *   - **不**做完整 A/B 平台（用 GrowthBook/Statsig/Optimizely 那种）
 *     → 那是数据团队的 SaaS / 后端服务的工作
 *   - 只做 engine 该做的事：
 *     1. 首次访问：根据 weights 选 variant + 写 cookie
 *     2. 后续访问：从 cookie 读取（sticky session，避免 SEO/分析数据被搞乱）
 *     3. 把 variant 暴露到 RSC 渲染 context（Server Component 用 getVariant 读取）
 *
 * 一致性：同一 user 同一 experiment 永远拿到同一 variant（cookie 或 hash(uid+exp)）。
 *
 * 用法：
 *
 *   import { createABVariantMiddleware, getVariant } from '@novel-isr/engine';
 *
 *   // 在 server.ts / cli/start.ts 注册（engine 默认已经接好；用户传 experiments 即可）
 *   app.use(createABVariantMiddleware({
 *     experiments: {
 *       'home-hero': { variants: ['classic', 'hero-v2'], weights: [50, 50] },
 *       'pricing-page': { variants: ['control', 'discount-banner'], weights: [70, 30] },
 *     },
 *     cookieName: 'ab',
 *     cookieMaxAge: 30 * 86400_000,  // 30 days
 *   }));
 *
 *   // Server Component 里读：
 *   import { getVariant } from '@novel-isr/engine';
 *   export async function HomePage() {
 *     const v = getVariant('home-hero');   // → 'classic' | 'hero-v2'
 *     return v === 'hero-v2' ? <HeroV2/> : <HeroClassic/>;
 *   }
 *
 * 缓存：配置 runtime.experiments 后，ISR cache 默认把 ab cookie 摘要纳入 key；
 *      同一路径不同 variant 各自缓存，避免 A 组拿到 B 组 HTML。
 *      若显式关闭 variantIsolation，必须保证实验不影响 HTML/SEO。
 */
import type { Request, Response, NextFunction } from 'express';
import { getRequestContext } from '../context/RequestContext';
import { readCookie } from '../utils/cookie';

export { getVariant } from './abVariantContext';

export interface ExperimentConfig {
  /** 变体列表 */
  variants: readonly string[];
  /** 权重（与 variants 同长；和不必为 100）；不传 → 平均分 */
  weights?: readonly number[];
}

export interface ABVariantOptions {
  /** 实验定义：experimentName → { variants, weights } */
  experiments: Record<string, ExperimentConfig>;
  /** cookie 名；默认 'ab' */
  cookieName?: string;
  /** cookie 有效期（毫秒）；默认 30 天 */
  cookieMaxAge?: number;
  /** 自定义分组逻辑（覆盖默认随机）；如按 userId hash */
  assigner?: (req: Request, name: string, exp: ExperimentConfig) => string;
}

function pickWeighted(variants: readonly string[], weights?: readonly number[]): string {
  if (!weights || weights.length !== variants.length) {
    return variants[Math.floor(Math.random() * variants.length)];
  }
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < variants.length; i++) {
    r -= weights[i];
    if (r <= 0) return variants[i];
  }
  return variants[variants.length - 1];
}

/** cookie 编码：'home-hero=hero-v2|pricing-page=control' */
function parseCookie(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of raw.split('|')) {
    const [k, v] = pair.split('=');
    if (k && v) out[k] = v;
  }
  return out;
}

function encodeCookie(map: Record<string, string>): string {
  return Object.entries(map)
    .map(([k, v]) => `${k}=${v}`)
    .join('|');
}

export function createABVariantMiddleware(options: ABVariantOptions) {
  const { experiments, cookieName = 'ab', cookieMaxAge = 30 * 86400_000, assigner } = options;

  return function abMiddleware(req: Request, res: Response, next: NextFunction): void {
    const existingRaw = readCookie(req, cookieName);
    const existing = existingRaw ? parseCookie(existingRaw) : {};
    const assignments: Record<string, string> = { ...existing };

    let mutated = false;
    for (const [name, exp] of Object.entries(experiments)) {
      const current = existing[name];
      // 已有 + 仍在 variants 列表里 → sticky；否则重新分配
      if (current && exp.variants.includes(current)) {
        assignments[name] = current;
        continue;
      }
      const picked = assigner ? assigner(req, name, exp) : pickWeighted(exp.variants, exp.weights);
      assignments[name] = picked;
      mutated = true;
    }

    if (mutated) {
      const value = encodeURIComponent(encodeCookie(assignments));
      const flags = `Max-Age=${Math.floor(cookieMaxAge / 1000)}; Path=/; SameSite=Lax`;
      res.appendHeader('Set-Cookie', `${cookieName}=${value}; ${flags}`);
    }

    // 注入 RequestContext.flags，让 Server Component 用 getVariant() 读取
    const ctx = getRequestContext();
    if (ctx) {
      ctx.flags = { ...(ctx.flags ?? {}), ...assignments };
    }

    next();
  };
}
