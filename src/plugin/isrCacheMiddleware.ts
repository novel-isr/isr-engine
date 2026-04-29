/**
 * ISR 缓存中间件插件 —— engine 的差异化核心能力
 *
 * 架构位置：
 *   Express → [security/compression/body] → admin routes → **ISR Cache** → Vite → @vitejs/plugin-rsc handler
 *
 * 工作流（含 SWR / stale-while-revalidate）：
 *   1. 拦截可缓存的 GET 请求（HTML / RSC Flight 流），构造 cache key
 *   2. HIT：`now < expiresAt` → 直接回放（`X-Cache-Status: HIT`）
 *   3. STALE：`expiresAt ≤ now < hardExpiresAt` → 回放旧内容（`X-Cache-Status: STALE`）
 *      并在后台发起一次内部 HTTP 请求（带 `X-ISR-Background-Revalidate: 1` 头）
 *      触发重新渲染 + 入缓存，不阻塞当前响应
 *   4. MISS：无条目 / 超过 hardExpiresAt → 放行到 Vite + plugin-rsc 渲染，
 *      monkey-patch res.write/res.end 捕获字节后入缓存
 *
 * 失效链路：
 *   Server Action 调用 revalidatePath('/x') → rsc/revalidate 分发 →
 *   本插件在 registerInvalidator 注册的 callback 清理 `GET:/x` 与 `GET:/x_.rsc` 条目
 *
 * 缓存策略：
 *   - 只缓存 GET 请求 + 200 状态 + Content-Type 为 text/html 或 text/x-component 的响应
 *   - 路由级配置：
 *       '/'        : 'isr'                                    -- shorthand，用默认 TTL
 *       '/books'   : { mode: 'isr', ttl: 60, staleWhileRevalidate: 300 }
 *       '/about'   : 'ssg'
 *       '/login'   : 'ssr'                                    -- 不缓存
 *   - 默认 TTL：ssr.config.ts 的 `isr.revalidate`（默认 3600 秒）
 *   - Vite 内部路径 (/@*, /__vite*, /node_modules/.vite/*) 和静态资源一律旁路
 *
 * 可观测性：
 *   响应头 `X-Cache-Status: HIT | STALE | MISS | BYPASS | REVALIDATING`
 *   响应头 `X-Cache-Key` 便于排错
 *   响应头 `X-Cache-Age`（HIT/STALE 时命中的年龄，秒）
 */

import http from 'node:http';
import { createMemoryCacheStore, type IsrCacheStore, type IsrCachedEntry } from './isrCacheStore';
import {
  recordHttpRequest,
  cacheEntriesGauge,
  cacheRevalidatingGauge,
} from '../metrics/PromMetrics';
import type { Plugin, Connect } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { ISRConfig, RenderModeType, RouteRule } from '../types';
import { Logger } from '../logger/Logger';
import { registerInvalidator } from '@/rsc/revalidate';
import { collectTags, runWithTagStore, isUncacheable } from '@/rsc/cacheTag';
import { loadConfig } from '../config/loadConfig';
import { resolveAdminConfig, createAdminAuthMiddleware } from '@/server/adminConfig';
import { stripRscClientReferenceCacheSuffix } from './devAssetRequestMiddleware';
import { createAutoCacheStore } from '@/cache/createAutoCacheStore';
import { RedisInvalidationBus } from '@/cache/RedisInvalidationBus';

const logger = Logger.getInstance();

/** 单条缓存条目 —— 与 IsrCacheStore 对齐 */
type CachedEntry = IsrCachedEntry;

/** 路由匹配解析结果（对应一个请求的缓存策略） */
interface ResolvedRouteRule {
  mode: RenderModeType;
  ttlSeconds: number;
  swrSeconds: number;
}

/** 路由规则的统一视图（兼容原始 ssr.config 与归一化后的 engine 配置） */
interface RoutingRules {
  globalMode: RenderModeType;
  routes: Record<string, RouteRule>;
  defaultTtlSeconds: number;
}

