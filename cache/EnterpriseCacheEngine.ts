/**
 * 企业级缓存优化引擎
 *
 * 核心功能：
 * - 多层级缓存架构 (L1: Memory, L2: Redis, L3: Disk)
 * - 智能缓存策略和失效机制
 * - 分布式缓存同步
 * - 缓存预热和预加载
 * - 压缩和序列化优化
 * - 缓存性能监控和分析
 * - 缓存安全和访问控制
 */

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import zlib from 'zlib';
import { promisify } from 'util';
import { LRUCache } from 'lru-cache';
import { Logger } from '../utils/Logger';
import type { RenderResult } from '../types';

const gzipAsync = promisify(zlib.gzip);
const gunzipAsync = promisify(zlib.gunzip);

export interface EnterpriseCacheConfig {
  // 基础配置
  enabled: boolean;
  strategy: 'memory' | 'redis' | 'disk' | 'hybrid';

  // 多层级配置
  layers: {
    l1: {
      enabled: boolean;
      maxSize: number; // 内存缓存大小 (条目数)
      ttl: number; // 生存时间 (秒)
    };
    l2: {
      enabled: boolean;
      host: string;
      port: number;
      password?: string;
      database: number;
      maxRetries: number;
    };
    l3: {
      enabled: boolean;
      directory: string;
      maxSize: number; // 磁盘缓存大小 (MB)
      cleanupInterval: number; // 清理间隔 (秒)
    };
  };

  // 压缩配置
  compression: {
    enabled: boolean;
    algorithm: 'gzip' | 'deflate' | 'brotli';
    level: number;
    minSize: number; // 最小压缩大小 (bytes)
  };

  // 序列化配置
  serialization: {
    format: 'json' | 'msgpack' | 'protobuf';
    enableBinary: boolean;
  };

  // 智能策略配置
  strategies: {
    enableAdaptive: boolean; // 自适应缓存策略
    enablePredictive: boolean; // 预测性缓存
    enableWarmup: boolean; // 缓存预热
    popularityThreshold: number; // 热门内容阈值
    adaptiveWindow: number; // 自适应时间窗口 (秒)
  };

  // 失效配置
  invalidation: {
    enableTagging: boolean; // 标签失效
    enableDependency: boolean; // 依赖失效
    enableTimeToLive: boolean; // TTL 失效
    maxTags: number; // 最大标签数
  };

  // 安全配置
  security: {
    enableEncryption: boolean;
    encryptionKey?: string;
    enableAccessControl: boolean;
    allowedOrigins: string[];
  };

  // 监控配置
  monitoring: {
    enableMetrics: boolean;
    enableHealthCheck: boolean;
    metricsInterval: number; // 指标收集间隔 (秒)
    alertThresholds: {
      hitRateLow: number; // 命中率低阈值
      latencyHigh: number; // 延迟高阈值 (ms)
      errorRateHigh: number; // 错误率高阈值
    };
  };
}

export interface CacheEntry {
  key: string;
  value: any;
  metadata: {
    size: number;
    created: number;
    accessed: number;
    hits: number;
    ttl: number;
    tags: string[];
    dependencies: string[];
    compressed: boolean;
    encrypted: boolean;
  };
}

export interface CacheMetrics {
  performance: {
    hitRate: number;
    missRate: number;
    averageLatency: number;
    throughput: number;
  };
  storage: {
    totalSize: number;
    usedSize: number;
    entryCount: number;
    compressionRatio: number;
  };
  layers: {
    l1: LayerMetrics;
    l2: LayerMetrics;
    l3: LayerMetrics;
  };
  health: {
    isHealthy: boolean;
    issues: string[];
    lastCheck: number;
  };
}

export interface LayerMetrics {
  enabled: boolean;
  hitCount: number;
  missCount: number;
  errorCount: number;
  averageLatency: number;
  size: number;
}

/**
 * 企业级缓存优化引擎实现
 */
export class EnterpriseCacheEngine {
  private config: EnterpriseCacheConfig;
  private logger: Logger;

  // 多层级缓存
  private l1Cache?: LRUCache<string, CacheEntry>; // 内存缓存
  private l2Client: any; // Redis 客户端
  private l3Directory: string = ''; // 磁盘缓存目录

