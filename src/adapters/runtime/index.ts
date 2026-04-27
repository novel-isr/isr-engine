/**
 * Edge runtime adapters —— 把 defineServerEntry 的 fetch handler 适配到各平台
 *
 *   import { toCloudflareWorker } from '@novel-isr/engine/adapters/runtime';
 *   import { toVercelEdge } from '@novel-isr/engine/adapters/runtime';
 */
export {
  toCloudflareWorker,
  type CloudflareAdapterOptions,
  type CloudflareWorker,
  type CloudflareEdgeContext,
} from './cloudflare';
export {
  toVercelEdge,
  toVercelMiddleware,
  type VercelEdgeHandler,
  type VercelMiddlewareHandler,
  type VercelMiddlewareOptions,
} from './vercel-edge';
export type { FetchHandler, CloudflareExecutionContext } from './types';
