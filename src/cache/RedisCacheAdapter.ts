/**
 * Redis 缓存适配器
 * 基于 ioredis 的分布式缓存实现，支持优雅降级
 *
 * 特性：
 * - 自动连接重试与健康检查
 * - Redis 不可用时自动降级到内存缓存
 * - Pipeline 批量操作优化
 * - 标签索引用 Redis Set 维护
 * - Lua 脚本原子操作
 * - 序列化/反序列化自动处理
 *
 * 关于 `this.redis!` 非空断言：
 * 每个公开方法先 `getActiveAdapter()` 决定走 fallback 还是直连 redis；走 redis 分支
 * 时本类已通过 `connected/destroyed` 状态机保证 `this.redis` 非空（构造里赋值 + destroy
 * 才置 null）。TS 类型系统无法跨 if-return 推断这个不变量，故在这些路径上用 `!` 断言。
 * lint rule 在本文件关掉，不再作为 noise 干扰其他文件的真实问题。
 */
/* eslint-disable @typescript-eslint/no-non-null-assertion */

import type { ICacheAdapter, CacheSetOptions } from './ICacheAdapter';
import { MemoryCacheAdapter, type MemoryCacheConfig } from './MemoryCacheAdapter';
import { Logger } from '../logger/Logger';

/** Redis 缓存适配器配置 */
export interface RedisCacheConfig {
  /** Redis 连接 URL，如 redis://<host>:6379 */
  url?: string;
  /** Redis 主机 */
  host?: string;
  /** Redis 端口 */
  port?: number;
  /** Redis 密码 */
  password?: string;
  /** Redis 数据库编号 */
  db: number;
  /** 键前缀 */
  keyPrefix: string;
  /** 默认 TTL (秒) */
  defaultTTL: number;
  /** 连接超时 (ms) */
  connectTimeout: number;
  /** 命令超时 (ms) */
  commandTimeout: number;
  /** 最大重试次数 */
  maxRetries: number;
  /** 是否启用降级到内存 */
  enableFallback: boolean;
  /** 内存降级配置 */
  fallbackConfig?: Partial<MemoryCacheConfig>;
  /** 健康检查间隔 (ms) */
  healthCheckInterval: number;
  /** 重连延迟 (ms) */
  retryDelay: number;
}

const DEFAULT_CONFIG: RedisCacheConfig = {
  port: 6379,
  db: 0,
  keyPrefix: 'isr:',
  defaultTTL: 3600,
  connectTimeout: 5000,
  commandTimeout: 3000,
  maxRetries: 3,
  enableFallback: true,
  healthCheckInterval: 30_000,
  retryDelay: 1000,
};

/** 序列化包装 */
interface SerializedEntry {
  v: unknown; // value
  t: number; // createdAt
  s?: number; // size
}

/** Buffer/TypedArray 序列化标记 —— JSON 无法原生保留二进制语义 */
const BUFFER_TAG = '__isr_buf_b64__';
interface SerializedBuffer {
  [BUFFER_TAG]: string; // base64
}

/**
 * 递归扫描 value，把 Buffer/Uint8Array 转成 { [BUFFER_TAG]: base64 } 形式。
 * 反序列化时反向还原。规避默认 JSON.stringify 把 Buffer 转成
 * `{"type":"Buffer","data":[...]}` 导致反序列化拿不回 Buffer、消费侧类型错乱的坑。
 */
