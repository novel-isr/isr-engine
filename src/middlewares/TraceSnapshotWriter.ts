/**
 * 每请求 trace 快照写入 ——
 *
 * 出发点：线上排障最痛的一环是"用户报了一个 bug，说 X 不对"，工程师无从复现。
 * 解决方案：每请求把 RequestContext + 状态码 + 用时 + cache 命中等写到 Redis
 * (key = isr:trace:<traceId>，TTL 1h)，admin dashboard 通过 traceId 拉这条快照
 * 还原现场。
 *
 * 跟 Sentry / Datadog 区别：
 *   - 只存"业务侧关心的请求级元数据"，不存 stack trace / span tree
 *   - 一条 JSON ≈ 1KB，TTL 1h
 *
 * 采样：sampleRate（业务配置）控制普通请求；错误 + `x-debug-trace: 1` 头
 * 始终 100% 采，不受 sampleRate 影响——采样是为了控容量，不是为了丢错误证据。
 *
 * 索引：
 *   - 单条快照：isr:trace:<traceId> = JSON, TTL 1h
 *   - 最近 N 条 traceId 的环形 LIST：isr:trace:recent（LPUSH + LTRIM 200）
 *
 * REDIS_URL 没配 → 写入 no-op，不影响请求路径。
 */
import type { Request, Response, NextFunction } from 'express';
import { logger } from '../logger';
import { getRequestContext } from '../context/RequestContext';

export interface TraceSnapshotWriterOptions {
  redisUrl: string;
  /** 应用名（消费方用 runtime.telemetry.app） */
  appName: string;
  /** 普通请求采样率，0~1。错误和 `x-debug-trace: 1` 头不受此影响（始终 100%）。 */
  sampleRate: number;
}

/**
 * engine 内置常量 —— 不是业务决策：
 *   - TTL 1h：排障辅助 + Redis 内存控制
 *   - 最近索引 200 条：dashboard 翻页够用
 *   - key prefix 'isr:trace:'：engine namespace
 *   - 强制采样头 `x-debug-trace: 1`：跟业界 (Datadog `x-datadog-sampling-priority`,
 *     OTel `sampled` flag) 对齐，便于排障时按需开 single-trace
 */
const TRACE_TTL_MS = 60 * 60 * 1000;
const TRACE_RECENT_MAX = 200;
const TRACE_KEY_PREFIX = 'isr:trace:';
const FORCE_TRACE_HEADER = 'x-debug-trace';

/**
 * 单条快照结构 —— 只放"排障真正用得上的字段"。
 *
 * 砍掉的（之前写过但价值低）：
 *   - tenantId / requestSegment：novel-rating 单租户，永远是 'public'/'default'，纯噪音
 *   - flags / forceMode / forceFallback / bypassCache：dev-only 调试开关，
 *     undefined 时不出现，但类型字段就是噪音
 *
 * 安全策略：
 *   - sessionToken **永不写**（token 泄露 = 账号被盗）
 *   - sessionUser 只展示 displayName / handle 两个字段（PII 脱敏：不写邮箱 / 手机号）
 */
interface TraceSnapshot {
  traceId: string;
  requestId: string;
  app: string;
  method: string;
  path: string;
  query: string;
  status: number;
  durationMs: number;
  startedAt: string;
  context: {
    locale?: string;
    userId?: string;
    sessionUser?: { displayName?: string; handle?: string };
    cookieKeys: string[];
  };
  request: {
    userAgent?: string;
    referer?: string;
    acceptLanguage?: string;
    ip?: string;
  };
  /** 中间件 / handler 抛出的错误信息（如果有） */
  error?: { message: string; stack?: string };
  /** ISR 渲染策略命中（cached / regenerate / static / server / csr-shell） */
  strategy?: string;
  /** ISR cache 命中状态：HIT / MISS / STALE —— engine 内部 plugin/isrCacheMiddleware 写 X-Cache 头 */
  cacheStatus?: string;
}

function summarizeSessionUser(raw: unknown): { displayName?: string; handle?: string } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const u = raw as Record<string, unknown>;
  const out: { displayName?: string; handle?: string } = {};
  if (typeof u.displayName === 'string') out.displayName = u.displayName;
  if (typeof u.handle === 'string') out.handle = u.handle;
  return out.displayName || out.handle ? out : undefined;
}