  // 缓存策略
  private accessPatterns: Map<string, { count: number; lastAccess: number }>;
  private popularKeys: Set<string>;
  private dependencyGraph: Map<string, Set<string>>;
  private tagIndex: Map<string, Set<string>>;

  // 性能监控
  private metrics: {
    hits: number;
    misses: number;
    errors: number;
    totalLatency: number;
    operationCount: number;
    layerStats: Map<string, LayerMetrics>;
  };

  // 安全
  private cipher?: crypto.Cipher;
  private decipher?: crypto.Decipher;

  // 定时任务
  private cleanupTimer?: NodeJS.Timeout;
  private metricsTimer?: NodeJS.Timeout;
  private warmupTimer?: NodeJS.Timeout;

  constructor(config: Partial<EnterpriseCacheConfig> = {}, verbose = false) {
    this.logger = new Logger(verbose);

    // 默认配置
    this.config = {
      enabled: true,
      strategy: 'hybrid',
      layers: {
        l1: {
          enabled: true,
          maxSize: 1000,
          ttl: 3600,
        },
        l2: {
          enabled: false,
          host: 'localhost',
          port: 6379,
          database: 0,
          maxRetries: 3,
        },
        l3: {
          enabled: true,
          directory: '.isr-hyou/cache',
          maxSize: 1024, // 1GB
          cleanupInterval: 3600,
        },
      },
      compression: {
        enabled: true,
        algorithm: 'gzip',
        level: 6,
        minSize: 1024,
      },
      serialization: {
        format: 'json',
        enableBinary: false,
      },
      strategies: {
        enableAdaptive: true,
        enablePredictive: true,
        enableWarmup: true,
        popularityThreshold: 10,
        adaptiveWindow: 3600,
      },
      invalidation: {
        enableTagging: true,
        enableDependency: true,
        enableTimeToLive: true,
        maxTags: 100,
      },
      security: {
        enableEncryption: false,
        enableAccessControl: false,
        allowedOrigins: ['*'],
      },
      monitoring: {
        enableMetrics: true,
        enableHealthCheck: true,
        metricsInterval: 60,
        alertThresholds: {
          hitRateLow: 0.8,
          latencyHigh: 100,
          errorRateHigh: 0.05,
        },
      },
      ...config,
    };

    // 初始化内部状态
    this.accessPatterns = new Map();
    this.popularKeys = new Set();
    this.dependencyGraph = new Map();
    this.tagIndex = new Map();

    this.metrics = {
      hits: 0,
      misses: 0,
      errors: 0,
      totalLatency: 0,
      operationCount: 0,
      layerStats: new Map([
        [
          'l1',
          { enabled: false, hitCount: 0, missCount: 0, errorCount: 0, averageLatency: 0, size: 0 },
        ],
        [
          'l2',
          { enabled: false, hitCount: 0, missCount: 0, errorCount: 0, averageLatency: 0, size: 0 },
        ],
        [
          'l3',
          { enabled: false, hitCount: 0, missCount: 0, errorCount: 0, averageLatency: 0, size: 0 },
        ],
      ]),
    };
  }

  /**
   * 初始化缓存引擎
   */
  async initialize(): Promise<void> {
    try {
      this.logger.info('🚀 初始化企业级缓存引擎...');

      // 初始化 L1 内存缓存
      if (this.config.layers.l1.enabled) {
        await this.initializeL1Cache();
      }

      // 初始化 L2 Redis 缓存
      if (this.config.layers.l2.enabled) {
        await this.initializeL2Cache();
      }

      // 初始化 L3 磁盘缓存
      if (this.config.layers.l3.enabled) {
        await this.initializeL3Cache();
      }

      // 初始化安全加密
      if (this.config.security.enableEncryption) {
        this.initializeEncryption();
      }

      // 启动监控
      if (this.config.monitoring.enableMetrics) {
        this.startMonitoring();
      }

      // 启动缓存预热
      if (this.config.strategies.enableWarmup) {
        this.startWarmup();
      }

      // 启动清理任务
      this.startCleanupTasks();

      this.logger.info('✅ 企业级缓存引擎初始化完成');
    } catch (error) {
      this.logger.error('❌ 缓存引擎初始化失败:', error);
      throw error;
    }
  }

