/**
 * Edge runtime 适配器统一契约
 *
 * defineServerEntry 已经返回 `{ fetch(req) => Promise<Response> }` —— 这正是 Web Fetch
 * 标准的 server handler 形状。各个 Edge 平台只需要薄薄一层 wrapper：
 *
 *   Cloudflare Workers : `export default { fetch }`
 *   Vercel Edge        : `export default function handler(req) { ... }`
 *   Deno Deploy        : `Deno.serve(fetch)`
 *   Bun                : `export default { port, fetch }`
 *   Netlify Edge       : `export default async (req) => fetch(req)`
 *
 * Engine 不重写 server 协议；adapter 只做平台 glue。
 */
export interface FetchHandler {
  fetch(request: Request, ...rest: unknown[]): Promise<Response>;
}

/** Cloudflare Workers 的 ExecutionContext 形状（仅用我们关心的字段，避免依赖 @cloudflare/workers-types）*/
export interface CloudflareExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}