/** 插件选项 */
export interface IsrCacheMiddlewareOptions {
  /** 缓存最大条目数，默认 1000 */
  max?: number;
  /** 默认 TTL（秒），若未显式配置 isr.revalidate 时兜底 */
  defaultTtlSeconds?: number;
  /**
   * 自定义 cache store —— 默认 createMemoryCacheStore({ max })
   * 想用 Redis/Hybrid：优先在 ssr.config.ts 配 runtime.redis；更底层的自定义 store
   * 仍可通过这里传入。engine 不强依赖 ioredis，符合 optionalDependencies 设计。
   */
  store?: IsrCacheStore;
  /**
   * Optional cross-process invalidation bus. Local revalidateTag/Path first
   * clears this process, then publishes the same target for sibling pods.
   */
  invalidationBus?: IsrInvalidationBus;
  /**
   * L2（如 Redis）异步读超时，毫秒。默认 100ms。
   * 超时按 miss 处理，防止 Redis 抖动拖慢 HIT/STALE 路径。
   */
  l2ReadTimeoutMs?: number;
  /**
   * 后台重验证请求的生命周期上限，毫秒。默认 30_000。
   * 防止 bg 请求卡住时 `revalidating` Set 永不清理导致后续 STALE 不再触发重渲。
   */
  backgroundRevalidateTimeoutMs?: number;
  /**
   * A/B variant 隔离。
   * 默认值：配置 runtime.experiments 时自动启用；否则关闭。
   * 启用后：cacheKey 追加 `|v=<fnv1a(cookie)>` 摘要，同一路径的不同 variant 用户各自独立缓存。
   * 适用：variant 影响 HTML 结构且数量 ≤ 4；不适用：按 user 细粒度分桶。
   */
  variantIsolation?: boolean;
  /**
   * variant 隔离时读取的 cookie 名称，默认 'ab'（与 ABVariantMiddleware 的默认值对齐）。
   */
  variantCookieName?: string;
  /**
   * Cache key 应用层 namespace —— bump 它即整体失效（无需 SCAN/FLUSH），TTL 自然回收旧 entry。
   * 默认 `process.env.ISR_CACHE_NAMESPACE ?? 'default'`。
   *
   * 使用场景：
   *   - 业务上线了不兼容 schema 的渲染产物（比如某 component 改了输出结构）
   *   - 想强制全站冷启动而不影响其他共享 Redis 的服务
   * 实现：所有 cache key 形如 `<ENGINE_VERSION>:<namespace>:<原始 key>`
   *      旧前缀的 keys 仍在 Redis 但不再被读到，按 TTL 自然过期
   */
  cacheNamespace?: string;
  /**
   * HIT 时的相关路径预热。命中响应正常发回 client 后，**异步、非阻塞**地对相关路径
   * 发起内部 HTTP 预热请求，让下一跳直接 HIT。
   *
   * 配置示例：
   *   prefetchOnHit: ({ path }) => {
   *     if (/^\/book\/[^/]+$/.test(path)) {
   *       const id = path.split('/')[2];
   *       return [`/book/${id}/reviews`, `/book/${id}/related`];
   *     }
   *     return [];
   *   }
   *
   * 防自激：同一个目标路径在 `prefetchCooldownMs` 窗口内只触发一次（默认 30s）。
   * 防递归：预热请求带 sentinel header `X-ISR-Prefetch: 1`，命中 HIT 时不再触发二级预热。
   */
  prefetchOnHit?: (ctx: { path: string; cacheKey: string }) => string[] | Promise<string[]>;
  /**
   * 同目标 path 的预热冷却窗口（毫秒）。默认 30_000。
   */
  prefetchCooldownMs?: number;
  /**
   * 单条响应入缓存的字节上限。默认 5 * 1024 * 1024（5 MB）。
   *
   * 渲染阶段每个 chunk 写入 res 的同时会被累积进 `chunks: Buffer[]`，
   * 超过此阈值时**立刻丢弃捕获缓冲并跳过本次入缓存**（已发出的字节不影响 client）。
   *
   * 防御场景：
   *   - 列表页未分页导致渲染产物巨大
   *   - 上游 API 一次性返回大对象，模板逐字塞入 HTML
   *   - 并发 MISS 时 N × 大响应同时驻留堆中导致 OOM
   *
   * 设 0 关闭（不推荐）。
   */
  maxCachedBodyBytes?: number;
  /**
   * MISS 回源 single-flight 等待上限（毫秒）。默认 5_000。
   *
   * 现象：当 N 个并发请求同时 MISS 同一 key 时，第一个会触发渲染 + 入缓存，其余的会
   * 等这个渲染完成（最多等 singleflightWaitMs），等到则读一次 cache，HIT 直接回放；
   * 等不到（渲染慢或挂了）则 follower 自己走原始 MISS 路径继续渲染（fail-open，
   * 防止首请求异常导致全部 follower 永久卡死）。
   *
   * 设 0 关闭（不推荐——失去 thundering herd 保护，缓存击穿瞬间会把上游打挂）。
   */
  singleflightWaitMs?: number;
}

/**
 * Engine 内部 cache key 格式版本。仅 engine 自身在 isrCachedEntry 序列化结构变化时 bump。
 * 用户层 namespace 用 cacheNamespace / ISR_CACHE_NAMESPACE 控制（独立维度）。
 */
const ENGINE_CACHE_KEY_VERSION = 'e1';

export type IsrInvalidationTarget =
  | { kind: 'path'; value: string }
  | { kind: 'tag'; value: string };

export interface IsrInvalidationBus {
  publish(target: IsrInvalidationTarget): Promise<void> | void;
  subscribe(listener: (target: IsrInvalidationTarget) => Promise<void> | void): () => void;
  destroy?(): Promise<void> | void;
}

/** RSC 流响应的子路径后缀（与站点 framework/request.tsx 约定一致） */
const RSC_URL_POSTFIX = '_.rsc';

/** 后台重验证请求的 sentinel 头，避免循环 */
const BG_REVALIDATE_HEADER = 'x-isr-background-revalidate';

/** 预热请求的 sentinel 头，避免 HIT → prefetch → HIT → prefetch 二次自激 */
const PREFETCH_HEADER = 'x-isr-prefetch';

/** 从 ISRConfig 提取路由规则 */
function extractRoutingRules(
  config: Partial<ISRConfig> | undefined,
  fallbackTtl: number
): RoutingRules {
  const cfg = (config ?? {}) as Record<string, unknown>;
  const globalMode = (cfg.renderMode as RenderModeType | undefined) || 'isr';
  const routes = (cfg.routes as Record<string, RouteRule> | undefined) || {};

  const isr = (cfg.isr ?? {}) as { revalidate?: number };
  const defaultTtlSeconds =
    typeof isr.revalidate === 'number' && isr.revalidate > 0 ? isr.revalidate : fallbackTtl;

  return { globalMode, routes, defaultTtlSeconds };
}

/**
 * 解析单条路由规则为 mode + TTL + SWR 窗口
 * shorthand 使用默认 TTL，SWR 窗口默认等于 TTL（即有效使用时间 = 2x TTL）
 */
function parseRouteRule(value: RouteRule, defaultTtl: number): ResolvedRouteRule {
  if (typeof value === 'string') {
    const ttl = defaultTtl;
    return { mode: value, ttlSeconds: ttl, swrSeconds: ttl };
  }
  const ttl = typeof value.ttl === 'number' && value.ttl > 0 ? value.ttl : defaultTtl;
  const swr =
    typeof value.staleWhileRevalidate === 'number' && value.staleWhileRevalidate >= 0
      ? value.staleWhileRevalidate
      : ttl;
  return { mode: value.mode, ttlSeconds: ttl, swrSeconds: swr };
}

/**
 * 按路径匹配路由规则 —— 精确 > 最长 glob > 全局默认
 */
function matchRouteRule(path: string, rules: RoutingRules): ResolvedRouteRule {
  const { routes, defaultTtlSeconds, globalMode } = rules;

  if (routes[path] !== undefined) {
    return parseRouteRule(routes[path], defaultTtlSeconds);
  }

  const globPatterns = Object.keys(routes)
    .filter(p => p.includes('*'))
    .sort((a, b) => b.length - a.length);

  for (const pattern of globPatterns) {
    if (matchGlob(pattern, path)) {
      return parseRouteRule(routes[pattern], defaultTtlSeconds);
    }
  }

  // 回退到全局模式，使用默认 TTL/SWR
  return parseRouteRule(globalMode, defaultTtlSeconds);
}