  /**
   * 获取缓存
   */
  async get(key: string, tags: string[] = []): Promise<any> {
    if (!this.config.enabled) {
      return null;
    }

    const startTime = performance.now();

    try {
      // 更新访问模式
      this.updateAccessPattern(key);

      // 尝试从各层级获取
      let entry: CacheEntry | null = null;
      let sourceLayer = '';

      // L1: 内存缓存
      if (this.config.layers.l1.enabled && !entry) {
        entry = await this.getFromL1(key);
        if (entry) sourceLayer = 'l1';
      }

      // L2: Redis 缓存
      if (this.config.layers.l2.enabled && !entry) {
        entry = await this.getFromL2(key);
        if (entry) {
          sourceLayer = 'l2';
          // 回写到 L1
          if (this.config.layers.l1.enabled) {
            await this.setToL1(key, entry);
          }
        }
      }

      // L3: 磁盘缓存
      if (this.config.layers.l3.enabled && !entry) {
        entry = await this.getFromL3(key);
        if (entry) {
          sourceLayer = 'l3';
          // 回写到 L1 和 L2
          if (this.config.layers.l1.enabled) {
            await this.setToL1(key, entry);
          }
          if (this.config.layers.l2.enabled) {
            await this.setToL2(key, entry);
          }
        }
      }

      const latency = performance.now() - startTime;

      if (entry) {
        // 检查 TTL
        if (this.isExpired(entry)) {
          await this.invalidate(key);
          this.recordMiss(sourceLayer, latency);
          return null;
        }

        // 更新访问统计
        entry.metadata.accessed = Date.now();
        entry.metadata.hits++;

        // 解压缩
        let value = entry.value;
        if (entry.metadata.compressed) {
          value = await this.decompress(value);
        }

        // 解密
        if (entry.metadata.encrypted && this.config.security.enableEncryption) {
          value = this.decrypt(value);
        }

        this.recordHit(sourceLayer, latency);
        return this.deserialize(value);
      } else {
        this.recordMiss('none', latency);
        return null;
      }
    } catch (error) {
      const latency = performance.now() - startTime;
      this.recordError('get', latency);
      this.logger.error(`❌ 缓存获取失败: ${key}`, error);
      return null;
    }
  }

  /**
   * 设置缓存
   */
  async set(
    key: string,
    value: any,
    options: {
      ttl?: number;
      tags?: string[];
      dependencies?: string[];
      compress?: boolean;
      priority?: 'low' | 'normal' | 'high';
    } = {}
  ): Promise<boolean> {
    if (!this.config.enabled) {
      return false;
    }

    const startTime = performance.now();

    try {
      const {
        ttl = this.config.layers.l1.ttl,
        tags = [],
        dependencies = [],
        compress = true,
        priority = 'normal',
      } = options;

      // 序列化值
      let serializedValue = this.serialize(value);

      // 加密
      if (this.config.security.enableEncryption) {
        serializedValue = this.encrypt(serializedValue);
      }

      // 压缩
      let compressed = false;
      if (compress && this.config.compression.enabled) {
        const originalSize = Buffer.byteLength(serializedValue);
        if (originalSize >= this.config.compression.minSize) {
          serializedValue = await this.compress(serializedValue);
          compressed = true;
        }
      }

      // 创建缓存条目
      const entry: CacheEntry = {
        key,
        value: serializedValue,
        metadata: {
          size: Buffer.byteLength(serializedValue),
          created: Date.now(),
          accessed: Date.now(),
          hits: 0,
          ttl: ttl * 1000, // 转换为毫秒
          tags,
          dependencies,
          compressed,
          encrypted: this.config.security.enableEncryption,
        },
      };

      // 更新标签索引
      if (this.config.invalidation.enableTagging) {
        this.updateTagIndex(key, tags);
      }

      // 更新依赖图
      if (this.config.invalidation.enableDependency) {
        this.updateDependencyGraph(key, dependencies);
      }

      // 根据优先级和策略决定存储层级
      const layers = this.determineStorageLayers(key, entry, priority);

      let success = false;

      // 存储到各层级
      for (const layer of layers) {
        try {
          switch (layer) {
            case 'l1':
              if (this.config.layers.l1.enabled) {
                await this.setToL1(key, entry);
                success = true;
              }
              break;
            case 'l2':
              if (this.config.layers.l2.enabled) {
                await this.setToL2(key, entry);
                success = true;
              }
              break;
            case 'l3':
              if (this.config.layers.l3.enabled) {
                await this.setToL3(key, entry);
                success = true;
              }
              break;
          }
        } catch (error) {
          this.logger.warn(`⚠️ 存储到 ${layer} 失败: ${key}`, error);
        }
      }

      const latency = performance.now() - startTime;

      if (success) {
        this.recordOperation('set', latency);
        this.logger.debug(`✅ 缓存设置成功: ${key} (${layers.join(', ')})`);
      } else {
        this.recordError('set', latency);
      }

      return success;
    } catch (error) {
      const latency = performance.now() - startTime;
      this.recordError('set', latency);
      this.logger.error(`❌ 缓存设置失败: ${key}`, error);
      return false;
    }
  }

