/**
 * createAutoCacheStore —— 按环境变量自动选 cache backend
 *
 * 决策：
 *   - REDIS_URL 或 REDIS_HOST 已设 → HybridCacheStore（L1 LRU + L2 Redis 写穿）
 *   - 都未设               → MemoryCacheStore（单层 LRU，行为不变）
 *
 * 用户 zero-config 不动代码，只需在 `.env` 加 REDIS_URL=redis://... 就自动启用 Redis。
 */
import {
  createMemoryCacheStore,
  createHybridCacheStore,
  type IsrCacheStore,
} from '../plugin/isrCacheStore';
import { RedisCacheAdapter } from './RedisCacheAdapter';
import { Logger } from '../logger/Logger';

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
  // 优先级：显式参数 > FaaS 配置（user 传 opts）> 环境变量
  const url = opts.redisUrl ?? process.env.REDIS_URL;
  const host = opts.redisHost ?? process.env.REDIS_HOST;
  const max = opts.max ?? 1000;

  if (!url && !host) {
    logger.info('🗂️  ISR cache backend: memory (未检测到 REDIS_URL/REDIS_HOST)');
    return createMemoryCacheStore({ max });
  }

  const portRaw =
    opts.redisPort ?? (process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT, 10) : undefined);
  const password = opts.redisPassword ?? process.env.REDIS_PASSWORD;

  const redis = new RedisCacheAdapter({
    url,
    host,
    port: portRaw ?? 6379,
    password,
    keyPrefix: opts.redisKeyPrefix ?? 'isr:',
    enableFallback: true, // Redis 挂了仍保有内存兜底
  });
  logger.info(
    `🗂️  ISR cache backend: hybrid (L1 LRU + L2 Redis ${url ?? `${host}:${portRaw ?? 6379}`})`
  );
  return createHybridCacheStore({
    redis,
    max,
    onRedisError: (err, op, key) => {
      logger.warn(`Redis ${op} 失败 [${key ?? '-'}]:`, err);
    },
  });
}
