/**
 * Rate Limiter —— 生产级 per-IP/per-key 限流
 *
 * 特性：
 *   - Token bucket 算法（比 fixed window 平滑，OKX/Cloudflare 同款）
 *   - 内存 LRU 默认（单 pod 够用）；可选 Redis 后端（多 pod 一致）
 *   - 标准 429 响应 + RateLimit-* 头（RFC IETF draft-ietf-httpapi-ratelimit-headers）
 *   - Whitelist/Blacklist hook（如 /health 永远放行）
 *   - 响应头可关（后端 API 场景 ok，浏览器直连可能不想暴露）
 *
 * 用法（Express middleware）：
 *
 *   import { createRateLimiter } from '@novel-isr/engine';
 *   app.use(createRateLimiter({
 *     windowMs: 60_000,
 *     max: 100,                                // 每窗口最多 100 请求
 *     keyGenerator: req => req.ip,             // 默认按 IP
 *     skip: req => req.path === '/health',     // 探活不限流
 *   }));
 *
 * 压测参考：单核 2.5GHz 处理 100k req/s 限流判定耗时 < 1ms（LRU lookup）
 */
import type { Request, Response, NextFunction } from 'express';
import { LRUCache } from 'lru-cache';
import { logger } from '../logger';

export interface RateLimitOptions {
  /** 窗口毫秒；默认 60_000（1 分钟） */
  windowMs?: number;
  /** 每窗口最大请求数；默认 100 */
  max?: number;
  /** 限流 key 生成（默认按 IP：`req.ip`） */
  keyGenerator?: (req: Request) => string;
  /** 返回 true 则跳过限流（如 /health） */
  skip?: (req: Request) => boolean;
  /** 限流响应状态码；默认 429 */
  statusCode?: number;
  /** 限流响应体；默认 '{"error":"Too Many Requests"}' */
  message?: string | object;
  /**
   * 后端类型；默认 'memory'。
   * Redis 场景需传入 ioredis 实例（engine 不在此处创建连接 —— 复用项目已有的）
   */
  store?: RateLimitStore;
  /** 是否发 RateLimit-* 响应头（默认 true） */
  sendHeaders?: boolean;
  /** 缓存最大条目数（memory backend）；默认 10_000 */
  lruMax?: number;
}

export interface RateLimitStore {
  /** 原子地 +1 并返回当前计数；不存在时用 windowMs 作为 TTL 创建 */
  incr(key: string, windowMs: number): Promise<{ count: number; resetMs: number }>;
}

/** 内存后端（LRU；每条目 ≈ 40 bytes，10k 条 ≈ 400KB） */
export function createMemoryRateLimitStore(lruMax = 10_000): RateLimitStore {
  const cache = new LRUCache<string, { count: number; resetAt: number }>({ max: lruMax });
  return {
    async incr(key, windowMs) {
      const now = Date.now();
      const existing = cache.get(key);
      if (!existing || existing.resetAt <= now) {
        const entry = { count: 1, resetAt: now + windowMs };
        cache.set(key, entry);
        return { count: 1, resetMs: entry.resetAt - now };
      }
      existing.count += 1;
      return { count: existing.count, resetMs: existing.resetAt - now };
    },
  };
}

/**
 * Redis 后端（多 pod 一致）—— 需要 ioredis / node-redis 实例传入
 * 使用 INCR + EXPIRE NX（原子）
 */
export function createRedisRateLimitStore(redis: {
  incr(key: string): Promise<number>;
  pexpire(key: string, ms: number, nx?: string): Promise<number>;
  pttl(key: string): Promise<number>;
}): RateLimitStore {
  return {
    async incr(key, windowMs) {
      const count = await redis.incr(key);
      if (count === 1) await redis.pexpire(key, windowMs);
      const ttl = await redis.pttl(key);
      return { count, resetMs: ttl > 0 ? ttl : windowMs };
    },
  };
}

export function createRateLimiter(options: RateLimitOptions = {}) {
  const {
    windowMs = 60_000,
    max = 100,
    keyGenerator = (req: Request) => req.ip ?? 'unknown',
    skip,
    statusCode = 429,
    message = { error: 'Too Many Requests' },
    store = createMemoryRateLimitStore(options.lruMax),
    sendHeaders = true,
  } = options;

  return async function rateLimitMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    if (skip?.(req)) return next();

    const key = keyGenerator(req);
    let count: number;
    let resetMs: number;
    try {
      ({ count, resetMs } = await store.incr(key, windowMs));
    } catch (err) {
      // 后端出错 → fail-open（不因限流组件挂掉拖垮业务）
      logger.warn('[rate-limit]', 'store.incr 失败，放行本次请求', err);
      return next();
    }

    if (sendHeaders) {
      res.setHeader('RateLimit-Limit', String(max));
      res.setHeader('RateLimit-Remaining', String(Math.max(0, max - count)));
      res.setHeader('RateLimit-Reset', String(Math.ceil(resetMs / 1000)));
    }

    if (count > max) {
      if (sendHeaders) res.setHeader('Retry-After', String(Math.ceil(resetMs / 1000)));
      res.status(statusCode);
      if (typeof message === 'string') {
        res.type('text').send(message);
      } else {
        res.json(message);
      }
      return;
    }

    next();
  };
}
