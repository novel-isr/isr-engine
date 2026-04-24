/**
 * Vercel Edge Functions adapter
 *
 * 用户态：
 *   // api/[[...slug]].ts —— Vercel Edge 路由
 *   import handler from '../src/entry.server';
 *   import { toVercelEdge } from '@novel-isr/engine/adapters/runtime';
 *   export const config = { runtime: 'edge' };
 *   export default toVercelEdge(handler);
 *
 * Vercel Edge 是 Web Standards 子集（V8 isolates）—— 与 Cloudflare 类似的限制。
 */
import type { FetchHandler } from './types';

export type VercelEdgeHandler = (request: Request) => Promise<Response>;

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
