/**
 * Rate-limit 配置热更新订阅 ——
 *
 * 监听 admin-server 在 Redis 上发出的 'rate-limit:config:updated' 频道，
 * 拿到 { app, max, windowMs } 后调 RateLimiterHandle.setConfig() 改 in-flight
 * 中间件的 max / windowMs。下一次 store.incr 立即用新值，无需重启。
 *
 * 跟 Linkerd / envoy / Cloudflare Workers KV 的 dynamic config 模式一致：
 * 控制面（admin） + 数据面（engine）通过 Redis pub/sub 解耦。
 *
 * 启动时也会主动 GET `rate-limit:config:<appName>` 一次（快照），保证 pod 重启
 * 后能拿到最新配置；不依赖在线时 publish 才生效。
 *
 * 不强制：REDIS_URL 没配 / Redis 连不上 → 静默退化为 ssr.config.ts 静态配置。
 */
import type IORedis from 'ioredis';
import { logger } from '../logger';
import type { RateLimiterHandle } from './RateLimiter';

const CONFIG_KEY_PREFIX = 'rate-limit:config:';
const UPDATE_CHANNEL = 'rate-limit:config:updated';

export interface RateLimitConfigSubscriberOptions {
  /** 这个 app 在 Redis 里的标识，跟 admin 控制台 PATCH /config body 的 app 字段一致 */
  appName: string;
  /** 已经 use 进 express 的 RateLimiter handle（要支持 setConfig） */
  handle: RateLimiterHandle;
  /**
   * Redis 连接 URL —— 走独立 ioredis 实例，不复用 rate-limit store 的那个
   * （subscribe 模式下 ioredis 实例不能再发普通命令，要单独连）。
   */
  redisUrl: string;
}

export interface RateLimitConfigSubscriberHandle {
  /** 关闭订阅 + 断开 Redis 连接 */
  close(): Promise<void>;
  /** 主动重新从 Redis 拉一次快照（startup / 故障恢复用） */
  refresh(): Promise<void>;
}

export async function startRateLimitConfigSubscriber(
  options: RateLimitConfigSubscriberOptions
): Promise<RateLimitConfigSubscriberHandle | null> {
  const { Redis } = await import('ioredis');
  const sub: IORedis = new Redis(options.redisUrl, {
    maxRetriesPerRequest: 1,
    enableReadyCheck: false,
    lazyConnect: true,
  });
  const cmd: IORedis = new Redis(options.redisUrl, {
    maxRetriesPerRequest: 1,
    enableReadyCheck: false,
    lazyConnect: true,
  });

  sub.on('error', err => {
    logger.warn('[rate-limit-config]', 'subscriber redis error', err.message);
  });
  cmd.on('error', err => {
    logger.warn('[rate-limit-config]', 'cmd redis error', err.message);
  });

  try {
    await Promise.all([sub.connect(), cmd.connect()]);
  } catch (err) {
    logger.warn(
      '[rate-limit-config]',
      'redis connect failed; 跳过热更新订阅，沿用 ssr.config 静态配置',
      err
    );
    await sub.quit().catch(() => {});
    await cmd.quit().catch(() => {});
    return null;
  }

  const applyMessage = (raw: string): void => {
    let parsed: { app?: string; max?: number; windowMs?: number; cleared?: boolean };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!parsed.app || parsed.app !== options.appName) return;
    if (parsed.cleared) {
      logger.info(
        '[rate-limit-config]',
        `'${options.appName}' 配置被清除，回退 ssr.config 默认（注：默认值留在原 closure 里，cleared 不会复原 —— 重启 pod 才取静态默认）`
      );
      return;
    }
    options.handle.setConfig({
      max: parsed.max,
      windowMs: parsed.windowMs,
    });
  };

  sub.on('message', (_channel, message) => {
    applyMessage(message);
  });
  await sub.subscribe(UPDATE_CHANNEL);
  logger.info(
    `[rate-limit-config] 订阅 '${UPDATE_CHANNEL}' 频道，监听 app='${options.appName}' 的 hot-reload`
  );

  const refresh = async (): Promise<void> => {
    try {
      const raw = await cmd.get(`${CONFIG_KEY_PREFIX}${options.appName}`);
      if (!raw) return;
      applyMessage(raw);
    } catch (err) {
      logger.warn('[rate-limit-config]', 'refresh 失败', err);
    }
  };

  // 启动时主动拉一次快照 —— pod 重启后立刻拿到最新配置
  await refresh();

  return {
    close: async () => {
      await sub.unsubscribe(UPDATE_CHANNEL).catch(() => {});
      await sub.quit().catch(() => {});
      await cmd.quit().catch(() => {});
    },
    refresh,
  };
}
