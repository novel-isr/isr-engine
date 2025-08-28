/**
 * 企业级缓存策略实现
 * 提供多层缓存、智能预取、缓存预热等高级功能
 */

import { CacheManager } from './CacheManager';
import { Logger } from '../utils/Logger';

export interface CacheKeyOptions {
  prefix?: string;
  includeHeaders?: string[];
  includeQuery?: string[];
  excludeQuery?: string[];
  customHash?: (context: any) => string;
}

export interface CacheWarmupConfig {
  routes: string[];
  priority: number;
  batchSize: number;
  interval: number;
  maxConcurrent: number;
}

export interface CachePrefetchRule {
  pattern: RegExp;
  relatedPaths: string[];
  priority: number;
  maxAge: number;
}

/**
 * 多层缓存策略
 * L1: 内存缓存 (最快)
 * L2: Redis 分布式缓存 (中等速度，可共享)
 * L3: 文件系统缓存 (慢但持久)
 */
export class MultiTierCacheStrategy {
  private l1Cache: CacheManager; // Memory
  private l2Cache?: CacheManager; // Redis
  private l3Cache?: CacheManager; // FileSystem
  private logger: Logger;
  private config: any;

  constructor(config: any) {
    this.config = config;
    this.logger = new Logger(config.verbose);
    
    // Initialize cache layers
    this.l1Cache = new CacheManager({
      ...config,
      strategy: 'memory',
      maxSize: config.l1?.maxSize || 500,
    });

    if (config.l2?.enabled) {
      this.l2Cache = new CacheManager({
        ...config,
        strategy: 'redis',
        redis: config.l2.redis,
      });
    }

    if (config.l3?.enabled) {
      this.l3Cache = new CacheManager({
        ...config,
        strategy: 'filesystem',
        maxSize: config.l3?.maxSize || 10000,
      });
    }
  }

  async initialize() {
    await this.l1Cache.initialize();
    if (this.l2Cache) await this.l2Cache.initialize();
    if (this.l3Cache) await this.l3Cache.initialize();
    this.logger.info('Multi-tier cache strategy initialized');
  }

  async get(key: string): Promise<any> {
    // Try L1 first
    let result = await this.l1Cache.get(key);
    if (result) {
      this.logger.debug(`Cache L1 hit: ${key}`);
      return result;
    }

    // Try L2
    if (this.l2Cache) {
      result = await this.l2Cache.get(key);
      if (result) {
        this.logger.debug(`Cache L2 hit: ${key}`);
        // Populate L1 for faster access next time
        await this.l1Cache.set(key, result, this.config.l1?.ttl);
        return result;
      }
    }

    // Try L3
    if (this.l3Cache) {
      result = await this.l3Cache.get(key);
      if (result) {
        this.logger.debug(`Cache L3 hit: ${key}`);
        // Populate upper layers
        await this.l1Cache.set(key, result, this.config.l1?.ttl);
        if (this.l2Cache) {
          await this.l2Cache.set(key, result, this.config.l2?.ttl);
        }
        return result;
      }
    }

    this.logger.debug(`Cache miss: ${key}`);
    return null;
  }

  async set(key: string, value: any, options: { l1Ttl?: number; l2Ttl?: number; l3Ttl?: number } = {}) {
    // Set in all available layers
    const promises: Promise<void>[] = [];

    promises.push(this.l1Cache.set(key, value, options.l1Ttl || this.config.l1?.ttl));

    if (this.l2Cache) {
      promises.push(this.l2Cache.set(key, value, options.l2Ttl || this.config.l2?.ttl));
    }

    if (this.l3Cache) {
      promises.push(this.l3Cache.set(key, value, options.l3Ttl || this.config.l3?.ttl));
    }

    await Promise.all(promises);
    this.logger.debug(`Cache set in all layers: ${key}`);
  }

  async delete(key: string) {
    // Delete from all layers
    const promises: Promise<void>[] = [this.l1Cache.delete(key)];

    if (this.l2Cache) promises.push(this.l2Cache.delete(key));
    if (this.l3Cache) promises.push(this.l3Cache.delete(key));

    await Promise.all(promises);
    this.logger.debug(`Cache deleted from all layers: ${key}`);
  }

  async clear() {
    const promises: Promise<void>[] = [this.l1Cache.clear()];
    if (this.l2Cache) promises.push(this.l2Cache.clear());
    if (this.l3Cache) promises.push(this.l3Cache.clear());
    
    await Promise.all(promises);
    this.logger.info('All cache layers cleared');
  }

  getStats() {
    return {
      l1: this.l1Cache.getStats(),
      l2: this.l2Cache?.getStats(),
      l3: this.l3Cache?.getStats(),
    };
  }
}