function hasRedisRuntime(config: Partial<ISRConfig> | undefined): boolean {
  const redis = config?.runtime?.redis;
  return Boolean(redis?.url || redis?.host || process.env.REDIS_URL || process.env.REDIS_HOST);
}

function withRuntimeCacheOptions(
  config: Partial<ISRConfig> | undefined,
  options: IsrCacheMiddlewareOptions
): IsrCacheMiddlewareOptions {
  if (options.store) return options;

  const redis = config?.runtime?.redis;
  const hasRedis = hasRedisRuntime(config);
  return {
    ...options,
    store: createAutoCacheStore({
      max: options.max,
      redisUrl: redis?.url,
      redisHost: redis?.host,
      redisPort: redis?.port,
      redisPassword: redis?.password,
      redisKeyPrefix: redis?.keyPrefix,
    }),
    invalidationBus:
      options.invalidationBus ??
      (hasRedis
        ? new RedisInvalidationBus({
            url: redis?.url,
            host: redis?.host,
            port: redis?.port,
            password: redis?.password,
            keyPrefix: redis?.keyPrefix,
            channel: redis?.invalidationChannel,
          })
        : undefined),
  };
}

function matchGlob(pattern: string, path: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(path);
}

/** SSG 路由 TTL 拉长（默认 ×24），避免 SSG 被频繁重生 */
function applyModeTtlMultiplier(mode: RenderModeType, ttlSeconds: number): number {
  if (mode === 'ssg') return ttlSeconds * 24;
  return ttlSeconds;
}

/**
 * 框架无关的 ISR 缓存 handler —— connect-style 中间件
 */
export interface IsrCacheHandler {
  (req: IncomingMessage, res: ServerResponse, next: Connect.NextFunction): void;
  stats(): { size: number; max: number; revalidating: number; backend: 'memory' | 'hybrid' };
  clear(): void;
  destroy(): Promise<void>;
}

/**
 * 创建 ISR 缓存处理器（不绑定具体框架）
 */
export function createIsrCacheHandler(
  config: Partial<ISRConfig> | undefined,
  options: IsrCacheMiddlewareOptions = {}
): IsrCacheHandler {
  const cache: IsrCacheStore =
    options.store ?? createMemoryCacheStore({ max: options.max ?? 1000 });

  const fallbackTtl = options.defaultTtlSeconds ?? 3600;
  const rules: RoutingRules = extractRoutingRules(config, fallbackTtl);
  const l2ReadTimeoutMs = options.l2ReadTimeoutMs ?? 100;
  const bgTimeoutMs = options.backgroundRevalidateTimeoutMs ?? 30_000;
  const hasExperiments =
    !!config?.runtime?.experiments && Object.keys(config.runtime.experiments).length > 0;
  const variantIsolation = options.variantIsolation ?? hasExperiments;
  const variantCookieName = options.variantCookieName ?? 'ab';
  const cacheNamespace = options.cacheNamespace ?? process.env.ISR_CACHE_NAMESPACE ?? 'default';
  const cacheKeyPrefix = `${ENGINE_CACHE_KEY_VERSION}:${cacheNamespace}:`;

  /** 后台重验证正在进行的 key 集合 —— 防止并发 STALE 请求重复触发多次 bg 拉取 */
  const revalidating = new Set<string>();
  const singleflightWaitMs = options.singleflightWaitMs ?? 5_000;
  const maxCachedBodyBytes = options.maxCachedBodyBytes ?? 5 * 1024 * 1024;
  const prefetchOnHit = options.prefetchOnHit;
  const prefetchCooldownMs = options.prefetchCooldownMs ?? 30_000;
  /** 最近一次预热触发时间记录，用于冷却窗口去重 */
  const prefetchCooldown = new Map<string, number>();
  /**
   * MISS 回源 single-flight 锁 —— key 到 deferred promise；首请求开始渲染时注册，
   * captureAndStore.onFinish 触发 resolve，并发 follower 通过 await 该 promise + 重读 cache 实现 HIT 回放。
   */
  const inflightRegens = new Map<string, { promise: Promise<void>; resolve: () => void }>();

  const invalidateLocal = async (target: IsrInvalidationTarget): Promise<void> => {
    if (target.kind === 'path') {
      const normalized = normalizePath(target.value);
      const keys = [
        `${cacheKeyPrefix}GET:${normalized}`,
        `${cacheKeyPrefix}GET:${normalized}${RSC_URL_POSTFIX}`,
        `${cacheKeyPrefix}GET:${normalized}/${RSC_URL_POSTFIX}`,
      ];
      let cleared = 0;
      for (const key of Array.from(cache.keys())) {
        if (keys.some(k => key === k) || keys.some(k => key.startsWith(`${k}?`))) {
          if (cache.delete(key)) cleared++;
        }
      }
      logger.info(`🔁 ISR cache invalidate path=${normalized} → 清除 ${cleared} 条`);
    } else {
      let cleared = 0;
      for (const [key, entry] of Array.from(cache.entries())) {
        if (entry.tags.includes(target.value)) {
          cache.delete(key);
          cleared++;
        }
      }
      logger.info(
        `🔁 ISR cache invalidate tag=${target.value} → 精准清除 ${cleared} 条（按 tag 匹配）`
      );
    }
  };

  // 注册 invalidator —— Server Action 调用 revalidatePath/Tag 时触发
  const unregisterInvalidator = registerInvalidator(async target => {
    await invalidateLocal(target);
    await options.invalidationBus?.publish(target);
  });

  const unsubscribeBus = options.invalidationBus?.subscribe(async target => {
    await invalidateLocal(target);
  });

  const handler = ((req: IncomingMessage, res: ServerResponse, next: Connect.NextFunction) => {
    void handleRequest(req, res, next, {
      cache,
      rules,
      revalidating,
      l2ReadTimeoutMs,
      bgTimeoutMs,
      variantIsolation,
      variantCookieName,
      cacheKeyPrefix,
      inflightRegens,
      singleflightWaitMs,
      maxCachedBodyBytes,
      prefetchOnHit,
      prefetchCooldownMs,
      prefetchCooldown,
    }).catch(err => {
      logger.warn('ISR cache handler 异常，回退到下游处理:', err);
      if (!res.headersSent) {
        setHeaderOnce(res, 'X-Cache-Status', 'BYPASS');
      }
      next();
    });
  }) as IsrCacheHandler;

  handler.stats = () => ({
    size: cache.size,
    max: cache.max,
    revalidating: revalidating.size,
    backend: cache.backend,
  });
  handler.clear = () => {
    // 释放所有等待 follower（让它们退出等待，自己重走 MISS）
    for (const slot of inflightRegens.values()) slot.resolve();
    inflightRegens.clear();
    cache.clear();
  };
  handler.destroy = async () => {
    unregisterInvalidator();
    unsubscribeBus?.();
    await options.invalidationBus?.destroy?.();
    for (const slot of inflightRegens.values()) slot.resolve();
    inflightRegens.clear();
    await cache.destroy();
  };

  return handler;
}

