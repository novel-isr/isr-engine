/**
 * Rate Limiter —— 站点入口 per-IP/per-key 限流
 *
 * 特性：
 *   - Fixed-window counter：每个 key 在 windowMs 内最多 max 次请求
 *   - 内存 LRU 默认：单进程、单 pod、重启清空，适合 dev / 单实例 / 基础入口保护
 *   - Redis store 可选：用 Lua 原子 INCR + PEXPIRE，适合多 pod 共享限流状态
 *   - 标准 429 响应 + RateLimit-* 头（RFC IETF draft-ietf-httpapi-ratelimit-headers）
 *   - Whitelist/Blacklist hook（如 /health 永远放行）
 *   - 响应头可关（后端 API 场景 ok，浏览器直连可能不想暴露）
 *
 * 边界：
 *   - 这是应用层 L7 限流，不替代 CDN/WAF/API Gateway/DDoS 防护。
 *   - 对强配额、秒级突发控制或计费级 API quota，应在网关或专门配额服务使用
 *     sliding-window / token-bucket / leaky-bucket。
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
 * 压测参考：内存 store 是 O(1) LRU lookup；Redis store 是 1 次 Lua RTT。
 */
import type { Request, Response, NextFunction } from 'express';
import { LRUCache } from 'lru-cache';
import { logger } from '../logger';
import type { RuntimeRateLimitConfig, RuntimeRedisConfig } from '../types/ISRConfig';
import { hasRuntimeRedisConnection, resolveRuntimeRedisConfig } from '@/config/resolveRuntimeRedis';
import { buildKeyGenerator, extractClientIp, type UserBucketConfig } from './rate-limit-key';

// extractClientIp 仍对外暴露（小型自定义场景仍可能直接用）；buildKeyGenerator
// 是 engine 内部装配，业务侧用 RuntimeRateLimitConfig.userBucket 数据驱动配置即可。
export { extractClientIp };
export type { UserBucketConfig };

export interface RateLimitOptions {
  /** 窗口毫秒；默认 60_000（1 分钟） */
  windowMs?: number;
  /** 每窗口最大请求数；默认 100 */
  max?: number;
  /**
   * 已登录用户维度 key 配置 —— 数据驱动，不再传 function。
   * 配了 → 桶 key 形如 `u:<userId>`；未登录 / 没配 → `ip:<addr>`。
   */
  userBucket?: UserBucketConfig;
  /** 返回 true 则跳过限流（如 /health） */
  skip?: (req: Request) => boolean;
  /** 精确跳过的 path；默认已跳过 /health、/metrics */
  skipPaths?: readonly string[];
  /** 按 path 前缀跳过；适合业务自己的静态资源或内部探针 */
  skipPathPrefixes?: readonly string[];
  /** 按文件扩展名跳过；默认跳过静态资源扩展名 */
  skipExtensions?: readonly string[];
  /** 限流响应状态码；默认 429 */
  statusCode?: number;
  /** 限流响应体；默认 '{"error":"Too Many Requests"}' */
  message?: string | object;
  /**
   * 限流状态后端；默认 memory。
   * 手动接入时可传 createRedisRateLimitStore(redis)；ssr.config.ts 接入走
   * createRateLimitStoreFromRuntime(runtime.rateLimit, runtime.redis)。
   */
  store?: RateLimitStore;
  /**
   * 信任上游代理头（默认 false）。
   *   - false：直连公网，只用 req.ip
   *   - true：盲信代理头（不推荐生产）
   *   - 数字 N：信任最右 N 跳代理（推荐，hop count 跟部署拓扑对齐）
   *
   * 业务侧在 ssr.config.ts 配 `runtime.rateLimit.trustProxy`；
   * cli/start.ts 把数值透传给 Express `app.set('trust proxy', N)`。
   */
  trustProxy?: boolean | number;
}

// engine 内置（非业务决策，无需暴露给 ssr.config.ts）：
//   - 始终发 RateLimit-* / Retry-After 标准头（RFC IETF draft，业界惯例）
//   - memory backend LRU 上限 10_000（每条 ~40 字节，约 400KB；瓶颈不在这）
const ALWAYS_SEND_HEADERS = true;
const DEFAULT_LRU_MAX = 10_000;

export interface ResolvedRateLimitStore {
  store: RateLimitStore;
  backend: 'memory' | 'redis';
}

