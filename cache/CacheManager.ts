import fs from 'fs';
import path from 'path';

import { CacheStrategies } from '../types';
import { Logger } from '../utils/Logger';

/**
 * 缓存管理器
 * 处理不同的缓存策略（内存、文件系统、Redis）
 */
export class CacheManager {
  private config: Record<string, any>;
  private logger: Logger;
  private strategy: string;
  private memoryCache: Map<string, any>;
  private cacheMetadata: Map<string, any>;
  private fsCache: Record<string, any> | null;
  private redisClient?: any;
  private stats: {
    hits: number;
    misses: number;
    sets: number;
    deletes: number;
    evictions: number;
  };

  constructor(config: Record<string, any>) {
    this.config = config;
    this.logger = new Logger(config.verbose);
    this.strategy = config.strategy || CacheStrategies.MEMORY;

    // Memory cache
    this.memoryCache = new Map();
    this.cacheMetadata = new Map();

    // File system cache
    this.fsCache = null;

    // Stats
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      deletes: 0,
      evictions: 0,
    };
  }

  async initialize() {
    this.logger.debug(`Initializing cache with strategy: ${this.strategy}`);

    switch (this.strategy) {
      case CacheStrategies.MEMORY:
        await this.initMemoryCache();
        break;
      case CacheStrategies.FILE_SYSTEM:
        await this.initFileSystemCache();
        break;
      case CacheStrategies.REDIS:
        await this.initRedisCache();
        break;
      default:
        throw new Error(`Unsupported cache strategy: ${this.strategy}`);
    }

    // Start cleanup interval
    this.startCleanupInterval();

    this.logger.info(`Cache initialized with ${this.strategy} strategy`);
  }

  async initMemoryCache() {
    this.memoryCache = new Map();
    this.cacheMetadata = new Map();
  }

  async initFileSystemCache() {
    const cacheDir = path.join(process.cwd(), '.cache', 'ssr');

    try {
      await fs.promises.access(cacheDir);
    } catch {
      await fs.promises.mkdir(cacheDir, { recursive: true });
    }

    this.fsCache = {
      dir: cacheDir,
      indexPath: path.join(cacheDir, 'index.json'),
      index: new Map(),
    };

    // Load existing index
    try {
      const indexContent = await fs.promises.readFile(this.fsCache.indexPath, 'utf-8');
      const indexData = JSON.parse(indexContent);
      this.fsCache.index = new Map(indexData);
    } catch {
      // Index doesn't exist, start fresh
      this.fsCache.index = new Map();
    }
  }

  async initRedisCache() {
    try {
      // Dynamic import for Redis - make it optional
      let redis;
      try {
        redis = await import('redis');
      } catch {
        throw new Error('Redis package not installed. Please install redis: npm install redis');
      }

      this.redisClient = redis.createClient(this.config.redis || {});

      await this.redisClient.connect();
      this.logger.info('Redis cache connected');
    } catch (error) {
      this.logger.error('Failed to connect to Redis:', error);
      throw error;
    }
  }

  async get(key: string) {
    try {
      let result = null;

      switch (this.strategy) {
        case CacheStrategies.MEMORY:
          result = await this.getFromMemory(key);
          break;
        case CacheStrategies.FILE_SYSTEM:
          result = await this.getFromFileSystem(key);
          break;
        case CacheStrategies.REDIS:
          result = await this.getFromRedis(key);
          break;
      }

      if (result) {
        this.stats.hits++;
        return result;
      } else {
        this.stats.misses++;
        return null;
      }
    } catch (error) {
      this.logger.error(`Cache get error for key ${key}:`, error);
      this.stats.misses++;
      return null;
    }
  }

  async set(key: string, value: any, ttl?: number) {
    try {
      const expiresAt = ttl ? Date.now() + ttl * 1000 : null;

      switch (this.strategy) {
        case CacheStrategies.MEMORY:
          await this.setInMemory(key, value, expiresAt);
          break;
        case CacheStrategies.FILE_SYSTEM:
          await this.setInFileSystem(key, value, expiresAt);
          break;
        case CacheStrategies.REDIS:
          await this.setInRedis(key, value, ttl);
          break;
      }

      this.stats.sets++;
      this.checkMemoryLimit();
    } catch (error) {
      this.logger.error(`Cache set error for key ${key}:`, error);
      throw error;
    }
  }

  async delete(key: string) {
    try {
      switch (this.strategy) {
        case CacheStrategies.MEMORY:
          this.memoryCache.delete(key);
          this.cacheMetadata.delete(key);
          break;
        case CacheStrategies.FILE_SYSTEM:
          await this.deleteFromFileSystem(key);
          break;
        case CacheStrategies.REDIS:
          await this.redisClient.del(key);
          break;
      }

      this.stats.deletes++;
    } catch (error) {
      this.logger.error(`Cache delete error for key ${key}:`, error);
    }
  }

  async getFromMemory(key: string) {
    const metadata = this.cacheMetadata.get(key);

    if (!metadata) return null;

    // Check expiration
    if (metadata.expiresAt && Date.now() > metadata.expiresAt) {
      this.memoryCache.delete(key);
      this.cacheMetadata.delete(key);
      return null;
    }

    return this.memoryCache.get(key);
  }

  async setInMemory(key: string, value: any, expiresAt: number | null) {
    this.memoryCache.set(key, value);
    this.cacheMetadata.set(key, {
      key,
      size: this.calculateSize(value),
      createdAt: Date.now(),
      expiresAt,
      accessCount: 0,
    });
  }

  async getFromFileSystem(key: string) {
    if (!this.fsCache) return null;
    const metadata = this.fsCache.index.get(key);

    if (!metadata) return null;

    // Check expiration
    if (metadata.expiresAt && Date.now() > metadata.expiresAt) {
      await this.deleteFromFileSystem(key);
      return null;
    }

    try {
      const filePath = path.join(this.fsCache.dir, metadata.filename);
      const content = await fs.promises.readFile(filePath, 'utf-8');
      return JSON.parse(content);
    } catch {
      // File might be corrupted or missing
      this.fsCache.index.delete(key);
      return null;
    }
  }

  async setInFileSystem(key: string, value: any, expiresAt: number | null) {
    if (!this.fsCache) return;
    const filename = `${this.hashKey(key)}.json`;
    const filePath = path.join(this.fsCache.dir, filename);

    // Write data file
    await fs.promises.writeFile(filePath, JSON.stringify(value), 'utf-8');

    // Update index
    this.fsCache.index.set(key, {
      key,
      filename,
      size: this.calculateSize(value),
      createdAt: Date.now(),
      expiresAt,
    });

    // Save index
    await this.saveIndex();
  }

  async deleteFromFileSystem(key: string) {
    if (!this.fsCache) return;
    const metadata = this.fsCache.index.get(key);

    if (metadata) {
      try {
        const filePath = path.join(this.fsCache.dir, metadata.filename);
        await fs.promises.unlink(filePath);
      } catch {
        // File might not exist
      }

      this.fsCache.index.delete(key);
      await this.saveIndex();
    }
  }

  async getFromRedis(key: string) {
    if (!this.redisClient) return null;

    const result = await this.redisClient.get(key);
    return result ? JSON.parse(result) : null;
  }

  async setInRedis(key: string, value: any, ttl?: number) {
    if (!this.redisClient) return;

    const serialized = JSON.stringify(value);

    if (ttl) {
      await this.redisClient.setEx(key, ttl, serialized);
    } else {
      await this.redisClient.set(key, serialized);
    }
  }

  checkMemoryLimit() {
    if (this.strategy !== CacheStrategies.MEMORY) return;

    const maxSize = this.config.maxSize || 1000;
    const currentSize = this.memoryCache.size;

    if (currentSize > maxSize) {
      const evictCount = Math.floor(maxSize * 0.2); // Remove 20%
      this.logger.debug(`内存缓存超限 (${currentSize}/${maxSize})，准备清理 ${evictCount} 个条目`);
      this.evictOldestEntries(evictCount);
    }

    // 检查内存使用情况
    const memoryUsage = process.memoryUsage();
    const heapUsedMB = Math.round(memoryUsage.heapUsed / 1024 / 1024);

    if (heapUsedMB > 500) {
      // 如果堆内存使用超过 500MB
      this.logger.warn(`内存使用过高 (${heapUsedMB}MB)，触发额外清理`);
      this.evictOldestEntries(Math.floor(currentSize * 0.1)); // 额外清理 10%
    }
  }

  evictOldestEntries(count: number) {
    const entries = Array.from(this.cacheMetadata.entries())
      .sort((a, b) => a[1].createdAt - b[1].createdAt)
      .slice(0, count);

    entries.forEach(([key]) => {
      this.memoryCache.delete(key);
      this.cacheMetadata.delete(key);
      this.stats.evictions++;
    });

    this.logger.debug(`Evicted ${count} cache entries`);
  }

  calculateSize(value: any) {
    try {
      return Buffer.byteLength(JSON.stringify(value), 'utf8');
    } catch {
      return 0;
    }
  }

  hashKey(key: string) {
    // Simple hash function for filename
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      const char = key.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(36);
  }

  async saveIndex() {
    if (!this.fsCache) return;

    try {
      const indexData = Array.from(this.fsCache.index.entries());
      await fs.promises.writeFile(this.fsCache.indexPath, JSON.stringify(indexData, null, 2));
    } catch (error) {
      this.logger.error('Failed to save cache index:', error);
    }
  }

  startCleanupInterval() {
    const interval = this.config.cleanupInterval || 300000; // 5 minutes

    setInterval(async () => {
      await this.cleanup();
    }, interval);
  }

  async cleanup() {
    this.logger.debug('Running cache cleanup...');

    const now = Date.now();
    let cleaned = 0;

    try {
      switch (this.strategy) {
        case CacheStrategies.MEMORY:
          for (const [key, metadata] of this.cacheMetadata.entries()) {
            if (metadata.expiresAt && now > metadata.expiresAt) {
              this.memoryCache.delete(key);
              this.cacheMetadata.delete(key);
              cleaned++;
            }
          }
          break;

        case CacheStrategies.FILE_SYSTEM:
          if (this.fsCache) {
            for (const [key, metadata] of this.fsCache.index.entries()) {
              if (metadata.expiresAt && now > metadata.expiresAt) {
                await this.deleteFromFileSystem(key);
                cleaned++;
              }
            }
          }
          break;
      }

      if (cleaned > 0) {
        this.logger.debug(`Cache cleanup: removed ${cleaned} expired entries`);
      }
    } catch (error) {
      this.logger.error('Cache cleanup error:', error);
    }
  }

  async clear() {
    this.logger.info('Clearing cache...');

    switch (this.strategy) {
      case CacheStrategies.MEMORY:
        this.memoryCache.clear();
        this.cacheMetadata.clear();
        break;

      case CacheStrategies.FILE_SYSTEM:
        if (this.fsCache) {
          try {
            await fs.promises.rm(this.fsCache.dir, {
              recursive: true,
              force: true,
            });
            await this.initFileSystemCache();
          } catch (error) {
            this.logger.error('Failed to clear file system cache:', error);
          }
        }
        break;

      case CacheStrategies.REDIS:
        if (this.redisClient) {
          await this.redisClient.flushAll();
        }
        break;
    }

    // Reset stats
    this.stats = { hits: 0, misses: 0, sets: 0, deletes: 0, evictions: 0 };
  }

  getStats() {
    const hitRate =
      this.stats.hits + this.stats.misses > 0
        ? ((this.stats.hits / (this.stats.hits + this.stats.misses)) * 100).toFixed(2) + '%'
        : '0%';

    return {
      ...this.stats,
      hitRate,
      strategy: this.strategy,
      size: this.strategy === CacheStrategies.MEMORY ? this.memoryCache.size : 'N/A',
    };
  }

  async shutdown() {
    this.logger.info('Shutting down cache...');

    try {
      if (this.strategy === CacheStrategies.FILE_SYSTEM) {
        await this.saveIndex();
      }

      if (this.redisClient) {
        await this.redisClient.quit();
      }
    } catch (error) {
      this.logger.error('Cache shutdown error:', error);
    }
  }
}