/**
 * 创建 ISR 缓存 Vite 插件（dev 模式）
 */
export function createIsrCacheMiddleware(
  explicitConfig: Partial<ISRConfig> | undefined,
  options: IsrCacheMiddlewareOptions = {}
): Plugin {
  const hasExplicit = Boolean(explicitConfig && Object.keys(explicitConfig).length > 0);

  let mounted = false;
  let handler: IsrCacheHandler | null = null;

  return {
    name: 'isr-cache-middleware',
    async configureServer(server) {
      if (mounted) return;
      mounted = true;

      let resolvedConfig: Partial<ISRConfig> | undefined = explicitConfig;
      if (!hasExplicit) {
        try {
          resolvedConfig = await loadConfig({ cwd: server.config.root });
          const rules = extractRoutingRules(resolvedConfig, options.defaultTtlSeconds ?? 3600);
          logger.info(
            `📋 ISR cache: 自动加载 ssr.config.ts 成功（mode=${rules.globalMode}, overrides=${Object.keys(rules.routes).length}）`
          );
        } catch (err) {
          logger.warn('ISR cache: ssr.config.ts 加载失败，将按默认 ISR 模式缓存所有路由', err);
        }
      }

      handler = createIsrCacheHandler(
        resolvedConfig,
        withRuntimeCacheOptions(resolvedConfig, options)
      );
      const adminConfig = resolveAdminConfig(resolvedConfig, 'development');

      // dev 也暴露 admin 端点 —— 与生产 cli/start.ts 行为对齐，
      // 便于 /dev/observability 等观测页面在开发期就能拉到统计数据
      server.middlewares.use((req, res, next) => {
        const activeHandler = handler;
        if (!activeHandler) {
          next();
          return;
        }
        if (adminConfig.stats.enabled && req.url === '/__isr/stats' && req.method === 'GET') {
          createAdminAuthMiddleware('stats', adminConfig)(req as never, res as never, () => {
            res.setHeader('content-type', 'application/json; charset=utf-8');
            res.end(JSON.stringify(activeHandler.stats()));
          });
          return;
        }
        if (adminConfig.clear.enabled && req.url === '/__isr/clear' && req.method === 'POST') {
          createAdminAuthMiddleware('clear', adminConfig)(req as never, res as never, () => {
            activeHandler.clear();
            res.setHeader('content-type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true, cleared: true }));
          });
          return;
        }
        // Prometheus exposition：scrape 端点
        if (adminConfig.metrics.enabled && req.url === '/metrics' && req.method === 'GET') {
          createAdminAuthMiddleware('metrics', adminConfig)(req as never, res as never, () => {
            import('@/metrics/PromMetrics')
              .then(async ({ promRegistry }) => {
                const body = await promRegistry.metrics();
                res.setHeader('content-type', promRegistry.contentType);
                res.end(body);
              })
              .catch(err => {
                res.statusCode = 500;
                res.end(`metrics error: ${String(err)}`);
              });
          });
          return;
        }
        next();
      });

      server.middlewares.use(handler);
    },
  };
}

interface HandleContext {
  cache: IsrCacheStore;
  rules: RoutingRules;
  revalidating: Set<string>;
  l2ReadTimeoutMs: number;
  bgTimeoutMs: number;
  variantIsolation: boolean;
  variantCookieName: string;
  cacheKeyPrefix: string;
  inflightRegens: Map<string, { promise: Promise<void>; resolve: () => void }>;
  singleflightWaitMs: number;
  maxCachedBodyBytes: number;
  prefetchOnHit?: (ctx: { path: string; cacheKey: string }) => string[] | Promise<string[]>;
  prefetchCooldownMs: number;
  prefetchCooldown: Map<string, number>;
}

/**
 * 单次请求的缓存处理
 */
async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  next: Connect.NextFunction,
  ctx: HandleContext
): Promise<void> {
  const url = req.url || '/';
  const method = req.method || 'GET';

  // ─── prom-client：单一观测点 —— 响应结束时记录所有标签 ──────
  const startNs = process.hrtime.bigint();
  res.once('finish', () => {
    try {
      const durationMs = Number(process.hrtime.bigint() - startNs) / 1_000_000;
      const route = stripRscSuffix(stripQuery(url)) || '/';
      const cache = String(res.getHeader('X-Cache-Status') || 'BYPASS');
      const mode = String(res.getHeader('X-Resolved-Mode') || 'unknown');
      recordHttpRequest({
        method,
        route,
        status: res.statusCode,
        mode,
        cache,
        durationMs,
      });
      cacheEntriesGauge.set({ backend: ctx.cache.backend }, ctx.cache.size);
      cacheRevalidatingGauge.set(ctx.revalidating.size);
    } catch {
      /* metrics 失败不能影响响应 */
    }
  });

  if ((method !== 'GET' && method !== 'HEAD') || isBypassPath(url)) {
    setHeaderOnce(res, 'X-Cache-Status', 'BYPASS');
    next();
    return Promise.resolve();
  }

  const logicalPath = stripRscSuffix(stripQuery(url));
  let resolved = matchRouteRule(logicalPath, ctx.rules);

  // 运行时模式覆盖：?mode=isr|ssr|ssg
  // 用于开发 / 调试时临时观察不同模式的效果，不需要改 ssr.config
  const overrideMode = parseModeOverride(url);
  if (overrideMode) {
    resolved = { ...resolved, mode: overrideMode };
    setHeaderOnce(res, 'X-Mode-Source', 'query-override');
  } else {
    setHeaderOnce(res, 'X-Mode-Source', 'config');
  }
  setHeaderOnce(res, 'X-Resolved-Mode', resolved.mode);

  if (!isCacheableMode(resolved.mode)) {
    setHeaderOnce(res, 'X-Cache-Status', 'BYPASS');
    next();
    return Promise.resolve();
  }

  const cacheKey = buildCacheKey(method, url, req, ctx);
  setHeaderOnce(res, 'X-Cache-Key', cacheKey);

  // 后台重验证请求：忽略所有缓存状态，强制 MISS 并重新入库
  const isBgRevalidate = String(req.headers[BG_REVALIDATE_HEADER] || '') === '1';
  if (isBgRevalidate) {
    setHeaderOnce(res, 'X-Cache-Status', 'REVALIDATING');
    runMissPath(req, res, next, ctx, resolved, cacheKey, /* swrBgKey */ cacheKey);
    return;
  }

  let entry = ctx.cache.get(cacheKey);
  if (!entry && ctx.cache.getAsync) {
    try {
      // L2 读有硬上限：超时按 miss 处理，防止 Redis 抖动拖慢 HIT/STALE 路径
      entry = await raceWithTimeout(ctx.cache.getAsync(cacheKey), ctx.l2ReadTimeoutMs);
    } catch (err) {
      logger.warn(`ISR cache L2 read 失败 ${cacheKey}: ${(err as Error).message}`);
    }
  }
  const now = Date.now();

  // HIT
  if (entry && now < entry.expiresAt) {
    replayEntry(res, entry, cacheKey, 'HIT');
    // 异步预热相关路径（不阻塞 client 响应）。仅普通 HIT 触发，预热请求自身命中 HIT 不再二次预热。
    const isPrefetchRequest = String(req.headers[PREFETCH_HEADER] || '') === '1';
    if (!isPrefetchRequest && ctx.prefetchOnHit) {
      triggerPrefetch(req, logicalPath, cacheKey, ctx);
    }
    return;
  }

  // STALE（TTL 已过但仍在 SWR 窗口内）：回放旧内容 + 后台异步重验证
  if (entry && now < entry.hardExpiresAt) {
    replayEntry(res, entry, cacheKey, 'STALE');
    triggerBackgroundRevalidation(req, cacheKey, ctx);
    return;
  }

  // 硬过期：剔除并走 MISS
  if (entry) {
    ctx.cache.delete(cacheKey);
  }

  // ─── MISS single-flight：并发 MISS 合并成 1 次回源 ───
  // 首请求注册 inflight，后续 follower 等其完成后重读 cache HIT 回放。
  // 等待超时（singleflightWaitMs）则 follower 退化为各自走 MISS（fail-open，
  // 避免首请求异常时所有 follower 永久卡死）。
  if (ctx.singleflightWaitMs > 0) {
    const existing = ctx.inflightRegens.get(cacheKey);
    if (existing) {
      try {
        await raceWithTimeout(existing.promise, ctx.singleflightWaitMs);
      } catch {
        /* leader 异常退出由 finally release 处理；follower 直接重读 cache */
      }
      let recheck = ctx.cache.get(cacheKey);
      if (!recheck && ctx.cache.getAsync) {
        try {
          recheck = await raceWithTimeout(ctx.cache.getAsync(cacheKey), ctx.l2ReadTimeoutMs);
        } catch {
          /* L2 读失败按 miss 处理 */
        }
      }
      const nowAfter = Date.now();
      if (recheck && nowAfter < recheck.expiresAt) {
        replayEntry(res, recheck, cacheKey, 'HIT');
        return;
      }
      if (recheck && nowAfter < recheck.hardExpiresAt) {
        replayEntry(res, recheck, cacheKey, 'STALE');
        return;
      }
      // 等不到 / 还是没有：fail-open，自己走 MISS
    }
    // 注册自己为 leader —— deferred resolver 模式：先声明再被 Promise 构造器覆盖
    let resolveFn!: () => void;
    const promise = new Promise<void>(resolve => {
      resolveFn = resolve;
    });
    ctx.inflightRegens.set(cacheKey, { promise, resolve: resolveFn });
  }

  runMissPath(req, res, next, ctx, resolved, cacheKey, null);
}