// extractClientIp / createUserAwareKeyGenerator 实现已搬到 ./rate-limit-key
// （文件顶部已 re-export）—— 旧 import 路径仍然兼容，新业务侧请用
// `@novel-isr/engine/rate-limit-key` 那个轻量入口避免拖 LRU/Redis bundle

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
 * Redis 后端（多 pod 一致）—— 需要 ioredis 实例传入。
 *
 * v2.1 起改用 EVAL（Lua 脚本）原子地完成 INCR + PEXPIRE NX + PTTL：
 *   - 1 次 RTT 而非 3 次（性能），延迟降 60%+
 *   - 跨副本下 INCR 与 PEXPIRE 之间不会插入别的命令（边界正确性）
 *   - 并发 N 个进程同时 incr 同一 key 不会产生"都设置了 TTL 但谁都没生效"的假象
 *
 * ioredis `defineCommand` 把脚本注册成伪命令，首次 EVAL、后续走 EVALSHA（自动管理）。
 */
export interface RedisLikeClient {
  incr(key: string): Promise<number>;
  pexpire(key: string, ms: number, nx?: string): Promise<number>;
  pttl(key: string): Promise<number>;
  defineCommand?: (name: string, opts: { numberOfKeys: number; lua: string }) => void;
  // 由 defineCommand 动态挂载；签名 (key, windowMs) => Promise<[count, pttl]>
  isrRateLimitIncr?: (key: string, windowMs: number) => Promise<[number, number]>;
}