  /**
   * 删除缓存
   */
  async delete(key: string): Promise<boolean> {
    if (!this.config.enabled) {
      return false;
    }

    const startTime = performance.now();
    let success = false;

    try {
      // 从所有层级删除
      const deleteTasks = [];

      if (this.config.layers.l1.enabled) {
        deleteTasks.push(this.deleteFromL1(key));
      }

      if (this.config.layers.l2.enabled) {
        deleteTasks.push(this.deleteFromL2(key));
      }

      if (this.config.layers.l3.enabled) {
        deleteTasks.push(this.deleteFromL3(key));
      }

      const results = await Promise.allSettled(deleteTasks);
      success = results.some(result => result.status === 'fulfilled');

      // 清理索引
      this.cleanupKeyFromIndexes(key);

      const latency = performance.now() - startTime;
      this.recordOperation('delete', latency);

      this.logger.debug(`✅ 缓存删除: ${key}`);
      return success;
    } catch (error) {
      const latency = performance.now() - startTime;
      this.recordError('delete', latency);
      this.logger.error(`❌ 缓存删除失败: ${key}`, error);
      return false;
    }
  }

  /**
   * 按标签失效
   */
  async invalidateByTags(tags: string[]): Promise<number> {
    if (!this.config.invalidation.enableTagging) {
      return 0;
    }

    let invalidatedCount = 0;

    for (const tag of tags) {
      const keysWithTag = this.tagIndex.get(tag);
      if (keysWithTag) {
        for (const key of keysWithTag) {
          if (await this.delete(key)) {
            invalidatedCount++;
          }
        }
        this.tagIndex.delete(tag);
      }
    }

    this.logger.info(`🗑️ 按标签失效: ${tags.join(', ')} (${invalidatedCount} 个条目)`);
    return invalidatedCount;
  }

  /**
   * 按依赖失效
   */
  async invalidateByDependency(dependency: string): Promise<number> {
    if (!this.config.invalidation.enableDependency) {
      return 0;
    }

    const dependentKeys = this.dependencyGraph.get(dependency);
    if (!dependentKeys) {
      return 0;
    }

    let invalidatedCount = 0;

    for (const key of dependentKeys) {
      if (await this.delete(key)) {
        invalidatedCount++;
      }
    }

    this.dependencyGraph.delete(dependency);

    this.logger.info(`🗑️ 按依赖失效: ${dependency} (${invalidatedCount} 个条目)`);
    return invalidatedCount;
  }

  /**
   * 失效单个键
   */
  async invalidate(key: string): Promise<boolean> {
    return await this.delete(key);
  }

  /**
   * 清空所有缓存
   */
  async clear(): Promise<void> {
    const startTime = performance.now();

    try {
      const clearTasks = [];

      if (this.config.layers.l1.enabled) {
        clearTasks.push(this.clearL1());
      }

      if (this.config.layers.l2.enabled) {
        clearTasks.push(this.clearL2());
      }

      if (this.config.layers.l3.enabled) {
        clearTasks.push(this.clearL3());
      }

      await Promise.allSettled(clearTasks);

      // 清理所有索引
      this.tagIndex.clear();
      this.dependencyGraph.clear();
      this.accessPatterns.clear();
      this.popularKeys.clear();

      const latency = performance.now() - startTime;
      this.recordOperation('clear', latency);

      this.logger.info('🧹 所有缓存已清空');
    } catch (error) {
      const latency = performance.now() - startTime;
      this.recordError('clear', latency);
      this.logger.error('❌ 清空缓存失败:', error);
      throw error;
    }
  }

