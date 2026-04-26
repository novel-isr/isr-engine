/**
 * Vercel Edge Functions adapter
 *
 * 两种挂法：
 *
 * 1) 作为 **Edge Function**（业务主入口，返回完整 HTML）—— 用 `toVercelEdge`：
 *
 *    // api/[[...slug]].ts
 *    import handler from '../src/entry.server';
 *    import { toVercelEdge } from '@novel-isr/engine/adapters/runtime';
 *    export const config = { runtime: 'edge' };
 *    export default toVercelEdge(handler);
 *
 * 2) 作为 **Edge Middleware**（rewrite / 挡路 / 注入头，位于业务函数之前）—— 用 `toVercelMiddleware`：
 *
 *    // middleware.ts
 *    import handler from './src/entry.server';
 *    import { toVercelMiddleware } from '@novel-isr/engine/adapters/runtime';
 *    export default toVercelMiddleware(handler, {
 *      // 返回 passthrough 的路径 —— 让请求继续去 origin / 另一个函数
 *      shouldPassthrough: (req) => !req.url.includes('/rsc'),
 *    });
 *
 * Vercel Edge 是 Web Standards 子集（V8 isolates）—— 与 Cloudflare 类似的限制。
 */
import type { FetchHandler } from './types';

export type VercelEdgeHandler = (request: Request) => Promise<Response>;

/**
 * Edge Function 模式：原样接管请求，返回 Response。
 *
 * Vercel 透出的 `request` 上带有扩展字段（`request.geo`、`request.ip`）。
 * handler 内部如需使用，可 `(request as any).geo` 读取 —— engine 不强类型绑定
 * 以避免对 `@vercel/edge` 形成硬依赖。
 */
export function toVercelEdge(handler: FetchHandler): VercelEdgeHandler {
  return async function vercelEdgeHandler(request: Request): Promise<Response> {
    try {
      return await handler.fetch(request);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return new Response(`Internal Edge Error: ${msg}`, { status: 500 });
    }
  };
}

export interface VercelMiddlewareOptions {
  /**
   * 判断是否直接 passthrough（返回 undefined → Vercel 继续走后端路由）。
   * 返回 true 则跳过 handler、让请求继续走 origin。
   * 未提供 → 所有请求都接管返回 Response（等同 toVercelEdge）。
   */
  shouldPassthrough?: (request: Request) => boolean;
  /**
   * 如果想在 passthrough 时注入响应头（常用：traceId / variant / geo 摘要）。
   * 返回 { [name]: value } —— 框架会转成 `x-middleware-request-<name>` 供后端函数读取。
   */
  injectRequestHeaders?: (request: Request) => Record<string, string> | undefined;
}

export type VercelMiddlewareHandler = (request: Request) => Promise<Response | undefined>;

/**
 * Edge Middleware 模式：
 *   - 需要拦截 → 返回 Response
 *   - 需要放行 → 返回 undefined（Vercel 继续原路由）
 *
 * 这是 `middleware.ts` 标准契约；和 Edge Function 模式（toVercelEdge）语义不同，
 * 不能混用。
 */
export function toVercelMiddleware(
  handler: FetchHandler,
  options: VercelMiddlewareOptions = {}
): VercelMiddlewareHandler {
  return async function vercelMiddlewareHandler(request: Request): Promise<Response | undefined> {
    try {
      if (options.shouldPassthrough?.(request)) {
        const injectHeaders = options.injectRequestHeaders?.(request);
        if (injectHeaders && Object.keys(injectHeaders).length > 0) {
          // Vercel middleware 要通过特殊响应头传递"注入到下游请求"的头部
          const res = new Response(null, { status: 200 });
          for (const [k, v] of Object.entries(injectHeaders)) {
            res.headers.set(`x-middleware-request-${k}`, v);
          }
          res.headers.set('x-middleware-next', '1');
          return res;
        }
        return undefined;
      }
      return await handler.fetch(request);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return new Response(`Internal Edge Error: ${msg}`, { status: 500 });
    }
  };
}