/**
 * MISS 路径：放行到下游渲染 + 捕获字节入缓存
 */
function runMissPath(
  _req: IncomingMessage,
  res: ServerResponse,
  next: Connect.NextFunction,
  ctx: HandleContext,
  resolved: ResolvedRouteRule,
  cacheKey: string,
  bgRevalidateKey: string | null
): void {
  if (!res.getHeader('X-Cache-Status')) {
    res.setHeader('X-Cache-Status', 'MISS');
  }
  const ttl = applyModeTtlMultiplier(resolved.mode, resolved.ttlSeconds);
  const swr = resolved.swrSeconds;

  // Single-flight 释放：无论入缓存成功/失败/响应中断，本次 leader 渲染结束后
  // 必须释放 inflight 锁，否则 follower 永远等不到 promise resolve。
  // 用 res.once('close') 兜底（client 中断 / OOM 等异常退出场景）。
  //
  // 关键：仅当本次是 normal MISS leader（bgRevalidateKey === null）时才释放——
  // bg 重验证路径不持有 inflight，若误释放会清掉一个并发 MISS leader 注册的 slot，
  // 导致 follower 提前唤醒读到过时缓存。
  const slot = bgRevalidateKey === null ? ctx.inflightRegens.get(cacheKey) : undefined;
  if (slot) {
    // 用闭包绑定首次注册的 slot 引用，避免后续错释放
    let released = false;
    const releaseSingleflight = (): void => {
      if (released) return;
      released = true;
      // 仅在 map 里仍是同一 slot 时才删除（防御并发清理 / handler.clear）
      if (ctx.inflightRegens.get(cacheKey) === slot) {
        ctx.inflightRegens.delete(cacheKey);
      }
      slot.resolve();
    };
    res.once('close', releaseSingleflight);
    res.once('finish', releaseSingleflight);
  }

  runWithTagStore(() => {
    captureAndStore(res, ctx.maxCachedBodyBytes, cacheKey, captured => {
      if (captured.overflow) return;
      if (captured.statusCode !== 200) return;
      const ct = String(captured.headers['content-type'] || '');
      if (!ct.includes('text/html') && !ct.includes('text/x-component')) return;

      // 用户态响应禁止缓存：含 Set-Cookie 的响应意味着服务端在给本次请求者下发
      // session/CSRF token/身份识别。若入缓存，后续 HIT 回放会把 cookie 发给其他用户，
      // 等同于跨账号会话泄露（高危）。这里严格拒绝入缓存，记一行 info。
      if (hasSetCookie(captured.headers)) {
        logger.info(
          `⏭️  ISR cache skip ${cacheKey} —— 响应含 Set-Cookie（用户态响应不可共享缓存）`
        );
        return;
      }

      // CSR shell / fallback 响应是最后一道自救，不是页面内容的可共享快照。
      // 一旦写进 ISR cache，后续正常请求可能 HIT 到降级壳，造成缓存污染。
      if (
        String(captured.headers['x-fallback-used'] || '').toLowerCase() === 'true' ||
        String(captured.headers['x-render-strategy'] || '').toLowerCase() === 'csr-shell'
      ) {
        logger.info(
          `⏭️  ISR cache skip ${cacheKey} —— 响应为 fallback/csr-shell（降级壳不可写入 ISR 缓存）`
        );
        return;
      }

      // 渲染期 Server Component 调用了 markUncacheable() —— 比如上游接口失败、
      // 渲染了降级 UI —— 跳过入缓存，避免错误内容被反复 HIT 回放
      if (isUncacheable()) {
        logger.info(
          `⏭️  ISR cache skip ${cacheKey} —— Server Component 调用了 markUncacheable()，本次响应正常返回但不写入 ISR 缓存`
        );
        return;
      }

      const tags = collectTags();
      const now = Date.now();
      ctx.cache.set(cacheKey, {
        body: captured.body,
        statusCode: captured.statusCode,
        headers: captured.headers,
        contentType: ct,
        storedAt: now,
        expiresAt: now + ttl * 1000,
        hardExpiresAt: now + (ttl + swr) * 1000,
        tags,
      });
      logger.debug(
        `💾 ISR cache store ${cacheKey} (mode=${resolved.mode}, ttl=${ttl}s, swr=${swr}s, size=${captured.body.length}B, tags=[${tags.join(',')}])`
      );

      // 本次是后台重验证：标记 in-flight 结束
      if (bgRevalidateKey) {
        ctx.revalidating.delete(bgRevalidateKey);
      }
    });

    next();
  });
}