export interface TraceSnapshotWriter {
  middleware: (req: Request, res: Response, next: NextFunction) => void;
  /** 优雅关闭 */
  close(): Promise<void>;
}

// 简化版 ioredis 接口 —— 只用到 set / lpush / ltrim / pexpire
interface MinimalRedis {
  set(key: string, value: string, exMode?: string, ms?: number): Promise<unknown>;
  pexpire(key: string, ms: number): Promise<number>;
  lpush(key: string, ...values: string[]): Promise<number>;
  ltrim(key: string, start: number, stop: number): Promise<unknown>;
  on(event: 'error', cb: (err: Error) => void): unknown;
  quit(): Promise<unknown>;
}

export async function createTraceSnapshotWriter(
  options: TraceSnapshotWriterOptions
): Promise<TraceSnapshotWriter | null> {
  let client: MinimalRedis;
  try {
    const mod = await import('ioredis');
    const Redis = mod.default;
    client = new Redis(options.redisUrl, {
      maxRetriesPerRequest: 1,
      enableReadyCheck: false,
      lazyConnect: false,
      enableOfflineQueue: false,
    }) as unknown as MinimalRedis;
  } catch (err) {
    logger.warn('[trace-snapshot]', 'redis 初始化失败，跳过快照写入', err);
    return null;
  }

  let warned = false;
  client.on('error', err => {
    if (warned) return;
    warned = true;
    logger.warn('[trace-snapshot]', `Redis 写入失败，trace 快照将丢失：${err.message}`);
  });

  const indexKey = `${TRACE_KEY_PREFIX}recent`;
  // clamp 到 [0, 1]：上层 normalize 已校验，这里防御性兜底，避免 Math.random 比较时
  // sampleRate=NaN/负数/无穷大 触发非预期行为。
  const sampleRate = Math.min(1, Math.max(0, options.sampleRate));

  const middleware = (req: Request, res: Response, next: NextFunction): void => {
    const start = Date.now();
    const forced = req.headers[FORCE_TRACE_HEADER] === '1';

    res.on('finish', () => {
      const ctx = getRequestContext();
      if (!ctx?.traceId) return;

      // 错误 + 强制头：100% 采。其它走 sampleRate 概率采样。
      const isError = res.statusCode >= 400;
      if (!forced && !isError && Math.random() >= sampleRate) return;

      const snapshot: TraceSnapshot = {
        traceId: ctx.traceId,
        requestId: ctx.requestId,
        app: options.appName,
        method: req.method,
        path: req.path,
        query: typeof req.url === 'string' ? (req.url.split('?')[1] ?? '') : '',
        status: res.statusCode,
        durationMs: Date.now() - start,
        startedAt: new Date(start).toISOString(),
        context: {
          locale: typeof ctx['locale'] === 'string' ? (ctx['locale'] as string) : undefined,
          userId: ctx.userId,
          sessionUser: summarizeSessionUser(ctx.sessionUser),
          cookieKeys: Object.keys(ctx.cookies ?? {}),
        },
        request: {
          userAgent:
            typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined,
          referer: typeof req.headers['referer'] === 'string' ? req.headers['referer'] : undefined,
          acceptLanguage:
            typeof req.headers['accept-language'] === 'string'
              ? req.headers['accept-language']
              : undefined,
          ip: req.ip,
        },
        cacheStatus:
          typeof res.getHeader('x-cache') === 'string'
            ? (res.getHeader('x-cache') as string)
            : undefined,
        strategy:
          typeof res.getHeader('x-isr-strategy') === 'string'
            ? (res.getHeader('x-isr-strategy') as string)
            : undefined,
      };

      const key = `${TRACE_KEY_PREFIX}${ctx.traceId}`;
      const json = JSON.stringify(snapshot);

      // fire-and-forget：写失败不影响下次请求；上面 client.on('error') 已经 warn 一次
      Promise.resolve()
        .then(async () => {
          await client.set(key, json, 'PX', TRACE_TTL_MS);
          await client.lpush(indexKey, ctx.traceId);
          await client.ltrim(indexKey, 0, TRACE_RECENT_MAX - 1);
        })
        .catch(() => {
          // 已 warn 过（client.on('error')），不再重复
        });
    });

    next();
  };

  return {
    middleware,
    close: async () => {
      await client.quit().catch(() => {});
    },
  };
}
