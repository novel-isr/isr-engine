/**
 * createAutoCacheStore —— 按显式 Redis 配置选择 cache backend
 *
 * 决策：
 *   - runtime.redis.url/host 已设 → revision-validated response cache（Redis 原子协议 + 本机字节缓存）
 *   - 未显式配置 Redis          → MemoryCacheStore（单层 LRU，行为不变）
 */
import { createMemoryCacheStore, type IsrCacheStore } from '../plugin/isrCacheStore';
import { createCoherentCacheStore } from '../plugin/coherentCacheStore';
import { RedisCacheAdapter } from './RedisCacheAdapter';
import { Logger } from '../logger/Logger';
import { resolveRuntimeRedisConfig } from '@/config/resolveRuntimeRedis';

const logger = Logger.getInstance();

export interface AutoCacheStoreOptions {
  /** L1 LRU 容量，默认 1000 */
  max?: number;
  /** Explicit environment/application scope for coherent response state. */
  responseNamespace?: string;
  /** Redis 连接 URL；通常来自 ssr.config.ts runtime.redis.url */
  redisUrl?: string;
  /** Redis host；通常来自 ssr.config.ts runtime.redis.host */
  redisHost?: string;
  /** Redis port */
  redisPort?: number;
  /** Redis 密码 */
  redisPassword?: string;
  /** keyPrefix，默认 'isr:' */
  redisKeyPrefix?: string;
}

export function createAutoCacheStore(opts: AutoCacheStoreOptions = {}): IsrCacheStore {
  const redisConfig = resolveRuntimeRedisConfig({
    url: opts.redisUrl,
    host: opts.redisHost,
    port: opts.redisPort,
    password: opts.redisPassword,
    keyPrefix: opts.redisKeyPrefix,
    invalidationChannel: undefined,
  });
  const url = redisConfig?.url;
  const host = redisConfig?.host;
  const max = opts.max ?? 1000;

  if (!url && !host) {
    logger.info('🗂️  ISR cache backend: memory (runtime.redis 未配置连接地址)');
    return createMemoryCacheStore({ max });
  }

  const redis = new RedisCacheAdapter({
    url,
    host,
    port: redisConfig?.port ?? 6379,
    password: redisConfig?.password,
    keyPrefix: redisConfig?.keyPrefix ?? 'isr:',
    enableFallback: false, // Coherent admission must never claim a local write is durable.
  });
  logger.info('🗂️  ISR cache backend: Redis revision-validated response protocol');
  return createCoherentCacheStore({
    backend: redis.createResponseCacheBackend(opts.responseNamespace ?? 'isr:responses:v1'),
    max,
  });
}
