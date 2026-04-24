/**
 * Cloudflare Workers adapter
 *
 * 用户态：
 *   // src/worker.ts —— Cloudflare 部署入口
 *   import handler from './entry.server';
 *   import { toCloudflareWorker } from '@novel-isr/engine/adapters/runtime';
 *   export default toCloudflareWorker(handler, {
 *     // 可选：把 cf KV 注入为 isr cache 的 L2 后端
 *     cacheKVBinding: 'ISR_CACHE',
 *   });
 *
 * 限制（务必读 README ROADMAP "Edge runtime"）：
 *   - 不能用 helmet/compression（非 Web API 中间件）—— Cloudflare 自带边缘安全 + 自动 br/gzip
 *   - 不能用 fs / sharp —— 图片优化端点要走 Cloudflare Images 或 @cf/wasm/sharp
 *   - L1 内存 LRU 在 Workers 里仍然有效（每个 isolate 一份），但跨 region 不共享
 */
import type { FetchHandler, CloudflareExecutionContext } from './types';

export interface CloudflareAdapterOptions {
  /** 包装 fetch 时的钩子 —— 例如把 env / ctx.waitUntil 暴露给 hook */
  beforeFetch?: (
    req: Request,
    env: Record<string, unknown>,
    ctx: CloudflareExecutionContext
  ) => void | Promise<void>;
}

export interface CloudflareWorker {
  fetch(
    request: Request,
    env: Record<string, unknown>,
    ctx: CloudflareExecutionContext
  ): Promise<Response>;
}

export function toCloudflareWorker(
  handler: FetchHandler,
  options: CloudflareAdapterOptions = {}
): CloudflareWorker {
  return {
    async fetch(request, env, ctx) {
      try {
        if (options.beforeFetch) await options.beforeFetch(request, env, ctx);
        // ctx.passThroughOnException 让平台在我们抛错时回源 origin（如有配置）
        ctx.passThroughOnException();
        return await handler.fetch(request);
      } catch (err) {
        // 边缘场景：Worker 抛错会被 CF 显示成 1101，我们包成 5xx 让客户端可恢复
        const msg = err instanceof Error ? err.message : String(err);
        return new Response(`Internal Edge Error: ${msg}`, { status: 500 });
      }
    },
  };
}
