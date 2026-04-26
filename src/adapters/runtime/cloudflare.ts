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
 *     // 可选：把 env / ctx.waitUntil 通过 beforeFetch 暴露给 handler（常用于 ISR bg revalidate）
 *     beforeFetch: (req, env, ctx) => {
 *       globalThis.__isrEdgeCtx = { env, waitUntil: ctx.waitUntil.bind(ctx) };
 *     },
 *   });
 *
 * 限制（务必读 README ROADMAP "Edge runtime"）：
 *   - 不能用 helmet/compression（非 Web API 中间件）—— Cloudflare 自带边缘安全 + 自动 br/gzip
 *   - 不能用 fs / sharp —— 图片优化端点要走 Cloudflare Images 或 @cf/wasm/sharp
 *   - L1 内存 LRU 在 Workers 里仍然有效（每个 isolate 一份），但跨 region 不共享
 *   - 跨请求持久状态走 KV / R2 / Durable Objects（由 `env` 传入；engine 本身不耦合任何一个）
 */
import type { FetchHandler, CloudflareExecutionContext } from './types';

/** Cloudflare 为 Workers 注入的边缘上下文 —— 暴露给 handler 用于调度后台任务 / 访问 binding */
export interface CloudflareEdgeContext {
  env: Record<string, unknown>;
  /**
   * 把 Promise 交给平台，让它在 response 返回后继续完成（ISR 后台重渲、审计日志上报）。
   * 直接引用 `ctx.waitUntil` 可能丢 this —— 已在 beforeFetch 默认实现中 bind 好。
   */
  waitUntil: (p: Promise<unknown>) => void;
}

export interface CloudflareAdapterOptions {
  /**
   * fetch 前的钩子 —— 暴露 env / ctx 供 handler 访问 KV / R2 / waitUntil。
   * 默认实现：写入 `globalThis.__isrEdgeCtx`（与 engine 运行时约定），
   * 这样业务代码可 `import { getEdgeContext } from '@novel-isr/engine/runtime'` 拿到。
   */
  beforeFetch?: (
    req: Request,
    env: Record<string, unknown>,
    ctx: CloudflareExecutionContext
  ) => void | Promise<void>;
  /** 是否在异常时回源（默认 true，即调用 `ctx.passThroughOnException()`） */
  passThroughOnException?: boolean;
}

export interface CloudflareWorker {
  fetch(
    request: Request,
    env: Record<string, unknown>,
    ctx: CloudflareExecutionContext
  ): Promise<Response>;
}

/**
 * 默认 beforeFetch：把 env + waitUntil 暴露到 globalThis。
 * engine 运行时（或用户代码）可读 `(globalThis as any).__isrEdgeCtx` 取回。
 * 每次请求都覆写 —— CF Workers 的全局是 per-isolate 但 request-level 不隔离，
 * 所以依赖这个的代码必须在本 tick 内立即使用，不能跨 await（微任务边界 OK，宏任务危险）。
 */
function installDefaultEdgeCtx(
  _req: Request,
  env: Record<string, unknown>,
  ctx: CloudflareExecutionContext
): void {
  const edge: CloudflareEdgeContext = {
    env,
    waitUntil: ctx.waitUntil.bind(ctx),
  };
  (globalThis as unknown as { __isrEdgeCtx?: CloudflareEdgeContext }).__isrEdgeCtx = edge;
}

export function toCloudflareWorker(
  handler: FetchHandler,
  options: CloudflareAdapterOptions = {}
): CloudflareWorker {
  const passThrough = options.passThroughOnException !== false;
  const before = options.beforeFetch ?? installDefaultEdgeCtx;
  return {
    async fetch(request, env, ctx) {
      try {
        if (passThrough) ctx.passThroughOnException();
        await before(request, env, ctx);
        return await handler.fetch(request);
      } catch (err) {
        // 边缘场景：Worker 抛错会被 CF 显示成 1101，我们包成 5xx 让客户端可恢复
        const msg = err instanceof Error ? err.message : String(err);
        return new Response(`Internal Edge Error: ${msg}`, { status: 500 });
      }
    },
  };
}
