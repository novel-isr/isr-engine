/**
 * 缓存子系统导出
 *
 * 提供可切换的缓存后端（memory / redis），供 ISREngine 的持久化场景使用。
 * ISR 响应缓存通过显式的 ResponseCacheBackend 原子协议校验 revision；
 * 通用 ICacheAdapter 保留独立的应用数据缓存及降级策略。
 */

export { CacheManager } from './CacheManager';
export type { CacheManagerConfig, CacheStrategy } from './CacheManager';
export type { ICacheAdapter, CacheSetOptions, CacheEntry, CacheEntryMeta } from './ICacheAdapter';
export { MemoryCacheAdapter } from './MemoryCacheAdapter';
export type { MemoryCacheConfig } from './MemoryCacheAdapter';
export { RedisCacheAdapter } from './RedisCacheAdapter';
export type { RedisCacheConfig } from './RedisCacheAdapter';
export { RedisInvalidationBus } from './RedisInvalidationBus';
export type { RedisInvalidationBusConfig } from './RedisInvalidationBus';

export type {
  CacheRenderLease,
  ResponseCacheBackend,
  ResponseCacheSnapshot,
} from './ResponseCacheBackend';
