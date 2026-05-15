/**
 * 内存缓存适配器
 * 基于 LRU + TTL 的高性能内存缓存实现
 *
 * 特性：
 * - LRU 淘汰策略，防止内存无限增长
 * - TTL 过期支持，惰性清理 + 定时扫描
 * - 标签系统，支持批量缓存失效
 */

import type {
  ICacheAdapter,
  CacheSetOptions,
  CacheEntryMeta,
  CacheInspectionItem,
} from './ICacheAdapter';

/** 内存缓存条目 */
interface MemoryCacheEntry<T = unknown> {
  value: T;
  meta: CacheEntryMeta;
  tags: string[];
}

/** 内存缓存适配器配置 */
export interface MemoryCacheConfig {
  /** 最大容量 */
  capacity: number;
  /** 默认 TTL (秒)，0 表示永不过期 */
  defaultTTL: number;
  /** 过期清理间隔 (ms) */
  cleanupInterval: number;
}

const DEFAULT_CONFIG: MemoryCacheConfig = {
  capacity: 10000,
  defaultTTL: 0,
  cleanupInterval: 60_000, // 1 分钟
};

export class MemoryCacheAdapter implements ICacheAdapter {
  readonly name = 'memory';

  private cache: Map<string, MemoryCacheEntry> = new Map();
  private tagIndex: Map<string, Set<string>> = new Map(); // tag -> keys
  private config: MemoryCacheConfig;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: Partial<MemoryCacheConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // 启动定时清理
    if (this.config.cleanupInterval > 0) {
      this.cleanupTimer = setInterval(() => {
        this.evictExpired();
      }, this.config.cleanupInterval);

      // 允许 Node.js 进程在不等待 timer 的情况下退出
      if (this.cleanupTimer.unref) {
        this.cleanupTimer.unref();
      }
    }
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const entry = this.cache.get(key);

    if (!entry) {
      return undefined;
    }

    // 惰性检查 TTL
    if (this.isExpired(entry)) {
      this.deleteEntry(key, entry);
      return undefined;
    }

    // LRU：刷新位置
    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry.value as T;
  }

  async set<T = unknown>(key: string, value: T, options?: CacheSetOptions): Promise<void> {
    // 如果已存在，先清理旧标签索引
    const existing = this.cache.get(key);
    if (existing) {
      this.removeFromTagIndex(key, existing.tags);
      this.cache.delete(key);
    }

    // 容量淘汰 - LRU
    while (this.cache.size >= this.config.capacity) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        const oldestEntry = this.cache.get(oldestKey);
        if (oldestEntry) {
          this.deleteEntry(oldestKey, oldestEntry);
        }
      } else {
        break;
      }
    }

    const ttl = options?.ttl ?? this.config.defaultTTL;
    const now = Date.now();

    const meta: CacheEntryMeta = {
      createdAt: now,
      ttl: ttl > 0 ? ttl : undefined,
      expiresAt: ttl > 0 ? now + ttl * 1000 : undefined,
      size: this.estimateSize(value),
    };

    const tags = options?.tags ?? [];
    const entry: MemoryCacheEntry<T> = { value, meta, tags };

    this.cache.set(key, entry as MemoryCacheEntry);

    // 更新标签索引
    for (const tag of tags) {
      let set = this.tagIndex.get(tag);
      if (!set) {
        set = new Set();
        this.tagIndex.set(tag, set);
      }
      set.add(key);
    }
  }

  async has(key: string): Promise<boolean> {
    const entry = this.cache.get(key);
    if (!entry) return false;

    if (this.isExpired(entry)) {
      this.deleteEntry(key, entry);
      return false;
    }

    return true;
  }

  async delete(key: string): Promise<boolean> {
    const entry = this.cache.get(key);
    if (!entry) return false;

    this.deleteEntry(key, entry);
    return true;
  }

  async clear(): Promise<void> {
    this.cache.clear();
    this.tagIndex.clear();
  }

  async getMany<T = unknown>(keys: string[]): Promise<Map<string, T | undefined>> {
    const result = new Map<string, T | undefined>();
    for (const key of keys) {
      result.set(key, await this.get<T>(key));
    }
    return result;
  }

  async setMany<T = unknown>(
    entries: Array<{ key: string; value: T; options?: CacheSetOptions }>
  ): Promise<void> {
    for (const { key, value, options } of entries) {
      await this.set(key, value, options);
    }
  }

  async invalidateByTag(tag: string): Promise<number> {
    const keys = this.tagIndex.get(tag);
    if (!keys || keys.size === 0) return 0;

    let count = 0;
    // 复制一份 keys，避免遍历中修改
    const keysToDelete = [...keys];
    for (const key of keysToDelete) {
      const entry = this.cache.get(key);
      if (entry) {
        this.deleteEntry(key, entry);
        count++;
      }
    }

    return count;
  }

  isConnected(): boolean {
    return true; // 内存缓存始终可用
  }

  async inspect(limit: number): Promise<CacheInspectionItem[]> {
    const cap = limit > 0 ? limit : this.config.capacity;
    const now = Date.now();
    const out: CacheInspectionItem[] = [];
    for (const [key, entry] of this.cache) {
      if (out.length >= cap) break;
      if (this.isExpired(entry)) continue; // 已过期但还没 evict 的不展示
      out.push({
        key,
        sizeBytes: entry.meta.size ?? 0,
        storedAt: entry.meta.createdAt,
        ttlSecondsRemaining: entry.meta.expiresAt
          ? Math.max(0, Math.ceil((entry.meta.expiresAt - now) / 1000))
          : undefined,
        tags: entry.tags,
      });
    }
    return out;
  }

  async destroy(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.cache.clear();
    this.tagIndex.clear();
  }

  // ─── 私有方法 ─────────────────────────────────

  private isExpired(entry: MemoryCacheEntry): boolean {
    if (!entry.meta.expiresAt) return false;
    return Date.now() >= entry.meta.expiresAt;
  }

  private deleteEntry(key: string, entry: MemoryCacheEntry): void {
    this.removeFromTagIndex(key, entry.tags);
    this.cache.delete(key);
  }

  private removeFromTagIndex(key: string, tags: string[]): void {
    for (const tag of tags) {
      const tagSet = this.tagIndex.get(tag);
      if (tagSet) {
        tagSet.delete(key);
        if (tagSet.size === 0) {
          this.tagIndex.delete(tag);
        }
      }
    }
  }

  /** 清理过期条目 */
  private evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (entry.meta.expiresAt && now >= entry.meta.expiresAt) {
        this.deleteEntry(key, entry);
      }
    }
  }

  /** 估算值大小 (粗略) */
  private estimateSize(value: unknown): number {
    if (typeof value === 'string') return value.length * 2;
    if (typeof value === 'number') return 8;
    if (typeof value === 'boolean') return 4;
    if (value === null || value === undefined) return 0;
    try {
      return JSON.stringify(value).length * 2;
    } catch {
      return 256; // 默认估算
    }
  }
}
