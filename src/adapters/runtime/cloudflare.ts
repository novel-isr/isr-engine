/**
 * Cloudflare Workers adapter
 *
 * 用法：通过 getEdgeContext(request) 访问当前请求的 env / waitUntil。
 * 上下文也作为 handler.fetch(request, context) 的第二个参数传入。
 *
 * 限制（务必读 README ROADMAP "Edge runtime"）：
 *   - 不能用 helmet/compression（非 Web API 中间件）—— Cloudflare 自带边缘安全 + 自动 br/gzip
 *   - 不能用 fs / sharp —— 图片优化端点要走 Cloudflare Images 或 @cf/wasm/sharp
 *   - L1 内存 LRU 在 Workers 里仍然有效（每个 isolate 一份），但跨 region 不共享
 *   - 跨请求持久状态走 KV / R2 / Durable Objects（由 `env` 传入；engine 本身不耦合任何一个）
 */
import type { FetchHandler, CloudflareExecutionContext } from './types';
import { createEdgeErrorResponse } from './errorResponse';
import { bindEdgeContext, type EdgeContext } from '../../runtime/edge-context';

/** Cloudflare 为 Workers 注入的边缘上下文 —— 暴露给 handler 用于调度后台任务 / 访问 binding */
export type CloudflareEdgeContext<Env extends Record<string, unknown> = Record<string, unknown>> =
  EdgeContext<Env>;

export interface CloudflareAdapterOptions {
  /**
   * 上下文绑定后的可选钩子，可在异步准备期间通过 getEdgeContext(req) 访问上下文。
   * 自定义钩子不影响默认的请求上下文绑定。
   */
  beforeFetch?: (
    req: Request,
    env: Record<string, unknown>,
    ctx: CloudflareExecutionContext
  ) => void | Promise<void>;
  /**
   * 默认 true：未消费请求体时向平台传播异常，触发原生回源。
   * 请求体已消费或锁定后无法安全重放，此时返回受控 500；false 始终返回受控 500。
   */
  passThroughOnException?: boolean;
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
  const passThrough = options.passThroughOnException !== false;
  return {
    async fetch(request, env, ctx) {
      try {
        if (passThrough) ctx.passThroughOnException();
        const edge: CloudflareEdgeContext = { env, waitUntil: ctx.waitUntil.bind(ctx) };
        bindEdgeContext(request, edge);
        await options.beforeFetch?.(request, env, ctx);
        return await handler.fetch(request, edge);
      } catch (err) {
        if (passThrough && !request.bodyUsed && !request.body?.locked) throw err;
        return createEdgeErrorResponse('cloudflare', err);
      }
    },
  };
}