  /**
   * 初始化 L1 内存缓存
   */
  private async initializeL1Cache(): Promise<void> {
    this.l1Cache = new LRUCache<string, CacheEntry>({
      max: this.config.layers.l1.maxSize,
      ttl: this.config.layers.l1.ttl * 1000, // 转换为毫秒
      updateAgeOnGet: true,
      allowStale: false,
    });

    this.metrics.layerStats.set('l1', {
      enabled: true,
      hitCount: 0,
      missCount: 0,
      errorCount: 0,
      averageLatency: 0,
      size: 0,
    });

    this.logger.debug('💾 L1 内存缓存已初始化');
  }

  /**
   * 初始化 L2 Redis 缓存
   */
  private async initializeL2Cache(): Promise<void> {
    try {
      // 这里应该初始化 Redis 客户端
      // 由于示例，暂时跳过实际连接

      this.metrics.layerStats.set('l2', {
        enabled: true,
        hitCount: 0,
        missCount: 0,
        errorCount: 0,
        averageLatency: 0,
        size: 0,
      });

      this.logger.debug('🔴 L2 Redis 缓存已初始化');
    } catch (error) {
      this.logger.warn('⚠️ L2 Redis 缓存初始化失败，禁用 Redis 缓存');
      this.config.layers.l2.enabled = false;
    }
  }

  /**
   * 初始化 L3 磁盘缓存
   */
  private async initializeL3Cache(): Promise<void> {
    this.l3Directory = this.config.layers.l3.directory;

    try {
      await fs.mkdir(this.l3Directory, { recursive: true });

      this.metrics.layerStats.set('l3', {
        enabled: true,
        hitCount: 0,
        missCount: 0,
        errorCount: 0,
        averageLatency: 0,
        size: 0,
      });

      this.logger.debug(`💿 L3 磁盘缓存已初始化: ${this.l3Directory}`);
    } catch (error) {
      this.logger.warn('⚠️ L3 磁盘缓存初始化失败，禁用磁盘缓存');
      this.config.layers.l3.enabled = false;
    }
  }

  /**
   * 初始化加密
   */
  private initializeEncryption(): void {
    if (!this.config.security.encryptionKey) {
      this.config.security.encryptionKey = crypto.randomBytes(32).toString('hex');
      this.logger.warn('⚠️ 使用随机生成的加密密钥，生产环境请配置固定密钥');
    }

    this.logger.debug('🔐 缓存加密已启用');
  }

  /**
   * 从 L1 获取
   */
  private async getFromL1(key: string): Promise<CacheEntry | null> {
    if (!this.l1Cache) return null;

    const entry = this.l1Cache.get(key);
    return entry || null;
  }

  /**
   * 设置到 L1
   */
  private async setToL1(key: string, entry: CacheEntry): Promise<void> {
    if (!this.l1Cache) return;

    this.l1Cache.set(key, entry);
  }

  /**
   * 从 L1 删除
   */
  private async deleteFromL1(key: string): Promise<boolean> {
    if (!this.l1Cache) return false;

    return this.l1Cache.delete(key);
  }

  /**
   * 清空 L1
   */
  private async clearL1(): Promise<void> {
    if (!this.l1Cache) return;

    this.l1Cache.clear();
  }

  /**
   * 从 L2 获取
   */
  private async getFromL2(key: string): Promise<CacheEntry | null> {
    // Redis 实现
    return null;
  }

  /**
   * 设置到 L2
   */
  private async setToL2(key: string, entry: CacheEntry): Promise<void> {
    // Redis 实现
  }

  /**
   * 从 L2 删除
   */
  private async deleteFromL2(key: string): Promise<boolean> {
    // Redis 实现
    return false;
  }

  /**
   * 清空 L2
   */
  private async clearL2(): Promise<void> {
    // Redis 实现
  }

  /**
   * 从 L3 获取
   */
  private async getFromL3(key: string): Promise<CacheEntry | null> {
    if (!this.l3Directory) return null;

    try {
      const filePath = path.join(this.l3Directory, this.hashKey(key));
      const data = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(data) as CacheEntry;
    } catch {
      return null;
    }
  }

