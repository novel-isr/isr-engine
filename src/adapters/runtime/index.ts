/**
 * Edge runtime adapters —— 把 defineServerEntry 的 fetch handler 适配到各平台
 *
 *   import { toCloudflareWorker } from '@novel-isr/engine/adapters/runtime';
 *   import { toVercelEdge } from '@novel-isr/engine/adapters/runtime';
 *   import { toDenoHandler, toBunServer } from '@novel-isr/engine/adapters/runtime';
 */
export {
  toCloudflareWorker,
  type CloudflareAdapterOptions,
  type CloudflareWorker,
} from './cloudflare';
export { toVercelEdge, type VercelEdgeHandler } from './vercel-edge';
export { toDenoHandler, toBunServer, type DenoHandler, type BunServerConfig } from './deno';
export type { FetchHandler, CloudflareExecutionContext } from './types';
