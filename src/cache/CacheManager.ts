import { Logger } from '../logger/Logger';
import type { ICacheAdapter, CacheSetOptions } from './ICacheAdapter';
import { MemoryCacheAdapter, type MemoryCacheConfig } from './MemoryCacheAdapter';
import { RedisCacheAdapter, type RedisCacheConfig } from './RedisCacheAdapter';

/** 缓存策略 */
export type CacheStrategy = 'memory' | 'redis';

/** 缓存管理器配置 */
export interface CacheManagerConfig {
  /** 缓存策略 */
  strategy: CacheStrategy;
  /** 内存缓存配置 */
  memory?: Partial<MemoryCacheConfig>;
  /** Redis 缓存配置 */
  redis?: Partial<RedisCacheConfig>;
}

const DEFAULT_CONFIG: CacheManagerConfig = {
  strategy: 'memory',
};

/**
 * 缓存管理器
 * 统一管理缓存后端，支持 Memory / Redis 策略切换
 *
 * 使用工厂模式创建缓存适配器:
 * - memory: 基于 LRU + TTL 的高性能内存缓存
 * - redis: 基于 ioredis 的分布式缓存，自动降级到内存
 */
export class CacheManager {
  private adapter: ICacheAdapter;
  private logger: Logger;
  private config: CacheManagerConfig;

  constructor(config: Partial<CacheManagerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = Logger.getInstance();
    this.adapter = this.createAdapter();

    this.logger.info(`缓存后端已初始化: ${this.adapter.name}`);
  }

  /**
   * 工厂方法：根据策略创建适配器
   */
  private createAdapter(): ICacheAdapter {
    switch (this.config.strategy) {
      case 'redis':
        return new RedisCacheAdapter(this.config.redis);

      case 'memory':
      default:
        return new MemoryCacheAdapter(this.config.memory);
    }
  }

  /**
   * 获取底层适配器
   */
  getAdapter(): ICacheAdapter {
    return this.adapter;
  }

  /**
   * 获取缓存内容
   */
  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.adapter.get<T>(key);
  }

  /**
   * 设置缓存内容
   */
  async set<T = unknown>(key: string, value: T, options?: CacheSetOptions): Promise<void> {
    return this.adapter.set(key, value, options);
  }

  /**
   * 检查是否存在
   */
  async has(key: string): Promise<boolean> {
    return this.adapter.has(key);
  }

  /**
   * 删除缓存
   */
  async delete(key: string): Promise<boolean> {
    return this.adapter.delete(key);
  }

  /**
   * 清空缓存
   */
  async clear(): Promise<void> {
    await this.adapter.clear();
    this.logger.debug('缓存已清空');
  }

  /**
   * 批量获取
   */
  async getMany<T = unknown>(keys: string[]): Promise<Map<string, T | undefined>> {
    return this.adapter.getMany<T>(keys);
  }

  /**
   * 批量设置
   */
  async setMany<T = unknown>(
    entries: Array<{ key: string; value: T; options?: CacheSetOptions }>
  ): Promise<void> {
    return this.adapter.setMany(entries);
  }

  /**
   * 按标签批量失效
   */
  async invalidateByTag(tag: string): Promise<number> {
    return this.adapter.invalidateByTag(tag);
  }

  /**
   * 连接状态
   */
  isConnected(): boolean {
    return this.adapter.isConnected();
  }

  /**
   * 销毁缓存管理器
   */
  async destroy(): Promise<void> {
    await this.adapter.destroy();
    this.logger.debug('缓存管理器已销毁');
  }
}
