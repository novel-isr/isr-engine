import { randomUUID } from 'node:crypto';
import { Logger } from '../logger/Logger';
import type { IsrInvalidationBus, IsrInvalidationTarget } from '../plugin/isrCacheMiddleware';

export interface RedisInvalidationBusConfig {
  url?: string;
  host?: string;
  port?: number;
  password?: string;
  channel?: string;
  keyPrefix?: string;
  connectTimeout?: number;
  commandTimeout?: number;
  /**
   * 消息重放窗口（毫秒），默认 5 分钟。
   * Pub/Sub 是 fire-and-forget —— 若 subscriber 在 publish 的瞬间断连，消息会永久丢失。
   * 引入 Sorted Set replay log：
   *   - publish 时同时 ZADD（score = timestamp）到 `<channel>:log`
   *   - subscriber 在 (re)subscribe 后 ZRANGEBYSCORE `(lastSeen, now]` 拉回错过的消息
   * 设 0 关闭该补偿（回到纯 Pub/Sub 行为）。
   */
  replayWindowMs?: number;
  /** 重放日志条目总数上限，防止无限增长。默认 5000。 */
  replayLogMaxEntries?: number;
}

interface InvalidationMessage {
  origin: string;
  target: IsrInvalidationTarget;
  sentAt: number;
}

type RedisClient = import('ioredis').default;
type RedisCtor = new (...args: unknown[]) => RedisClient;

export class RedisInvalidationBus implements IsrInvalidationBus {
  private readonly logger = Logger.getInstance();
  private readonly origin = randomUUID();
  private readonly channel: string;
  private readonly logKey: string;
  private readonly replayWindowMs: number;
  private readonly replayLogMaxEntries: number;
  private readonly config: RedisInvalidationBusConfig;
  private readonly listeners = new Set<(target: IsrInvalidationTarget) => Promise<void> | void>();
  private publisher: RedisClient | null = null;
  private subscriber: RedisClient | null = null;
  private ready = false;
  private destroyed = false;
  private initPromise: Promise<void>;
  /** 本实例已处理到的消息 sentAt 时间戳，用于 (re)subscribe 后 ZRANGEBYSCORE 补消息 */
  private lastSeenSentAt = 0;

  constructor(config: RedisInvalidationBusConfig = {}) {
    this.config = {
      url: config.url,
      host: config.host,
      port: config.port,
      password: config.password,
      keyPrefix: config.keyPrefix ?? 'isr:',
      channel: config.channel,
      connectTimeout: config.connectTimeout ?? 5_000,
      commandTimeout: config.commandTimeout ?? 3_000,
      replayWindowMs: config.replayWindowMs ?? 5 * 60_000,
      replayLogMaxEntries: config.replayLogMaxEntries ?? 5000,
    };
    this.channel = this.config.channel ?? `${this.config.keyPrefix}invalidate`;
    this.logKey = `${this.channel}:log`;
    this.replayWindowMs = this.config.replayWindowMs ?? 5 * 60_000;
    this.replayLogMaxEntries = this.config.replayLogMaxEntries ?? 5000;
    // 初始化时先假设只看新消息 —— 避免首次启动把历史 5 分钟全回放
    this.lastSeenSentAt = Date.now();
    this.initPromise = this.init();
  }

  async publish(target: IsrInvalidationTarget): Promise<void> {
    await this.initPromise;
    if (!this.ready || !this.publisher || this.destroyed) {
      this.logger.warn(`Redis invalidation publish skipped (${target.kind}:${target.value})`);
      return;
    }

    const message: InvalidationMessage = {
      origin: this.origin,
      target,
      sentAt: Date.now(),
    };
    const payload = JSON.stringify(message);
    if (this.replayWindowMs > 0) {
      // 先写日志（pub/sub 订阅者错过时可回放），再 publish 主通道。
      // 顺序不可反：若先 publish、后写 log，在线订阅者处理完消息后如果又因断连触发重放扫描，
      // 会把刚处理过的消息再处理一次（幂等原则上支持，但浪费）。
      const pipeline = this.publisher.pipeline();
      pipeline.zadd(this.logKey, message.sentAt, payload);
      // 维护日志大小上限：按 rank 裁掉最老条目，留最新 replayLogMaxEntries 条
      pipeline.zremrangebyrank(this.logKey, 0, -this.replayLogMaxEntries - 1);
      // 给日志 key 加一个 TTL，超过窗口 2 倍就完全清掉（兜底，避免无流量实例留下孤儿 key）
      pipeline.pexpire(this.logKey, this.replayWindowMs * 2);
      pipeline.publish(this.channel, payload);
      await pipeline.exec();
    } else {
      await this.publisher.publish(this.channel, payload);
    }
  }

  subscribe(listener: (target: IsrInvalidationTarget) => Promise<void> | void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    this.listeners.clear();
    await Promise.allSettled([this.publisher?.quit(), this.subscriber?.quit()]);
    this.publisher = null;
    this.subscriber = null;
    this.ready = false;
  }

