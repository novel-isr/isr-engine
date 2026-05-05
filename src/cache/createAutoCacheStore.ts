/**
 * createAutoCacheStore —— 按环境变量自动选 cache backend
 *
 * 决策：
 *   - REDIS_URL 或 REDIS_HOST 已设 → HybridCacheStore（L1 LRU + L2 Redis 写穿）
 *   - 都未设               → MemoryCacheStore（单层 LRU，行为不变）
 *
 * 应用通常在 ssr.config.ts 写 `runtime.redis.url: process.env.REDIS_URL`。
 * 如果未显式传入，engine 仍会读取 REDIS_URL / REDIS_HOST 作为兜底。
 */
import {
  createMemoryCacheStore,
  createHybridCacheStore,
  type IsrCacheStore,
} from '../plugin/isrCacheStore';
import { RedisCacheAdapter } from './RedisCacheAdapter';
import { Logger } from '../logger/Logger';
import { resolveRuntimeRedisConfig } from '@/config/resolveRuntimeRedis';

const logger = Logger.getInstance();

export interface AutoCacheStoreOptions {
  /** L1 LRU 容量，默认 1000 */
  max?: number;
  /** Redis 连接 URL；不传则读 process.env.REDIS_URL */
  redisUrl?: string;
  /** Redis host；不传则读 process.env.REDIS_HOST */
  redisHost?: string;
  /** Redis port；不传则读 process.env.REDIS_PORT 或 6379 */
  redisPort?: number;
  /** Redis 密码；不传则读 process.env.REDIS_PASSWORD */
  redisPassword?: string;
  /** keyPrefix，默认 'isr:' */
  redisKeyPrefix?: string;
}

export function createAutoCacheStore(opts: AutoCacheStoreOptions = {}): IsrCacheStore {
  // 优先级：显式参数（通常来自 ssr.config.ts runtime.redis）> 环境变量
  const redisConfig = resolveRuntimeRedisConfig({
    url: opts.redisUrl,
    host: opts.redisHost,
    port: opts.redisPort,
    password: opts.redisPassword,
    keyPrefix: opts.redisKeyPrefix,
  });
  const url = redisConfig?.url;
  const host = redisConfig?.host;
  const max = opts.max ?? 1000;

  if (!url && !host) {
    logger.info('🗂️  ISR cache backend: memory (未检测到 REDIS_URL/REDIS_HOST)');
    return createMemoryCacheStore({ max });
  }

  const redis = new RedisCacheAdapter({
    url,
    host,
    port: redisConfig?.port ?? 6379,
    password: redisConfig?.password,
    keyPrefix: redisConfig?.keyPrefix ?? 'isr:',
    enableFallback: true, // Redis 挂了仍保有内存兜底
  });
  logger.info(
    `🗂️  ISR cache backend: hybrid (L1 LRU + L2 Redis ${url ?? `${host}:${redisConfig?.port ?? 6379}`})`
  );
  return createHybridCacheStore({
    redis,
    max,
    onRedisError: (err, op, key) => {
      logger.warn(`Redis ${op} 失败 [${key ?? '-'}]:`, err);
    },
  });
}
