/**
 * Vite 插件公共入口
 *
 * 对外暴露：
 *   - `createIsrPlugin`：一体化工厂，组合 @vitejs/plugin-rsc + @vitejs/plugin-react
 *     + engine 自研的 ISR 缓存中间件
 *   - `createIsrCacheHandler`：框架无关的 ISR 缓存 handler（可挂到 Express 等任意 connect-style 链）
 */

export { createIsrPlugin, type CreateIsrPluginOptions } from './createIsrPlugin';
export {
  createIsrCacheMiddleware,
  createIsrCacheHandler,
  type IsrCacheMiddlewareOptions,
  type IsrCacheHandler,
  type IsrInvalidationBus,
  type IsrInvalidationTarget,
} from './isrCacheMiddleware';