/**
 * 后台发起一次内部 HTTP 请求，带 sentinel 头；中间件见到该头直接走 MISS 路径
 *
 * 生命周期保障：
 *   - bg 请求与响应自身有 error/end 监听，正常路径清 `revalidating`
 *   - 额外挂 `safetyTimer`（默认 30s），防止底层 socket hang / 上游永不响应导致
 *     `revalidating` 永不清，后续 STALE 请求不再触发重渲
 *   - 同时给 bgReq 挂 `setTimeout` + `destroy`，让 socket 层也能主动释放
 */
function triggerBackgroundRevalidation(
  req: IncomingMessage,
  cacheKey: string,
  ctx: HandleContext
): void {
  if (ctx.revalidating.has(cacheKey)) {
    return;
  }
  ctx.revalidating.add(cacheKey);

  const host = req.headers.host || 'localhost';
  const path = req.url || '/';
  const [hostname, portStr] = host.split(':');
  const port = portStr
    ? Number(portStr)
    : // 读取当前 socket 监听端口（兜底）
      (req.socket && (req.socket as unknown as { localPort?: number }).localPort) || 80;

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    ctx.revalidating.delete(cacheKey);
  };
  const safetyTimer = setTimeout(() => {
    logger.warn(`ISR bg revalidate ${cacheKey} 超时 ${ctx.bgTimeoutMs}ms，强制释放 in-flight`);
    release();
  }, ctx.bgTimeoutMs);
  if (typeof safetyTimer.unref === 'function') safetyTimer.unref();

  setImmediate(() => {
    try {
      const bgReq = http.request(
        {
          hostname: hostname || 'localhost',
          port,
          path,
          method: 'GET',
          headers: {
            [BG_REVALIDATE_HEADER]: '1',
            accept: 'text/html',
          },
          timeout: ctx.bgTimeoutMs,
        },
        bgRes => {
          bgRes.on('data', chunk => void chunk);
          bgRes.on('end', () => {
            clearTimeout(safetyTimer);
            release();
            logger.debug(`♻️ ISR bg revalidate done ${cacheKey} (status=${bgRes.statusCode})`);
          });
          bgRes.on('error', () => {
            clearTimeout(safetyTimer);
            release();
          });
        }
      );
      bgReq.on('error', err => {
        clearTimeout(safetyTimer);
        logger.warn(`ISR bg revalidate ${cacheKey} 发起失败: ${(err as Error).message}`);
        release();
      });
      bgReq.on('timeout', () => {
        logger.warn(`ISR bg revalidate ${cacheKey} socket timeout`);
        bgReq.destroy();
      });
      bgReq.end();
    } catch (err) {
      clearTimeout(safetyTimer);
      logger.warn(`ISR bg revalidate ${cacheKey} 调度异常`, err);
      release();
    }
  });
}

/**
 * 异步预热相关路径 —— HIT 命中时调用。
 * 通过用户提供的 prefetchOnHit 回调拿到目标路径数组，对每个目标发起内部 HTTP 请求
 * （带 PREFETCH_HEADER sentinel），让 ISR 中间件按 MISS 路径自然填缓存。
 *
 * 防自激：sentinel header 在 HIT 时检测，不再触发二级预热
 * 防风暴：同目标在 prefetchCooldownMs 窗口内只触发一次
 * 防回压：每个目标用独立 setImmediate 调度，不阻塞调用者
 */