/**
 * 智能缓存键生成器
 */
export class CacheKeyGenerator {
  private config: CacheKeyOptions;

  constructor(config: CacheKeyOptions = {}) {
    this.config = config;
  }

  generateKey(context: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    query?: Record<string, string>;
    renderMode?: string;
    user?: { id: string; role: string };
  }): string {
    if (this.config.customHash) {
      return this.config.customHash(context);
    }

    const parts: string[] = [];

    // Add prefix
    if (this.config.prefix) {
      parts.push(this.config.prefix);
    }

    // Add render mode
    if (context.renderMode) {
      parts.push(`mode:${context.renderMode}`);
    }

    // Add URL (clean)
    const url = new URL(context.url, 'http://localhost');
    parts.push(`path:${url.pathname}`);

    // Add selected headers
    if (this.config.includeHeaders && context.headers) {
      for (const header of this.config.includeHeaders) {
        const value = context.headers[header.toLowerCase()];
        if (value) {
          parts.push(`h:${header}:${value}`);
        }
      }
    }

    // Add query parameters
    if (context.query) {
      const queryParams = new URLSearchParams();
      
      for (const [key, value] of Object.entries(context.query)) {
        // Include specific query params
        if (this.config.includeQuery?.includes(key)) {
          queryParams.set(key, value);
        }
        // Include all unless excluded
        else if (!this.config.excludeQuery?.includes(key)) {
          queryParams.set(key, value);
        }
      }

      if (queryParams.toString()) {
        parts.push(`q:${queryParams.toString()}`);
      }
    }

    // Add user context for personalized content
    if (context.user) {
      parts.push(`u:${context.user.role}:${this.hashString(context.user.id)}`);
    }

    const key = parts.join('|');
    
    // Ensure key is not too long
    if (key.length > 250) {
      return this.hashString(key);
    }

    return key;
  }

  private hashString(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(36);
  }
}

/**
 * 缓存预热管理器
 */
export class CacheWarmupManager {
  private cache: MultiTierCacheStrategy;
  private config: CacheWarmupConfig;
  private logger: Logger;
  private renderFunction: (url: string) => Promise<any>;
  private isWarming = false;
  private warmupQueue: { url: string; priority: number }[] = [];

  constructor(
    cache: MultiTierCacheStrategy,
    config: CacheWarmupConfig,
    renderFunction: (url: string) => Promise<any>
  ) {
    this.cache = cache;
    this.config = config;
    this.renderFunction = renderFunction;
    this.logger = new Logger(true);
  }

  async startWarmup() {
    if (this.isWarming) {
      this.logger.warn('Cache warmup already in progress');
      return;
    }

    this.isWarming = true;
    this.logger.info('Starting cache warmup...');

    // Add routes to queue with priorities
    for (const route of this.config.routes) {
      this.warmupQueue.push({
        url: route,
        priority: this.config.priority,
      });
    }

    // Sort by priority (higher first)
    this.warmupQueue.sort((a, b) => b.priority - a.priority);

    await this.processWarmupQueue();
    
    this.isWarming = false;
    this.logger.info('Cache warmup completed');
  }

  private async processWarmupQueue() {
    const batches = this.chunkArray(this.warmupQueue, this.config.batchSize);

    for (const batch of batches) {
      const promises = batch.map(({ url }) => this.warmupRoute(url));
      
      // Process batch with concurrency limit
      await this.processWithLimit(promises, this.config.maxConcurrent);
      
      // Wait between batches
      if (this.config.interval > 0) {
        await new Promise(resolve => setTimeout(resolve, this.config.interval));
      }
    }
  }

  private async warmupRoute(url: string) {
    try {
      this.logger.debug(`Warming up route: ${url}`);
      
      const keyGenerator = new CacheKeyGenerator();
      const cacheKey = keyGenerator.generateKey({ url, renderMode: 'isr' });
      
      // Check if already cached
      const cached = await this.cache.get(cacheKey);
      if (cached) {
        this.logger.debug(`Route already cached: ${url}`);
        return;
      }

      // Render and cache
      const result = await this.renderFunction(url);
      await this.cache.set(cacheKey, result);
      
      this.logger.debug(`Successfully warmed up: ${url}`);
    } catch (error) {
      this.logger.error(`Failed to warm up route ${url}:`, error);
    }
  }