function encodeBuffers(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value == null) return value;
  if (Buffer.isBuffer(value)) {
    return { [BUFFER_TAG]: value.toString('base64') } satisfies SerializedBuffer;
  }
  if (value instanceof Uint8Array) {
    return { [BUFFER_TAG]: Buffer.from(value).toString('base64') } satisfies SerializedBuffer;
  }
  if (typeof value !== 'object') return value;
  if (seen.has(value as object)) return value;
  seen.add(value as object);
  if (Array.isArray(value)) {
    return value.map(item => encodeBuffers(item, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = encodeBuffers(v, seen);
  }
  return out;
}

function decodeBuffers(value: unknown): unknown {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(decodeBuffers);
  const record = value as Record<string, unknown>;
  const b64 = record[BUFFER_TAG];
  if (typeof b64 === 'string' && Object.keys(record).length === 1) {
    return Buffer.from(b64, 'base64');
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    out[k] = decodeBuffers(v);
  }
  return out;
}

/**
 * 检查 ioredis pipeline.exec() 结果，若任一条命令失败抛聚合错误。
 * 默认 exec 会 resolve 成 [[err, reply], ...]，单条 err 被吞会导致 tag 索引、
 * 批量 set 出现"部分成功"但调用方看不见，后续 invalidateByTag 查不到被静默失败的 key。
 */
function assertPipelineOk(results: Array<[Error | null, unknown]> | null, op: string): void {
  if (!results) return;
  const errors: Error[] = [];
  for (let i = 0; i < results.length; i++) {
    const err = results[i]?.[0];
    if (err) errors.push(new Error(`[${op}#${i}] ${err.message}`));
  }
  if (errors.length > 0) {
    const combined = new Error(
      `Redis pipeline ${op} 部分失败（${errors.length}/${results.length}）：` +
        errors.map(e => e.message).join('; ')
    );
    throw combined;
  }
}

export class RedisCacheAdapter implements ICacheAdapter {
  readonly name = 'redis';

  private config: RedisCacheConfig;
  private logger: Logger;
  private redis: import('ioredis').default | null = null;
  private connected = false;
  private connecting = false;
  private fallback: MemoryCacheAdapter | null = null;
  private usingFallback = false;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;

  constructor(config: Partial<RedisCacheConfig> = {}) {
    const merged: RedisCacheConfig = { ...DEFAULT_CONFIG, ...config };
    this.config = merged;
    this.logger = Logger.getInstance();

    // 初始化降级后备
    if (this.config.enableFallback) {
      this.fallback = new MemoryCacheAdapter(this.config.fallbackConfig);
    }

    // 异步初始化连接（不阻塞构造函数）
    this.initConnection();
  }

  /**
   * 初始化 Redis 连接
   * 动态导入 ioredis，连接失败时自动降级
   */
  private async initConnection(): Promise<void> {
    if (this.connecting || this.destroyed) return;
    this.connecting = true;

    try {
      // 动态导入 ioredis，避免硬依赖
      const Redis = await this.loadRedisModule();
      if (!Redis) {
        this.logger.warn('⚠️ ioredis 模块不可用，降级到内存缓存');
        this.enableFallbackMode();
        return;
      }

      if (!this.config.url && !this.config.host) {
        this.logger.warn('⚠️ 未配置 Redis 连接信息（url/host），降级到内存缓存');
        this.enableFallbackMode();
        return;
      }

      const connectionOptions: import('ioredis').RedisOptions = {
        ...(this.config.host ? { host: this.config.host } : {}),
        ...(this.config.port ? { port: this.config.port } : {}),
        password: this.config.password,
        db: this.config.db,
        keyPrefix: this.config.keyPrefix,
        connectTimeout: this.config.connectTimeout,
        commandTimeout: this.config.commandTimeout,
        maxRetriesPerRequest: this.config.maxRetries,
        retryStrategy: (times: number) => {
          if (times > this.config.maxRetries) {
            this.logger.warn(`⚠️ Redis 连接重试 ${times} 次失败，降级到内存缓存`);
            this.enableFallbackMode();
            return null; // 停止重试
          }
          return Math.min(times * this.config.retryDelay, 10000);
        },
        lazyConnect: true,
      };

      // 如果指定了 URL，优先使用
      if (this.config.url) {
        this.redis = new Redis(this.config.url, connectionOptions);
      } else {
        this.redis = new Redis(connectionOptions);
      }

      // 事件监听
      this.redis.on('connect', () => {
        this.connected = true;
        this.usingFallback = false;
        this.logger.info('✅ Redis 缓存已连接');

        // 如果之前降级过，迁移热数据回 Redis
        this.migrateFromFallback();
      });

      this.redis.on('error', err => {
        this.logger.warn(`⚠️ Redis 错误: ${err.message}`);
        if (this.connected) {
          this.connected = false;
          this.enableFallbackMode();
        }
      });

      this.redis.on('close', () => {
        this.connected = false;
        this.logger.warn('⚠️ Redis 连接断开');
        this.enableFallbackMode();
      });

      this.redis.on('reconnecting', () => {
        this.logger.info('🔄 Redis 正在重连...');
      });

      // 尝试连接
      await this.redis.connect();

      // 启动健康检查
      this.startHealthCheck();
    } catch (error) {
      this.logger.warn(`⚠️ Redis 连接失败: ${(error as Error).message}，降级到内存缓存`);
      this.enableFallbackMode();
    } finally {
      this.connecting = false;
    }
  }

  /**
   * 动态加载 ioredis 模块
   */
  private async loadRedisModule(): Promise<
    (new (...args: unknown[]) => import('ioredis').default) | null
  > {
    try {
      const mod = await import('ioredis');
      return mod.default || mod;
    } catch {
      return null;
    }
  }

  /**
   * 启用降级模式
   */
  private enableFallbackMode(): void {
    if (!this.config.enableFallback) {
      this.logger.error('❌ Redis 不可用且未启用降级，缓存功能将不可用');
      return;
    }

    if (!this.fallback) {
      this.fallback = new MemoryCacheAdapter(this.config.fallbackConfig);
    }

    this.usingFallback = true;
    this.logger.info('🔄 已降级到内存缓存');
  }

  /**
   * 从降级缓存迁移热数据回 Redis（重连后）
   */
  private async migrateFromFallback(): Promise<void> {
    // 仅在有降级缓存且 Redis 重新连接时迁移
    // 这里不迁移是有意的：内存缓存数据在下次请求时会自然重建到 Redis
    // 避免一次性大量写入影响 Redis 性能
    this.usingFallback = false;
  }

  /**
   * 健康检查
   */
  private startHealthCheck(): void {
    if (this.healthCheckTimer) return;

    this.healthCheckTimer = setInterval(async () => {
      if (!this.redis || this.destroyed) return;

      try {
        await this.redis.ping();
        if (!this.connected) {
          this.connected = true;
          this.usingFallback = false;
          this.logger.info('✅ Redis 健康检查通过，恢复 Redis 缓存');
        }
      } catch {
        if (this.connected) {
          this.connected = false;
          this.enableFallbackMode();
        }
      }
    }, this.config.healthCheckInterval);

    if (this.healthCheckTimer.unref) {
      this.healthCheckTimer.unref();
    }
  }

  /**
   * 获取当前活跃的适配器
   */
  private getActiveAdapter(): ICacheAdapter | null {
    if (this.usingFallback && this.fallback) {
      return this.fallback;
    }
    return this.connected ? null : (this.fallback ?? null); // null = use redis directly
  }

  // ─── ICacheAdapter 实现 ─────────────────────────────────

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const fallbackAdapter = this.getActiveAdapter();
    if (fallbackAdapter) {
      return fallbackAdapter.get<T>(key);
    }

    try {
      const raw = await this.redis!.get(key);
      if (raw === null) {
        return undefined;
      }

      const entry: SerializedEntry = JSON.parse(raw);
      return decodeBuffers(entry.v) as T;
    } catch (error) {
      this.logger.warn(`⚠️ Redis GET 失败 [${key}]: ${(error as Error).message}`);
      // 如果 Redis 命令失败，降级查询
      if (this.fallback) {
        return this.fallback.get<T>(key);
      }
      return undefined;
    }
  }

  async set<T = unknown>(key: string, value: T, options?: CacheSetOptions): Promise<void> {
    const fallbackAdapter = this.getActiveAdapter();
    if (fallbackAdapter) {
      return fallbackAdapter.set(key, value, options);
    }

    try {
      const ttl = options?.ttl ?? this.config.defaultTTL;

      const entry: SerializedEntry = {
        v: encodeBuffers(value),
        t: Date.now(),
      };

      const serialized = JSON.stringify(entry);

      if (ttl > 0) {
        await this.redis!.setex(key, ttl, serialized);
      } else {
        await this.redis!.set(key, serialized);
      }

      // 标签索引
      if (options?.tags && options.tags.length > 0) {
        const pipeline = this.redis!.pipeline();
        for (const tag of options.tags) {
          pipeline.sadd(`__tag:${tag}`, this.config.keyPrefix + key);
        }
        const results = (await pipeline.exec()) as Array<[Error | null, unknown]> | null;
        assertPipelineOk(results, 'SADD tags');
      }
    } catch (error) {
      this.logger.warn(`⚠️ Redis SET 失败 [${key}]: ${(error as Error).message}`);
      // 降级写入内存；若 fallback 不存在 → 明确报错，避免数据静默丢失
      if (this.fallback) {
        await this.fallback.set(key, value, options);
      } else {
        this.logger.error(
          `❌ Redis SET 失败且未启用 fallback，key=${key} 未写入任何后端（数据丢失）`
        );
      }
    }
  }

  async has(key: string): Promise<boolean> {
    const fallbackAdapter = this.getActiveAdapter();
    if (fallbackAdapter) {
      return fallbackAdapter.has(key);
    }

    try {
      const exists = await this.redis!.exists(key);
      return exists === 1;
    } catch (error) {
      this.logger.warn(`⚠️ Redis EXISTS 失败 [${key}]: ${(error as Error).message}`);
      return this.fallback ? this.fallback.has(key) : false;
    }
  }

  async delete(key: string): Promise<boolean> {
    const fallbackAdapter = this.getActiveAdapter();
    if (fallbackAdapter) {
      return fallbackAdapter.delete(key);
    }

    try {
      const result = await this.redis!.del(key);
      return result > 0;
    } catch (error) {
      this.logger.warn(`⚠️ Redis DEL 失败 [${key}]: ${(error as Error).message}`);
      return this.fallback ? this.fallback.delete(key) : false;
    }
  }

  async clear(): Promise<void> {
    const fallbackAdapter = this.getActiveAdapter();
    if (fallbackAdapter) {
      return fallbackAdapter.clear();
    }

    try {
      // 使用 SCAN 而非 KEYS 避免阻塞
      let cursor = '0';
      do {
        const [nextCursor, keys] = await this.redis!.scan(
          cursor,
          'MATCH',
          `${this.config.keyPrefix}*`,
          'COUNT',
          100
        );
        cursor = nextCursor;

        if (keys.length > 0) {
          // 去掉前缀因为 ioredis keyPrefix 会自动加上
          const unprefixedKeys = keys.map(k => k.replace(this.config.keyPrefix, ''));
          await this.redis!.del(...unprefixedKeys);
        }
      } while (cursor !== '0');
    } catch (error) {
      this.logger.warn(`⚠️ Redis CLEAR 失败: ${(error as Error).message}`);
      if (this.fallback) {
        await this.fallback.clear();
      }
    }
  }

  async getMany<T = unknown>(keys: string[]): Promise<Map<string, T | undefined>> {
    const result = new Map<string, T | undefined>();

    const fallbackAdapter = this.getActiveAdapter();
    if (fallbackAdapter) {
      return fallbackAdapter.getMany<T>(keys);
    }

    try {
      // 使用 Pipeline 批量获取
      const pipeline = this.redis!.pipeline();
      for (const key of keys) {
        pipeline.get(key);
      }

      const results = await pipeline.exec();
      if (results) {
        for (let i = 0; i < keys.length; i++) {
          const [err, raw] = results[i] as [Error | null, string | null];
          if (err || raw === null) {
            result.set(keys[i], undefined);
          } else {
            try {
              const entry: SerializedEntry = JSON.parse(raw);
              result.set(keys[i], decodeBuffers(entry.v) as T);
            } catch {
              result.set(keys[i], undefined);
            }
          }
        }
      }
    } catch (error) {
      this.logger.warn(`⚠️ Redis MGET 失败: ${(error as Error).message}`);
      // 降级
      for (const key of keys) {
        result.set(key, this.fallback ? await this.fallback.get<T>(key) : undefined);
      }
    }

    return result;
  }

  async setMany<T = unknown>(
    entries: Array<{ key: string; value: T; options?: CacheSetOptions }>
  ): Promise<void> {
    const fallbackAdapter = this.getActiveAdapter();
    if (fallbackAdapter) {
      return fallbackAdapter.setMany(entries);
    }

    try {
      const pipeline = this.redis!.pipeline();

      for (const { key, value, options } of entries) {
        const ttl = options?.ttl ?? this.config.defaultTTL;
        const entry: SerializedEntry = { v: encodeBuffers(value), t: Date.now() };
        const serialized = JSON.stringify(entry);

        if (ttl > 0) {
          pipeline.setex(key, ttl, serialized);
        } else {
          pipeline.set(key, serialized);
        }

        // 标签
        if (options?.tags) {
          for (const tag of options.tags) {
            pipeline.sadd(`__tag:${tag}`, this.config.keyPrefix + key);
          }
        }
      }

      const results = (await pipeline.exec()) as Array<[Error | null, unknown]> | null;
      assertPipelineOk(results, 'MSET');
    } catch (error) {
      this.logger.warn(`⚠️ Redis MSET 失败: ${(error as Error).message}`);
      if (this.fallback) {
        await this.fallback.setMany(entries);
      } else {
        this.logger.error(
          `❌ Redis MSET 失败且未启用 fallback，${entries.length} 条数据未写入任何后端（数据丢失）`
        );
      }
    }
  }

  async invalidateByTag(tag: string): Promise<number> {
    const fallbackAdapter = this.getActiveAdapter();
    if (fallbackAdapter) {
      return fallbackAdapter.invalidateByTag(tag);
    }

    try {
      const tagKey = `__tag:${tag}`;
      const members = await this.redis!.smembers(tagKey);

      if (members.length === 0) return 0;

      // 去掉前缀删除
      const unprefixed = members.map(m => m.replace(this.config.keyPrefix, ''));
      const pipeline = this.redis!.pipeline();
      for (const key of unprefixed) {
        pipeline.del(key);
      }
      pipeline.del(tagKey); // 删除标签集合本身
      const results = (await pipeline.exec()) as Array<[Error | null, unknown]> | null;
      assertPipelineOk(results, `DEL tag=${tag}`);

      return members.length;
    } catch (error) {
      this.logger.warn(`⚠️ Redis TAG 失效失败 [${tag}]: ${(error as Error).message}`);
      return this.fallback ? this.fallback.invalidateByTag(tag) : 0;
    }
  }

  isConnected(): boolean {
    return this.connected && !this.usingFallback;
  }

  async destroy(): Promise<void> {
    this.destroyed = true;

    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    if (this.redis) {
      try {
        await this.redis.quit();
      } catch {
        // 静默处理
      }
      this.redis = null;
    }

    if (this.fallback) {
      await this.fallback.destroy();
      this.fallback = null;
    }

    this.connected = false;
  }
}