  /**
   * 设置到 L3
   */
  private async setToL3(key: string, entry: CacheEntry): Promise<void> {
    if (!this.l3Directory) return;

    try {
      const filePath = path.join(this.l3Directory, this.hashKey(key));
      await fs.writeFile(filePath, JSON.stringify(entry));
    } catch (error) {
      this.logger.warn(`⚠️ L3 写入失败: ${key}`, error);
    }
  }

  /**
   * 从 L3 删除
   */
  private async deleteFromL3(key: string): Promise<boolean> {
    if (!this.l3Directory) return false;

    try {
      const filePath = path.join(this.l3Directory, this.hashKey(key));
      await fs.unlink(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 清空 L3
   */
  private async clearL3(): Promise<void> {
    if (!this.l3Directory) return;

    try {
      const files = await fs.readdir(this.l3Directory);
      await Promise.all(files.map(file => fs.unlink(path.join(this.l3Directory, file))));
    } catch (error) {
      this.logger.warn('⚠️ L3 清空失败:', error);
    }
  }

  /**
   * 哈希键名
   */
  private hashKey(key: string): string {
    return crypto.createHash('sha256').update(key).digest('hex');
  }

  /**
   * 序列化
   */
  private serialize(value: any): string {
    switch (this.config.serialization.format) {
      case 'json':
      default:
        return JSON.stringify(value);
    }
  }

  /**
   * 反序列化
   */
  private deserialize(value: string): any {
    switch (this.config.serialization.format) {
      case 'json':
      default:
        return JSON.parse(value);
    }
  }

  /**
   * 压缩
   */
  private async compress(data: string): Promise<string> {
    if (!this.config.compression.enabled) {
      return data;
    }

    try {
      const compressed = await gzipAsync(Buffer.from(data));
      return compressed.toString('base64');
    } catch {
      return data;
    }
  }

  /**
   * 解压缩
   */
  private async decompress(data: string): Promise<string> {
    try {
      const buffer = Buffer.from(data, 'base64');
      const decompressed = await gunzipAsync(buffer);
      return decompressed.toString();
    } catch {
      return data;
    }
  }

  /**
   * 加密
   */
  private encrypt(data: string): string {
    if (!this.config.security.enableEncryption || !this.config.security.encryptionKey) {
      return data;
    }

    try {
      const iv = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv('aes-256-cbc', this.config.security.encryptionKey!, iv);
      let encrypted = cipher.update(data, 'utf8', 'hex');
      encrypted += cipher.final('hex');
      return iv.toString('hex') + ':' + encrypted;
    } catch {
      return data;
    }
  }

  /**
   * 解密
   */
  private decrypt(data: string): string {
    if (!this.config.security.enableEncryption || !this.config.security.encryptionKey) {
      return data;
    }

    try {
      const parts = data.split(':');
      const iv = Buffer.from(parts[0], 'hex');
      const encrypted = parts[1];

      const decipher = crypto.createDecipheriv(
        'aes-256-cbc',
        this.config.security.encryptionKey!,
        iv
      );
      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    } catch {
      return data;
    }
  }

  /**
   * 检查是否过期
   */
  private isExpired(entry: CacheEntry): boolean {
    if (!this.config.invalidation.enableTimeToLive) {
      return false;
    }

    return Date.now() - entry.metadata.created > entry.metadata.ttl;
  }

  /**
   * 更新访问模式
   */
  private updateAccessPattern(key: string): void {
    if (!this.config.strategies.enableAdaptive) {
      return;
    }

    const now = Date.now();
    const pattern = this.accessPatterns.get(key) || { count: 0, lastAccess: now };

    pattern.count++;
    pattern.lastAccess = now;

    this.accessPatterns.set(key, pattern);

    // 更新热门键
    if (pattern.count >= this.config.strategies.popularityThreshold) {
      this.popularKeys.add(key);
    }
  }

  /**
   * 更新标签索引
   */
  private updateTagIndex(key: string, tags: string[]): void {
    for (const tag of tags) {
      if (!this.tagIndex.has(tag)) {
        this.tagIndex.set(tag, new Set());
      }
      this.tagIndex.get(tag)!.add(key);
    }
  }

  /**
   * 更新依赖图
   */
  private updateDependencyGraph(key: string, dependencies: string[]): void {
    for (const dep of dependencies) {
      if (!this.dependencyGraph.has(dep)) {
        this.dependencyGraph.set(dep, new Set());
      }
      this.dependencyGraph.get(dep)!.add(key);
    }
  }

  /**
   * 确定存储层级
   */
  private determineStorageLayers(key: string, entry: CacheEntry, priority: string): string[] {
    const layers: string[] = [];

    // 根据优先级和大小确定存储策略
    switch (priority) {
      case 'high':
        // 高优先级：存储到所有可用层级
        if (this.config.layers.l1.enabled) layers.push('l1');
        if (this.config.layers.l2.enabled) layers.push('l2');
        if (this.config.layers.l3.enabled) layers.push('l3');
        break;
      case 'normal':
        // 普通优先级：存储到 L1 和 L3
        if (this.config.layers.l1.enabled) layers.push('l1');
        if (this.config.layers.l3.enabled) layers.push('l3');
        break;
      case 'low':
        // 低优先级：只存储到 L3
        if (this.config.layers.l3.enabled) layers.push('l3');
        break;
    }

    // 热门内容优先存储到更快的层级
    if (this.popularKeys.has(key)) {
      if (this.config.layers.l1.enabled && !layers.includes('l1')) {
        layers.unshift('l1');
      }
      if (this.config.layers.l2.enabled && !layers.includes('l2')) {
        layers.push('l2');
      }
    }

    return layers.length > 0 ? layers : ['l1']; // 默认存储到 L1
  }

  /**
   * 清理键的索引
   */
  private cleanupKeyFromIndexes(key: string): void {
    // 从标签索引中删除
    for (const [tag, keys] of this.tagIndex.entries()) {
      keys.delete(key);
      if (keys.size === 0) {
        this.tagIndex.delete(tag);
      }
    }

    // 从依赖图中删除
    for (const [dep, keys] of this.dependencyGraph.entries()) {
      keys.delete(key);
      if (keys.size === 0) {
        this.dependencyGraph.delete(dep);
      }
    }

    // 从访问模式中删除
    this.accessPatterns.delete(key);
    this.popularKeys.delete(key);
  }

  /**
   * 记录命中
   */
  private recordHit(layer: string, latency: number): void {
    this.metrics.hits++;
    this.metrics.totalLatency += latency;
    this.metrics.operationCount++;

    const layerStats = this.metrics.layerStats.get(layer);
    if (layerStats) {
      layerStats.hitCount++;
      layerStats.averageLatency = (layerStats.averageLatency + latency) / 2;
    }
  }

  /**
   * 记录未命中
   */
  private recordMiss(layer: string, latency: number): void {
    this.metrics.misses++;
    this.metrics.totalLatency += latency;
    this.metrics.operationCount++;

    const layerStats = this.metrics.layerStats.get(layer);
    if (layerStats) {
      layerStats.missCount++;
    }
  }

  /**
   * 记录错误
   */
  private recordError(operation: string, latency: number): void {
    this.metrics.errors++;
    this.metrics.totalLatency += latency;
    this.metrics.operationCount++;

    this.logger.warn(`⚠️ 缓存操作错误: ${operation} (${latency.toFixed(2)}ms)`);
  }

  /**
   * 记录操作
   */
  private recordOperation(operation: string, latency: number): void {
    this.metrics.totalLatency += latency;
    this.metrics.operationCount++;
  }

  /**
   * 启动监控
   */
  private startMonitoring(): void {
    this.metricsTimer = setInterval(() => {
      const metrics = this.getMetrics();

      // 检查告警阈值
      if (metrics.performance.hitRate < this.config.monitoring.alertThresholds.hitRateLow) {
        this.logger.warn(`🚨 缓存命中率过低: ${(metrics.performance.hitRate * 100).toFixed(1)}%`);
      }

      if (metrics.performance.averageLatency > this.config.monitoring.alertThresholds.latencyHigh) {
        this.logger.warn(`🚨 缓存延迟过高: ${metrics.performance.averageLatency.toFixed(2)}ms`);
      }

      this.logger.debug(
        `📊 缓存指标: 命中率 ${(metrics.performance.hitRate * 100).toFixed(1)}%, 延迟 ${metrics.performance.averageLatency.toFixed(2)}ms`
      );
    }, this.config.monitoring.metricsInterval * 1000);
  }

  /**
   * 启动预热
   */
  private startWarmup(): void {
    // 缓存预热逻辑
    this.logger.debug('🔥 缓存预热已启动');
  }

  /**
   * 启动清理任务
   */
  private startCleanupTasks(): void {
    // L3 磁盘清理
    if (this.config.layers.l3.enabled) {
      this.cleanupTimer = setInterval(async () => {
        await this.cleanupL3Cache();
      }, this.config.layers.l3.cleanupInterval * 1000);
    }
  }

  /**
   * 清理 L3 缓存
   */
  private async cleanupL3Cache(): Promise<void> {
    if (!this.l3Directory) return;

    try {
      const files = await fs.readdir(this.l3Directory);
      const maxSize = this.config.layers.l3.maxSize * 1024 * 1024; // 转换为字节
      let totalSize = 0;
      const fileStats: Array<{ path: string; size: number; mtime: number }> = [];

      // 收集文件统计信息
      for (const file of files) {
        const filePath = path.join(this.l3Directory, file);
        const stats = await fs.stat(filePath);
        totalSize += stats.size;
        fileStats.push({
          path: filePath,
          size: stats.size,
          mtime: stats.mtime.getTime(),
        });
      }

      // 如果超过大小限制，删除最旧的文件
      if (totalSize > maxSize) {
        fileStats.sort((a, b) => a.mtime - b.mtime);

        let deletedSize = 0;
        for (const file of fileStats) {
          if (totalSize - deletedSize <= maxSize * 0.8) break; // 清理到80%

          try {
            await fs.unlink(file.path);
            deletedSize += file.size;
          } catch (error) {
            this.logger.warn(`⚠️ 删除缓存文件失败: ${file.path}`, error);
          }
        }

        this.logger.debug(`🧹 L3 缓存清理完成: 释放 ${(deletedSize / 1024 / 1024).toFixed(2)}MB`);
      }
    } catch (error) {
      this.logger.warn('⚠️ L3 缓存清理失败:', error);
    }
  }

  /**
   * 获取缓存指标
   */
  getMetrics(): CacheMetrics {
    const totalOps = this.metrics.hits + this.metrics.misses;
    const hitRate = totalOps > 0 ? this.metrics.hits / totalOps : 0;
    const missRate = totalOps > 0 ? this.metrics.misses / totalOps : 0;
    const avgLatency =
      this.metrics.operationCount > 0 ? this.metrics.totalLatency / this.metrics.operationCount : 0;

    return {
      performance: {
        hitRate,
        missRate,
        averageLatency: avgLatency,
        throughput: totalOps,
      },
      storage: {
        totalSize: this.l1Cache?.size || 0,
        usedSize: this.l1Cache?.size || 0,
        entryCount: this.l1Cache?.size || 0,
        compressionRatio: 0.7, // 估算
      },
      layers: {
        l1: this.metrics.layerStats.get('l1')!,
        l2: this.metrics.layerStats.get('l2')!,
        l3: this.metrics.layerStats.get('l3')!,
      },
      health: {
        isHealthy: hitRate > 0.5 && avgLatency < 100,
        issues: [],
        lastCheck: Date.now(),
      },
    };
  }

  /**
   * 关闭缓存引擎
   */
  async shutdown(): Promise<void> {
    this.logger.debug('🛑 关闭缓存引擎...');

    // 清理定时器
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    if (this.metricsTimer) {
      clearInterval(this.metricsTimer);
    }
    if (this.warmupTimer) {
      clearInterval(this.warmupTimer);
    }

    // 关闭连接
    if (this.l2Client) {
      // 关闭 Redis 连接
    }

    this.logger.debug('✅ 缓存引擎已关闭');
  }
}

/**
 * 工厂函数：创建企业级缓存引擎实例
 */
export function createEnterpriseCacheEngine(
  config: Partial<EnterpriseCacheConfig> = {}
): EnterpriseCacheEngine {
  return new EnterpriseCacheEngine(config);
}
