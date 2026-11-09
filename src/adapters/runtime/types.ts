import type { EdgeContext } from '../../runtime/edge-context';

/**
 * Edge runtime 适配器统一契约
 *
 * Web Fetch handlers may return a Response directly or asynchronously.
 * defineServerEntry uses the asynchronous form; platform adapters accept both.
 *
 *   Cloudflare Workers : `export default { fetch }`
 *   Vercel Edge        : `export default function handler(req) { ... }`
 *   Deno Deploy        : `Deno.serve(fetch)`
 *   Bun                : `export default { port, fetch }`
 *   Netlify Edge       : `export default async (req) => fetch(req)`
 *
 * Engine 不重写 server 协议；adapter 只做平台 glue。
 */
export interface FetchHandler<Env extends object = Record<string, unknown>> {
  fetch(
    request: Request,
    context?: EdgeContext<Env>,
    ...rest: unknown[]
  ): Response | Promise<Response>;
}

/** Cloudflare Workers 的 ExecutionContext 形状（仅用我们关心的字段，避免依赖 @cloudflare/workers-types）*/
export interface CloudflareExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}