const LUA_INCR_AND_TTL = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
return {c, ttl}
`;

export function createRedisRateLimitStore(redis: RedisLikeClient): RateLimitStore {
  // 若客户端支持 defineCommand（ioredis 都支持），优先注册原子脚本
  let useLua = false;
  if (typeof redis.defineCommand === 'function' && !redis.isrRateLimitIncr) {
    try {
      redis.defineCommand('isrRateLimitIncr', {
        numberOfKeys: 1,
        lua: LUA_INCR_AND_TTL,
      });
      useLua = true;
    } catch {
      // defineCommand 失败则回退到三命令序列
      useLua = false;
    }
  } else if (typeof redis.isrRateLimitIncr === 'function') {
    useLua = true;
  }

  return {
    async incr(key, windowMs) {
      if (useLua && redis.isrRateLimitIncr) {
        const [count, ttl] = await redis.isrRateLimitIncr(key, windowMs);
        return { count, resetMs: ttl > 0 ? ttl : windowMs };
      }
      // Fallback：三次 RTT，原子性依赖 Redis 单线程（仍可用但慢）
      const count = await redis.incr(key);
      if (count === 1) await redis.pexpire(key, windowMs);
      const ttl = await redis.pttl(key);
      return { count, resetMs: ttl > 0 ? ttl : windowMs };
    },
  };
}

const VALID_STORE_MODES = ['memory', 'redis', 'auto'] as const;
type StoreMode = (typeof VALID_STORE_MODES)[number];

const DEFAULT_SKIP_PATHS = new Set(['/health', '/metrics']);
const DEFAULT_SKIP_EXTENSIONS = new Set([
  '.avif',
  '.css',
  '.gif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.js',
  '.json',
  '.map',
  '.mjs',
  '.png',
  '.svg',
  '.txt',
  '.webmanifest',
  '.webp',
  '.woff',
  '.woff2',
]);
const DEV_ASSET_PREFIXES = [
  '/@fs/',
  '/@id/',
  '/@react-refresh',
  '/@vite/',
  '/node_modules/',
  '/src/',
];

function isDevRuntime(): boolean {
  return process.env.NODE_ENV !== 'production';
}

function normalizePath(path: string): string {
  return path.split('?')[0] || '/';
}

function hasSkippedExtension(path: string, extensions: ReadonlySet<string>): boolean {
  const lower = path.toLowerCase();
  for (const ext of extensions) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

export function shouldSkipRateLimitRequest(
  req: Pick<Request, 'method' | 'path'>,
  options: Pick<RateLimitOptions, 'skipExtensions' | 'skipPathPrefixes' | 'skipPaths'> = {}
): boolean {
  const path = normalizePath(req.path || '/');
  const method = (req.method ?? 'GET').toUpperCase();
  if (method === 'OPTIONS') return true;
  if (DEFAULT_SKIP_PATHS.has(path)) return true;

  const extensions = new Set([...DEFAULT_SKIP_EXTENSIONS, ...(options.skipExtensions ?? [])]);
  if (hasSkippedExtension(path, extensions)) return true;

  const prefixes = [
    ...(isDevRuntime() ? DEV_ASSET_PREFIXES : []),
    ...(options.skipPathPrefixes ?? []),
  ];
  if (prefixes.some(prefix => path === prefix || path.startsWith(prefix))) return true;

  return Boolean(options.skipPaths?.includes(path));
}

/**
 * 边界校验：把 `runtime.rateLimit.store` 的任意输入归一化为合法 StoreMode。
 *
 * 第一性：engine 拥有 `'memory' | 'redis' | 'auto'` 这个类型，校验就该在 engine 这层做，
 * 不应让每个消费方各写一遍 env-var sanitizer（重复劳动 + 错误信息不一致 + 静默吞坏值）。
 *
 * 行为：
 *   - undefined → 'auto'（开箱即用：有 Redis 自动用，没 Redis 落 memory）
 *   - 合法值 → 原样返回
 *   - 非法值（拼错 / 类型错）→ warn 一次 + 退到 'auto'，让运维知道而不是静默吞
 */
function resolveStoreMode(raw: unknown): StoreMode {
  if (raw === undefined || raw === null) return 'auto';
  if (typeof raw === 'string' && (VALID_STORE_MODES as readonly string[]).includes(raw)) {
    return raw as StoreMode;
  }
  logger.warn(
    '[rate-limit]',
    `runtime.rateLimit.store=${JSON.stringify(raw)} 不是合法值（期望 ${VALID_STORE_MODES.join(' | ')}），回退到 'auto'`
  );
  return 'auto';
}

/**
 * 从 ssr.config.ts runtime.rateLimit/runtime.redis 解析限流 store。
 *
 * 默认 'auto'：如果消费方已经显式配置 runtime.redis.url/host，engine 自动切到
 * redis backend；没有 Redis 则回落 memory。这样消费方 **不需要重复写 store 字段**
 * —— runtime.redis 是 engine 的统一真值源。
 *
 * 显式覆盖语义：
 *   - store: 'memory'  → 强制 memory，即使 runtime.redis 已配置（用于本地 burn-in）
 *   - store: 'redis'   → 强制 redis；缺 Redis 配置时 warn + 回落 memory（fail-open）
 *   - store: 'auto'    → 与不传等价
 *   - store: <脏值>    → warn 一次 + 当 'auto' 处理
 */
export async function createRateLimitStoreFromRuntime(
  rateLimit: Partial<RuntimeRateLimitConfig> = {},
  redis?: RuntimeRedisConfig
): Promise<ResolvedRateLimitStore> {
  const mode = resolveStoreMode(rateLimit.store);
  const resolvedRedis = resolveRuntimeRedisConfig(redis);
  const hasRedis = hasRuntimeRedisConnection(redis);
  const shouldUseRedis = mode === 'redis' || (mode === 'auto' && hasRedis);

  if (!shouldUseRedis) {
    return {
      store: createMemoryRateLimitStore(DEFAULT_LRU_MAX),
      backend: 'memory',
    };
  }

  if (!hasRedis) {
    logger.warn(
      '[rate-limit]',
      "runtime.rateLimit.store='redis' 但未检测到 runtime.redis.url/host，回退到 memory"
    );
    return {
      store: createMemoryRateLimitStore(DEFAULT_LRU_MAX),
      backend: 'memory',
    };
  }

  try {
    const mod = await import('ioredis');
    const Redis = mod.default;
    const url = resolvedRedis?.url;
    const host = resolvedRedis?.host ?? '127.0.0.1';
    const port = resolvedRedis?.port ?? 6379;
    const password = resolvedRedis?.password;
    const keyPrefix = rateLimit.keyPrefix ?? `${resolvedRedis?.keyPrefix ?? 'isr:'}rate-limit:`;
    const options: import('ioredis').RedisOptions = {
      host,
      port,
      password,
      keyPrefix,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 800,
      lazyConnect: false,
    };

    const client = url ? new Redis(url, options) : new Redis(options);
    let warned = false;
    client.on('error', err => {
      if (warned) return;
      warned = true;
      logger.warn('[rate-limit]', `Redis store error，限流将 fail-open：${err.message}`);
    });

    return {
      store: createRedisRateLimitStore(client),
      backend: 'redis',
    };
  } catch (err) {
    logger.warn('[rate-limit]', 'Redis store 初始化失败，回退到 memory', err);
    return {
      store: createMemoryRateLimitStore(DEFAULT_LRU_MAX),
      backend: 'memory',
    };
  }
}

/**
 * 全局逃生开关：`BENCH_DISABLE_RATE_LIMIT=1` 让本进程的所有 rate limiter 无脑放行。
 *
 * **仅供 bench / 压测使用**。生产绝不应该设置。原因：
 *   - bench 跑 60k QPS 时 max=200/min 的限流会让 99.7% 请求返 429，
 *     测出来的是 429 路径而非 ISR 真实路径
 *   - autocannon 用单个 IP 模拟 N 个连接，正常场景下用户来自不同 IP，
 *     用单 IP 算限流是不公平的
 *
 * 启动时若检测到该 env，打一行 warn 提醒；运行时检查是同步的（process.env 读取），
 * 影响可忽略。
 */
/** 每请求 O(1) env 读取 —— 让测试 / 运维可 runtime 翻开关而不需重启 */
function isBenchBypassActive(): boolean {
  return process.env.BENCH_DISABLE_RATE_LIMIT === '1';
}
if (isBenchBypassActive()) {
  logger.warn(
    '[rate-limit]',
    'BENCH_DISABLE_RATE_LIMIT=1 detected —— 所有限流器都将放行（bench 模式，生产绝禁）'
  );
}

/**
 * Hot-reload patch —— admin 控制面通过 Redis pub/sub 改 max/windowMs 时调。
 * 不持久化，仅修改当前进程内 closure 引用。下一次 store.incr 立即用新值。
 */
export interface RateLimiterHandle {
  /** Express middleware 本体 */
  (req: Request, res: Response, next: NextFunction): Promise<void>;
  /** 改 max / windowMs，下一次请求即生效。其它 options 不可热改。 */
  setConfig(patch: { max?: number; windowMs?: number }): void;
  /** 当前生效配置快照（admin 控制台展示用） */
  getConfig(): { max: number; windowMs: number };
}

export function createRateLimiter(options: RateLimitOptions = {}): RateLimiterHandle {
  // 透传给 keyGenerator —— number > 0 跟 boolean true 走同一条信任路径
  const trustProxy = options.trustProxy ?? false;
  const {
    skip,
    statusCode = 429,
    message = { error: 'Too Many Requests' },
    store = createMemoryRateLimitStore(DEFAULT_LRU_MAX),
  } = options;

  // engine 内部根据数据配置装 keyGenerator —— 业务侧不再传 function
  const keyGenerator = buildKeyGenerator({
    trustProxy,
    userBucket: options.userBucket,
  });

  // 可变 config 包成对象 —— 闭包持有引用，setConfig 改 .max / .windowMs 即刻生效
  const liveConfig = {
    max: options.max ?? 100,
    windowMs: options.windowMs ?? 60_000,
  };

  const middleware = async function rateLimitMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    // bench 模式逃生（仅当 BENCH_DISABLE_RATE_LIMIT=1）—— 优先级高于 skip
    if (isBenchBypassActive()) return next();
    if (shouldSkipRateLimitRequest(req, options)) return next();
    if (skip?.(req)) return next();

    const key = keyGenerator(req);
    let count: number;
    let resetMs: number;
    try {
      ({ count, resetMs } = await store.incr(key, liveConfig.windowMs));
    } catch (err) {
      // 后端出错 → fail-open（不因限流组件挂掉拖垮业务）
      logger.warn('[rate-limit]', 'store.incr 失败，放行本次请求', err);
      return next();
    }

    if (ALWAYS_SEND_HEADERS) {
      res.setHeader('RateLimit-Limit', String(liveConfig.max));
      res.setHeader('RateLimit-Remaining', String(Math.max(0, liveConfig.max - count)));
      res.setHeader('RateLimit-Reset', String(Math.ceil(resetMs / 1000)));
    }

    if (count > liveConfig.max) {
      if (ALWAYS_SEND_HEADERS) res.setHeader('Retry-After', String(Math.ceil(resetMs / 1000)));
      res.status(statusCode);
      if (typeof message === 'string') {
        res.type('text').send(message);
      } else {
        res.json(message);
      }
      return;
    }

    next();
  } as RateLimiterHandle;

  middleware.setConfig = (patch: { max?: number; windowMs?: number }) => {
    if (typeof patch.max === 'number' && patch.max > 0) liveConfig.max = patch.max;
    if (typeof patch.windowMs === 'number' && patch.windowMs > 0) {
      liveConfig.windowMs = patch.windowMs;
    }
    logger.info(
      `[rate-limit] config updated: max=${liveConfig.max}, windowMs=${liveConfig.windowMs}`
    );
  };
  middleware.getConfig = () => ({ ...liveConfig });

  return middleware;
}
