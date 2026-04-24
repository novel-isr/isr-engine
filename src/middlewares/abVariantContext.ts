/**
 * A/B variant 在 Server Component 里读取的 helper —— 与 express middleware 解耦
 *
 * RSC 环境通过本文件 import（不引入 express 类型，bundle 更轻）；
 * Express 中间件在 ABVariantMiddleware.ts。
 */
import { getRequestContext } from '../context/RequestContext';

/**
 * 在 Server Component 里读取 variant
 *
 * 不在 A/B middleware 后调用 → 返回 undefined
 */
export function getVariant(experimentName: string): string | undefined {
  const ctx = getRequestContext();
  const v = ctx?.flags?.[experimentName];
  return typeof v === 'string' ? v : undefined;
}