  private async init(): Promise<void> {
    try {
      const Redis = await this.loadRedisModule();
      if (!Redis) {
        this.logger.warn('Redis invalidation bus disabled: ioredis module unavailable');
        return;
      }
      if (!this.config.url && !this.config.host) {
        this.logger.info(
          'Redis invalidation bus disabled: runtime.redis.url/host is not configured'
        );
        return;
      }

      this.publisher = this.createClient(Redis);
      this.subscriber = this.createClient(Redis);

      this.subscriber.on('message', (_channel, raw) => {
        void this.handleMessage(raw);
      });
      this.subscriber.on('error', err => {
        this.ready = false;
        this.logger.warn(`Redis invalidation subscriber error: ${err.message}`);
      });
      this.publisher.on('error', err => {
        this.ready = false;
        this.logger.warn(`Redis invalidation publisher error: ${err.message}`);
      });
      // 重连后 ioredis 自动重放 SUBSCRIBE，但期间 pub 出去的消息已丢失 →
      // 进入 ready 态时主动 ZRANGEBYSCORE 拉补 replayWindowMs 内错过的消息
      this.subscriber.on('ready', () => {
        void this.replayMissed();
      });

      await Promise.all([this.publisher.connect(), this.subscriber.connect()]);
      await this.subscriber.subscribe(this.channel);
      this.ready = true;
      this.logger.info(`Redis invalidation bus subscribed: ${this.channel}`);
      // 首次连接也触发一次 replay（捕获进程启动前极短窗口内其他 pod 发来的失效）
      await this.replayMissed();
    } catch (err) {
      this.ready = false;
      this.logger.warn(`Redis invalidation bus disabled: ${(err as Error).message}`);
    }
  }

  /**
   * 从 Sorted Set 日志拉取本实例错过的消息并按顺序分发。
   * 以 `lastSeenSentAt` 做水位线，回放后推进水位，避免无限重放同一批。
   */
  private async replayMissed(): Promise<void> {
    if (this.replayWindowMs <= 0 || !this.publisher || this.destroyed) return;
    try {
      // 用 publisher client 做 ZRANGEBYSCORE（subscriber 处于 subscribe 模式只能收 Pub/Sub 命令）
      const minScore = `(${this.lastSeenSentAt}`; // exclusive
      const maxScore = String(Date.now());
      const raws = await this.publisher.zrangebyscore(this.logKey, minScore, maxScore);
      if (raws.length === 0) return;
      this.logger.info(
        `Redis invalidation replay: ${raws.length} message(s) missed since ${new Date(this.lastSeenSentAt).toISOString()}`
      );
      for (const raw of raws) {
        await this.handleMessage(raw);
      }
    } catch (err) {
      this.logger.warn(`Redis invalidation replay failed: ${(err as Error).message}`);
    }
  }

  private createClient(Redis: RedisCtor): RedisClient {
    const options: import('ioredis').RedisOptions = {
      ...(this.config.host ? { host: this.config.host } : {}),
      ...(this.config.port ? { port: this.config.port } : {}),
      password: this.config.password,
      connectTimeout: this.config.connectTimeout,
      commandTimeout: this.config.commandTimeout,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy: times => Math.min(times * 250, 2_000),
    };
    return this.config.url ? new Redis(this.config.url, options) : new Redis(options);
  }

  private async loadRedisModule(): Promise<RedisCtor | null> {
    try {
      const mod = await import('ioredis');
      return mod.default || (mod as unknown as RedisCtor);
    } catch {
      return null;
    }
  }

  private async handleMessage(raw: string): Promise<void> {
    const message = this.parseMessage(raw);
    if (!message || message.origin === this.origin) {
      return;
    }
    // 水位只前进、不后退 —— 乱序消息（极少见）按到达顺序处理，不重置水位
    if (message.sentAt > this.lastSeenSentAt) {
      this.lastSeenSentAt = message.sentAt;
    }

    for (const listener of Array.from(this.listeners)) {
      try {
        await listener(message.target);
      } catch (err) {
        this.logger.warn(
          `Redis invalidation listener failed (${message.target.kind}:${message.target.value}): ${(err as Error).message}`
        );
      }
    }
  }

  private parseMessage(raw: string): InvalidationMessage | null {
    try {
      const parsed = JSON.parse(raw) as Partial<InvalidationMessage>;
      if (
        typeof parsed.origin !== 'string' ||
        !parsed.target ||
        (parsed.target.kind !== 'path' && parsed.target.kind !== 'tag') ||
        typeof parsed.target.value !== 'string'
      ) {
        return null;
      }
      return {
        origin: parsed.origin,
        target: parsed.target,
        sentAt: typeof parsed.sentAt === 'number' ? parsed.sentAt : Date.now(),
      };
    } catch {
      return null;
    }
  }
}