function triggerPrefetch(
  req: IncomingMessage,
  sourcePath: string,
  sourceCacheKey: string,
  ctx: HandleContext
): void {
  const prefetchOnHit = ctx.prefetchOnHit;
  if (!prefetchOnHit) return;
  const host = req.headers.host || 'localhost';
  const [hostname, portStr] = host.split(':');
  const port = portStr
    ? Number(portStr)
    : (req.socket && (req.socket as unknown as { localPort?: number }).localPort) || 80;

  setImmediate(async () => {
    let targets: string[] = [];
    try {
      const result = await prefetchOnHit({ path: sourcePath, cacheKey: sourceCacheKey });
      if (Array.isArray(result)) targets = result;
    } catch (err) {
      logger.warn(`ISR prefetch hook 执行失败 from=${sourcePath}`, err);
      return;
    }

    const now = Date.now();
    for (const target of targets) {
      if (typeof target !== 'string' || !target.startsWith('/')) continue;
      const lastFire = ctx.prefetchCooldown.get(target);
      if (lastFire && now - lastFire < ctx.prefetchCooldownMs) continue;
      ctx.prefetchCooldown.set(target, now);

      try {
        const prefetchReq = http.request(
          {
            hostname: hostname || 'localhost',
            port,
            path: target,
            method: 'GET',
            headers: {
              [PREFETCH_HEADER]: '1',
              accept: 'text/html',
            },
            timeout: 15_000,
          },
          prefetchRes => {
            // 必须 drain 以让 socket 进入 keep-alive 池
            prefetchRes.on('data', chunk => void chunk);
            prefetchRes.on('end', () => {
              logger.debug(
                `🔥 ISR prefetch ${target} (status=${prefetchRes.statusCode}, from=${sourcePath})`
              );
            });
            prefetchRes.on('error', () => {
              /* 不要阻断主响应，吞掉 */
            });
          }
        );
        prefetchReq.on('error', err => {
          logger.warn(`ISR prefetch ${target} 发起失败: ${(err as Error).message}`);
        });
        prefetchReq.on('timeout', () => prefetchReq.destroy());
        prefetchReq.end();
      } catch (err) {
        logger.warn(`ISR prefetch ${target} 调度异常`, err);
      }
    }
  });
}

/**
 * 重放已缓存条目到响应
 */
function replayEntry(
  res: ServerResponse,
  entry: CachedEntry,
  cacheKey: string,
  status: 'HIT' | 'STALE'
): void {
  res.statusCode = entry.statusCode;
  for (const [name, value] of Object.entries(entry.headers)) {
    const lower = name.toLowerCase();
    if (
      lower === 'x-cache-status' ||
      lower === 'x-cache-key' ||
      lower === 'x-cache-age' ||
      lower === 'content-length'
    ) {
      continue;
    }
    try {
      res.setHeader(name, value);
    } catch {
      // 某些头只能在写之前设置；失败忽略
    }
  }
  res.setHeader('X-Cache-Status', status);
  res.setHeader('X-Cache-Key', cacheKey);
  res.setHeader('X-Cache-Age', String(Math.floor((Date.now() - entry.storedAt) / 1000)));
  res.end(entry.body);
}

interface Captured {
  body: Buffer;
  statusCode: number;
  headers: Record<string, string | number | string[]>;
  /** 累计字节超过 maxBytes 时为 true —— 调用方应跳过入缓存。已写到 client 的字节不受影响。*/
  overflow: boolean;
}

/**
 * 监听 res.write/end 累积响应字节，结束时通过 onFinish 回调出 body + 头给入缓存逻辑。
 *
 * 内存保护：累计 size 超过 `maxBytes` 立刻**丢弃 chunks 数组并标记 overflow**，
 * 此后写入的字节仍正常推送到 client（不影响响应），但不再驻留。这样：
 *   - 慢 client + 巨型响应不会让 Node 堆持续膨胀
 *   - 并发 MISS 多份巨响应不会叠加 OOM
 *
 * `maxBytes <= 0` 时禁用上限（保留旧行为）。
 */
function captureAndStore(
  res: ServerResponse,
  maxBytes: number,
  cacheKey: string,
  onFinish: (captured: Captured) => void
): void {
  let chunks: Buffer[] | null = [];
  let totalBytes = 0;
  let overflow = false;
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);

  const ingest = (chunk: unknown): void => {
    if (!chunk || overflow) return;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string | Uint8Array);
    totalBytes += buf.length;
    if (maxBytes > 0 && totalBytes > maxBytes) {
      overflow = true;
      chunks = null; // 释放已累积的字节给 GC
      logger.info(
        `⏭️  ISR cache skip ${cacheKey} —— 响应大小 ${totalBytes}B 超过 maxCachedBodyBytes=${maxBytes}B（不入缓存，但响应正常发往 client）`
      );
      return;
    }
    // overflow=false 路径：chunks 必非 null（chunks=null 仅发生在 overflow=true 分支）
    if (chunks) chunks.push(buf);
  };

  res.write = function patchedWrite(chunk: unknown, ...args: unknown[]): boolean {
    ingest(chunk);
    return (originalWrite as (...a: unknown[]) => boolean)(chunk, ...args);
  } as typeof res.write;

  res.end = function patchedEnd(chunk?: unknown, ...args: unknown[]): ServerResponse {
    ingest(chunk);
    try {
      // 由于 cache 中间件在 compression 之后挂载，res.write 拦截到的 chunk 是 *压缩前*
      // 的原始字节，但 res.getHeaders() 此时已经包含了 compression 添加的 content-encoding /
      // content-length。直接保存这两个头会导致 replay 时 "原始字节 + 压缩头" 的不匹配
      // （浏览器报 ERR_CONTENT_DECODING_FAILED）。
      // 这里在 store 时就剥离这两项，让 replay 时下游 compression 中间件根据当前请求的
      // Accept-Encoding 重新协商压缩。
      const headers = { ...(res.getHeaders() as Record<string, string | number | string[]>) };
      delete headers['content-encoding'];
      delete headers['Content-Encoding'];
      delete headers['content-length'];
      delete headers['Content-Length'];

      // overflow=false 路径上 chunks 必非 null —— 用 ?? [] 让类型系统能证明
      const safeChunks = chunks ?? [];
      onFinish({
        body: overflow
          ? Buffer.alloc(0)
          : safeChunks.length === 1
            ? safeChunks[0]
            : Buffer.concat(safeChunks),
        statusCode: res.statusCode,
        headers,
        overflow,
      });
    } catch (err) {
      logger.warn('ISR cache 存储回调异常:', err);
    }
    return (originalEnd as (...a: unknown[]) => ServerResponse)(chunk, ...args);
  } as typeof res.end;
}

