import { randomUUID } from 'node:crypto';
import { Logger } from '../logger/Logger';
import type {
  IsrInvalidationBus,
  IsrInvalidationTarget,
} from '../plugin/isrCacheMiddleware';

export interface RedisInvalidationBusConfig {
  url?: string;
  host?: string;
  port?: number;
  password?: string;
  channel?: string;
  keyPrefix?: string;
  connectTimeout?: number;
  commandTimeout?: number;
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
  private readonly config: RedisInvalidationBusConfig;
  private readonly listeners = new Set<(target: IsrInvalidationTarget) => Promise<void> | void>();
  private publisher: RedisClient | null = null;
  private subscriber: RedisClient | null = null;
  private ready = false;
  private destroyed = false;
  private initPromise: Promise<void>;

  constructor(config: RedisInvalidationBusConfig = {}) {
    this.config = {
      url: config.url ?? process.env.REDIS_URL,
      host: config.host ?? process.env.REDIS_HOST,
      port:
        config.port ?? (process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT, 10) : undefined),
      password: config.password ?? process.env.REDIS_PASSWORD,
      keyPrefix: config.keyPrefix ?? 'isr:',
      channel: config.channel,
      connectTimeout: config.connectTimeout ?? 5_000,
      commandTimeout: config.commandTimeout ?? 3_000,
    };
    this.channel = this.config.channel ?? `${this.config.keyPrefix}invalidate`;
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
    await this.publisher.publish(this.channel, JSON.stringify(message));
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
        this.logger.info('Redis invalidation bus disabled: no REDIS_URL/REDIS_HOST configured');
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

      await Promise.all([this.publisher.connect(), this.subscriber.connect()]);
      await this.subscriber.subscribe(this.channel);
      this.ready = true;
      this.logger.info(`Redis invalidation bus subscribed: ${this.channel}`);
    } catch (err) {
      this.ready = false;
      this.logger.warn(`Redis invalidation bus disabled: ${(err as Error).message}`);
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
