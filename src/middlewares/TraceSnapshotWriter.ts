/**
 * 每请求 trace 快照写入 ——
 *
 * 出发点：线上排障最痛的一环是"用户报了一个 bug，说 X 不对"，工程师无从复现。
 * 解决方案：每请求把 RequestContext + 协商出的 locale / theme / cache 命中 + 状态码 +
 * 用时写到 Redis（key = trace:<traceId>，TTL 1h），admin dashboard 通过 traceId
 * 拉这条快照，5 分钟内还原现场。
 *
 * 跟 Sentry / Datadog / Honeycomb 区别：
 *   - 这里只存"业务侧关心的请求级元数据"，不存 stack trace / span tree，量级不一样
 *   - 一个请求一条 JSON ≈ 1KB，1h TTL 默认采样 5% + 错误强制 100%；
 *     生产 1 万 QPS × 5% × 1h = 1.8M 条 ≈ 2GB Redis（开销可忽略）
 *
 * 采样策略：
 *   1. 错误（status >= 500 或抛异常） → 强制采样
 *   2. 请求头 x-debug-trace: 1 → 强制采样（QA / 排障人员明确请求时）
 *   3. 否则按 sampleRate 概率采样（默认 0.05 = 5%）
 *
 * 索引：
 *   - 单条快照：trace:<traceId> = JSON, TTL 1h
 *   - 最近 N 条 traceId 的环形列表：trace:recent (LIST, LPUSH + LTRIM 200)
 *     —— admin dashboard 的"最近请求"面板用这个；不带索引就只能凭 traceId 查
 *
 * 跟 ssr.config 静态配置同样的"消费方什么都不需要写"原则：
 *   - REDIS_URL 没配 → 写入 no-op，不影响请求路径
 *   - sampleRate 默认 0.05；要全采样设 1.0；要关闭设 0
 */
import type { Request, Response, NextFunction } from 'express';
import { logger } from '../logger';
import { getRequestContext } from '../context/RequestContext';

export interface TraceSnapshotWriterOptions {
  redisUrl: string;
  /** 应用名，写到快照里方便多 app 共享 Redis 时区分 */
  appName: string;
  /** 0..1，默认 0.05；错误强制 1.0 */
  sampleRate: number;
  /** 单条快照 TTL（毫秒），默认 1h */
  ttlMs: number;
  /** 最近 N 条 traceId 索引上限，默认 200 */
  recentMax: number;
  /** Redis key 前缀；默认 'isr:trace:' */
  keyPrefix: string;
}

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
    theme?: string;
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

const ALWAYS_DEBUG_HEADER = 'x-debug-trace';

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

  const indexKey = `${options.keyPrefix}recent`;

  const middleware = (req: Request, res: Response, next: NextFunction): void => {
    const start = Date.now();
    const debugForced = req.headers[ALWAYS_DEBUG_HEADER] === '1';

    res.on('finish', () => {
      // 决定要不要采样
      const status = res.statusCode;
      const isError = status >= 500;
      const sampled =
        isError || debugForced || (options.sampleRate > 0 && Math.random() < options.sampleRate);
      if (!sampled) return;

      const ctx = getRequestContext();
      if (!ctx?.traceId) return;

      const snapshot: TraceSnapshot = {
        traceId: ctx.traceId,
        requestId: ctx.requestId,
        app: options.appName,
        method: req.method,
        path: req.path,
        query: typeof req.url === 'string' ? (req.url.split('?')[1] ?? '') : '',
        status,
        durationMs: Date.now() - start,
        startedAt: new Date(start).toISOString(),
        context: {
          locale: typeof ctx['locale'] === 'string' ? (ctx['locale'] as string) : undefined,
          theme: typeof ctx['theme'] === 'string' ? (ctx['theme'] as string) : undefined,
          userId: ctx.userId,
          sessionUser: summarizeSessionUser(ctx.sessionUser),
          cookieKeys: Object.keys(ctx.cookies ?? {}),
        },
        request: {
          userAgent:
            typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined,
          referer: ctx.referer,
          acceptLanguage: ctx.acceptLanguage,
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

      const key = `${options.keyPrefix}${ctx.traceId}`;
      const json = JSON.stringify(snapshot);

      // fire-and-forget：写失败不影响下次请求；上面 client.on('error') 已经 warn 一次
      Promise.resolve()
        .then(async () => {
          await client.set(key, json, 'PX', options.ttlMs);
          await client.lpush(indexKey, ctx.traceId);
          await client.ltrim(indexKey, 0, options.recentMax - 1);
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