// ── 工具函数 ──

function isCacheableMode(mode: RenderModeType): boolean {
  return mode === 'isr' || mode === 'ssg';
}

function isBypassPath(url: string): boolean {
  const p = stripRscClientReferenceCacheSuffix(stripQuery(url));
  if (p.startsWith('/@')) return true;
  if (p.startsWith('/__vite')) return true;
  if (p.startsWith('/__isr')) return true;
  if (p.startsWith('/_/')) return true; // engine 内部端点（图片优化 / 字体等）
  if (p === '/metrics') return true; // prom-client scrape
  if (p === '/health') return true;
  if (p === '/sitemap.xml' || p === '/robots.txt') return true;
  if (p.startsWith('/node_modules/.vite')) return true;
  if (p.includes('/.vite/')) return true;
  if (
    /\.(js|mjs|cjs|ts|tsx|jsx|json|map|css|scss|sass|less|stylus|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|eot|mp3|mp4|webm|ogg|wasm|zip|pdf)(\?|$)/i.test(
      p
    )
  ) {
    return true;
  }
  return false;
}

function stripQuery(url: string): string {
  const i = url.indexOf('?');
  return i === -1 ? url : url.slice(0, i);
}

/**
 * 从 URL 查询字符串解析 `mode=isr|ssr|ssg` 开发调试覆盖
 * csr 不在用户级 mode 列表（是 server 崩溃时的内部 fallback）
 */
function parseModeOverride(url: string): RenderModeType | undefined {
  const qIdx = url.indexOf('?');
  if (qIdx === -1) return undefined;
  const params = new URLSearchParams(url.slice(qIdx + 1));
  const mode = params.get('mode');
  if (mode === 'isr' || mode === 'ssr' || mode === 'ssg') {
    return mode;
  }
  return undefined;
}

function stripRscSuffix(path: string): string {
  if (path.endsWith(`/${RSC_URL_POSTFIX}`)) {
    return path.slice(0, -(RSC_URL_POSTFIX.length + 1)) || '/';
  }
  if (path.endsWith(RSC_URL_POSTFIX)) {
    return path.slice(0, -RSC_URL_POSTFIX.length) || '/';
  }
  return path;
}

function normalizePath(path: string): string {
  if (!path.startsWith('/')) return `/${path}`;
  return path;
}

function setHeaderOnce(res: ServerResponse, name: string, value: string): void {
  if (res.headersSent) return;
  if (!res.getHeader(name)) {
    res.setHeader(name, value);
  }
}

/**
 * 构造 cache key —— 以下三项决定同一响应能否被 HIT：
 *   1) method + pathname（基础）
 *   2) query 参数按字母序归一（`?b=2&a=1` 与 `?a=1&b=2` 命中同一条目，消除碎片化）
 *   3) 可选 variant hash（配置 runtime.experiments 后自动启用，也可显式覆盖）
 *
 * 不进 key 的字段（故意）：
 *   - Accept-Language：由站点层 `/zh/x` vs `/x` URL 路由处理
 *   - Accept-Encoding：captureAndStore 已剥离 content-encoding，replay 时下游 compression 重协商
 *   - Cookie（除 variant cookie）：含 Set-Cookie 的响应已在 captureAndStore 路径拒绝入缓存
 */
function buildCacheKey(
  method: string,
  url: string,
  req: IncomingMessage,
  ctx: HandleContext
): string {
  const [pathname, rawQuery] = splitUrl(url);
  const normalized = normalizeQuery(rawQuery);
  let key = `${ctx.cacheKeyPrefix}${method}:${pathname}`;
  if (normalized) key += `?${normalized}`;
  if (ctx.variantIsolation) {
    const digest = extractVariantDigest(req, ctx.variantCookieName);
    if (digest) key += `|v=${digest}`;
  }
  return key;
}

function splitUrl(url: string): [string, string] {
  const i = url.indexOf('?');
  return i === -1 ? [url, ''] : [url.slice(0, i), url.slice(i + 1)];
}

function normalizeQuery(query: string): string {
  if (!query) return '';
  const params = new URLSearchParams(query);
  const pairs: Array<[string, string]> = [];
  for (const [k, v] of params) pairs.push([k, v]);
  if (pairs.length === 0) return '';
  pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

function extractVariantDigest(req: IncomingMessage, cookieName: string): string | null {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;
  const escaped = cookieName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${escaped}=([^;]+)`));
  if (!match) return null;
  return fnv1a(decodeURIComponent(match[1]));
}

/** 32-bit FNV-1a hash；返回 base36 字符串。无 crypto 依赖，稳定、快速 */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function hasSetCookie(headers: Record<string, string | number | string[]>): boolean {
  const sc = headers['set-cookie'] ?? headers['Set-Cookie'];
  if (!sc) return false;
  if (Array.isArray(sc)) return sc.length > 0;
  return String(sc).length > 0;
}

/**
 * 带超时的异步读：超时返回 undefined（按 cache miss 处理），不抛错。
 * 原始 promise 的后续 resolve/reject 不会再影响流程。
 */
function raceWithTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  if (!(ms > 0)) return p as Promise<T | undefined>;
  return new Promise<T | undefined>(resolve => {
    const timer = setTimeout(() => resolve(undefined), ms);
    if (typeof timer.unref === 'function') timer.unref();
    p.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      }
    );
  });
}