  private chunkArray<T>(array: T[], chunkSize: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += chunkSize) {
      chunks.push(array.slice(i, i + chunkSize));
    }
    return chunks;
  }

  private async processWithLimit(promises: Promise<any>[], limit: number) {
    const executing: Promise<any>[] = [];

    for (const promise of promises) {
      const p = promise.then(() => {
        executing.splice(executing.indexOf(p), 1);
      });
      
      executing.push(p);

      if (executing.length >= limit) {
        await Promise.race(executing);
      }
    }

    await Promise.all(executing);
  }

  addRoute(url: string, priority: number = this.config.priority) {
    this.warmupQueue.push({ url, priority });
    this.warmupQueue.sort((a, b) => b.priority - a.priority);
  }

  getWarmupStatus() {
    return {
      isWarming: this.isWarming,
      queueLength: this.warmupQueue.length,
      config: this.config,
    };
  }
}

/**
 * 智能预取管理器
 */
export class CachePrefetchManager {
  private cache: MultiTierCacheStrategy;
  private rules: CachePrefetchRule[];
  private renderFunction: (url: string) => Promise<any>;
  private logger: Logger;
  private prefetchQueue: Set<string> = new Set();

  constructor(
    cache: MultiTierCacheStrategy,
    rules: CachePrefetchRule[],
    renderFunction: (url: string) => Promise<any>
  ) {
    this.cache = cache;
    this.rules = rules.sort((a, b) => b.priority - a.priority);
    this.renderFunction = renderFunction;
    this.logger = new Logger(true);
  }

  async onPageRequest(url: string) {
    // Find matching rules for this URL
    const matchingRules = this.rules.filter(rule => rule.pattern.test(url));

    if (matchingRules.length === 0) {
      return;
    }

    this.logger.debug(`Found ${matchingRules.length} prefetch rules for: ${url}`);

    // Collect all related paths to prefetch
    const pathsToPrefetch = new Set<string>();
    
    for (const rule of matchingRules) {
      for (const relatedPath of rule.relatedPaths) {
        // Support template substitution
        const processedPath = this.processPathTemplate(relatedPath, url);
        if (processedPath && !this.prefetchQueue.has(processedPath)) {
          pathsToPrefetch.add(processedPath);
        }
      }
    }

    // Start prefetching in background
    if (pathsToPrefetch.size > 0) {
      this.startPrefetch(Array.from(pathsToPrefetch), matchingRules[0].maxAge);
    }
  }

  private processPathTemplate(template: string, currentUrl: string): string | null {
    try {
      const url = new URL(currentUrl, 'http://localhost');
      
      // Replace template variables
      return template
        .replace(':pathname', url.pathname)
        .replace(':origin', url.origin)
        .replace(/:param\(([^)]+)\)/g, (match, paramName) => {
          // Extract parameter from current URL
          const pathParts = url.pathname.split('/');
          const paramIndex = pathParts.findIndex(part => part.includes(paramName));
          return paramIndex >= 0 ? pathParts[paramIndex] : '';
        });
    } catch {
      return template; // Return as-is if not a template
    }
  }

  private async startPrefetch(paths: string[], maxAge: number) {
    // Add to queue to prevent duplicates
    for (const path of paths) {
      this.prefetchQueue.add(path);
    }

    // Process in background
    setTimeout(async () => {
      await this.processPrefetchBatch(paths, maxAge);
    }, 100); // Small delay to not block main request
  }

  private async processPrefetchBatch(paths: string[], maxAge: number) {
    const keyGenerator = new CacheKeyGenerator();
    
    for (const path of paths) {
      try {
        const cacheKey = keyGenerator.generateKey({ url: path, renderMode: 'isr' });
        
        // Check if already cached
        const cached = await this.cache.get(cacheKey);
        if (cached) {
          this.logger.debug(`Prefetch skipped (already cached): ${path}`);
          this.prefetchQueue.delete(path);
          continue;
        }

        this.logger.debug(`Prefetching: ${path}`);
        
        // Render and cache with custom TTL
        const result = await this.renderFunction(path);
        await this.cache.set(cacheKey, result, {
          l1Ttl: maxAge,
          l2Ttl: maxAge * 2,
          l3Ttl: maxAge * 4,
        });
        
        this.logger.debug(`Successfully prefetched: ${path}`);
      } catch (error) {
        this.logger.error(`Failed to prefetch ${path}:`, error);
      } finally {
        this.prefetchQueue.delete(path);
      }
    }
  }

  addRule(rule: CachePrefetchRule) {
    this.rules.push(rule);
    this.rules.sort((a, b) => b.priority - a.priority);
  }

  getPrefetchStatus() {
    return {
      activeRules: this.rules.length,
      queueSize: this.prefetchQueue.size,
      rules: this.rules.map(r => ({
        pattern: r.pattern.source,
        priority: r.priority,
        relatedPathsCount: r.relatedPaths.length,
      })),
    };
  }
}
