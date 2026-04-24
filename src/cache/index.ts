/**
 * 缓存子系统导出
 *
 * 提供可切换的缓存后端（memory / redis），供 ISREngine 的持久化场景使用。
 * 当前 ISR 请求级缓存由 `plugin/isrCacheMiddleware.ts` 的 in-process LRU 承担；
 * 本模块为用户代码和未来的多层缓存（如 SSG 元数据持久化）保留扩展位。
 */

export { CacheManager } from './CacheManager';
export type { CacheManagerConfig, CacheStrategy } from './CacheManager';
export type {
  ICacheAdapter,
  CacheSetOptions,
  CacheStats,
  CacheEntry,
  CacheEntryMeta,
} from './ICacheAdapter';
export { MemoryCacheAdapter } from './MemoryCacheAdapter';
export type { MemoryCacheConfig } from './MemoryCacheAdapter';
export { RedisCacheAdapter } from './RedisCacheAdapter';
export type { RedisCacheConfig } from './RedisCacheAdapter';
