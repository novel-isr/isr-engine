/**
 * Deno Deploy / Deno serve adapter
 *
 * 用户态：
 *   // server.ts
 *   import handler from './src/entry.server.ts';
 *   import { toDenoHandler } from '@novel-isr/engine/adapters/runtime';
 *   Deno.serve({ port: 8000 }, toDenoHandler(handler));
 *
 * Deno.serve 已经是 Web Fetch 形状，几乎无需 wrapper —— 但保留薄包装方便统一错误处理 / 日志。
 */
import type { FetchHandler } from './types';

export type DenoHandler = (request: Request) => Promise<Response>;

export function toDenoHandler(handler: FetchHandler): DenoHandler {
  return async function denoServeHandler(request: Request): Promise<Response> {
    try {
      return await handler.fetch(request);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return new Response(`Internal Deno Error: ${msg}`, { status: 500 });
    }
  };
}

/**
 * Bun.serve 形状 —— 与 Deno 几乎一样，单独导出做语义区分
 *
 *   import { toBunServer } from '@novel-isr/engine/adapters/runtime';
 *   Bun.serve(toBunServer(handler, { port: 3000 }));
 */
export interface BunServerConfig {
  port: number;
  hostname?: string;
  fetch: DenoHandler;
}

export function toBunServer(
  handler: FetchHandler,
  options: { port: number; hostname?: string }
): BunServerConfig {
  return {
    port: options.port,
    hostname: options.hostname,
    fetch: toDenoHandler(handler),
  };
}
