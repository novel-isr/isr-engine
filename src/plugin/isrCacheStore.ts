/**
 * IsrCacheStore —— ISR HTTP 响应缓存的存储抽象（同步读 + 异步写穿）
 *
 * 设计取舍（成熟工业模式 —— 类比 Cloudflare / Fastly 的 tier-0/tier-1 双层）：
 *   - 读路径必须**同步**：在 connect 中间件里 sync 命中是 < 1ms 的关键
 *   - 写路径可以**异步**：fire-and-forget 写到 Redis，不阻塞响应
 *   - L1（LRU 内存）始终在 → 重启清零；L2（Redis）可选 → 跨 pod / 重启持久
 *
 * 单层 LRU：MemoryCacheStore（默认，无依赖）
 * 双层：    HybridCacheStore = MemoryCacheStore + 写穿 RedisCacheAdapter
 */
import { LRUCache } from 'lru-cache';
import type { ICacheAdapter } from '../cache/ICacheAdapter';

/** 单条 ISR 缓存条目 —— 与 isrCacheMiddleware 内部结构对齐 */
export interface IsrCachedEntry {
  body: Buffer;
  statusCode: number;
  headers: Record<string, string | number | string[]>;
  contentType: string;
  storedAt: number;
  expiresAt: number;
  hardExpiresAt: number;
  tags: string[];
}

/**
 * Inventory 端点用的 L2 视图项（不含 body）。
 * Hybrid 模式下，inventory 把 L2（Redis）SCAN 出来的 key 也合并进来，
 * 让 SRE 在 prod 不需要 redis-cli 也能看全集群缓存内容。
 *
 * Redis 不存 storedAt / expiresAt / hardExpiresAt 元数据（cache 中间件序列化前剥掉了 storedAt
 * 之外的精确时间戳，且 RedisCacheAdapter 自己也只存 value 的 base64 + TTL），
 * 所以 L2 entry 只暴露 ttlSecondsRemaining 这种从 Redis 直接拿到的客观信息。
 */
export interface IsrL2InspectionItem {
  key: string;
  sizeBytes: number;
  /** Redis TTL 剩余秒数；-1（永不过期）已被映射成 undefined */
  ttlSecondsRemaining: number | undefined;
}

export interface IsrCacheStore {
  readonly backend: 'memory' | 'hybrid';
  /** 同步读 —— 必须 O(1)，不可阻塞 */
  get(key: string): IsrCachedEntry | undefined;
  /** 异步读 —— L2/远端回源时使用；默认实现可直接包装同步 get */
  getAsync?(key: string): Promise<IsrCachedEntry | undefined>;
  /** 同步写 L1 + 异步写穿 L2（如有）*/
  set(key: string, entry: IsrCachedEntry): void;
  /** 同步删除 L1 + 异步删除 L2（如有）；返回是否命中 L1 */
  delete(key: string): boolean;
  /** 清空（同步 L1 + 异步 L2）*/
  clear(): void;
  /** L1 中遍历 —— 用于 tag 失效与内部测试/诊断 */
  entries(): IterableIterator<[string, IsrCachedEntry]>;
  keys(): IterableIterator<string>;
  size: number;
  max: number;
  /**
   * Inventory 端点用：列出 L2（Redis）当前持有的 key 元数据（不含 body）。
   * 单层 memory store 没有 L2，返回空数组。
   * Hybrid store 用 RedisCacheAdapter.inspect()（SCAN 非阻塞 + 总量上限）。
   */
  inspectL2(limit: number): Promise<IsrL2InspectionItem[]>;
  /** 关闭：用于 graceful shutdown 释放 redis 连接 */
  destroy(): Promise<void>;
}

// ─── 默认实现：单层 LRU（行为与改造前一致） ───

export function createMemoryCacheStore(opts: { max?: number } = {}): IsrCacheStore {
  const lru = new LRUCache<string, IsrCachedEntry>({ max: opts.max ?? 1000 });
  return {
    backend: 'memory',
    get: k => lru.get(k),
    getAsync: async k => lru.get(k),
    set: (k, v) => {
      lru.set(k, v);
    },
    delete: k => lru.delete(k),
    clear: () => lru.clear(),
    entries: () => lru.entries(),
    keys: () => lru.keys(),
    get size() {
      return lru.size;
    },
    get max() {
      return lru.max;
    },
    // memory 单层无 L2，inventory 端点会自动跳过 L2 视图
    async inspectL2() {
      return [];
    },
    async destroy() {
      lru.clear();
    },
  };
}

// ─── 双层：L1 LRU + L2 Redis（write-through + read-through）───

export interface HybridCacheStoreOptions {
  max?: number;
  /** 已经初始化好的 Redis 适配器（用户自己 new 出来传入；engine 不强依赖 ioredis） */
  redis: ICacheAdapter;
  /** Redis 读写失败的回调（默认 console.warn）*/
  onRedisError?: (err: unknown, op: 'get' | 'set' | 'delete' | 'clear', key?: string) => void;
  /** 用于 Redis key 命名空间隔离，默认 'isr:resp:' */
  redisKeyPrefix?: string;
  /** 写穿 Redis 时的 TTL（秒）；默认从 entry.hardExpiresAt 推算 */
  redisTtlSeconds?: number;
}

interface SerializedEntry {
  body: string; // base64
  statusCode: number;
  headers: Record<string, string | number | string[]>;
  contentType: string;
  storedAt: number;
  expiresAt: number;
  hardExpiresAt: number;
  tags: string[];
}

function serialize(e: IsrCachedEntry): SerializedEntry {
  return { ...e, body: e.body.toString('base64') };
}

function deserialize(value: SerializedEntry | undefined): IsrCachedEntry | undefined {
  if (!value || typeof value.body !== 'string') {
    return undefined;
  }

  return {
    body: Buffer.from(value.body, 'base64'),
    statusCode: value.statusCode,
    headers: value.headers,
    contentType: value.contentType,
    storedAt: value.storedAt,
    expiresAt: value.expiresAt,
    hardExpiresAt: value.hardExpiresAt,
    tags: Array.isArray(value.tags) ? value.tags : [],
  };
}

export function createHybridCacheStore(opts: HybridCacheStoreOptions): IsrCacheStore {
  const lru = new LRUCache<string, IsrCachedEntry>({ max: opts.max ?? 1000 });
  const pendingReads = new Map<string, Promise<IsrCachedEntry | undefined>>();
  const onErr =
    opts.onRedisError ??
    ((err, op, key) => {
      console.warn(`[isr-cache:redis] ${op} failed`, key ?? '', err);
    });
  const prefix = opts.redisKeyPrefix ?? 'isr:resp:';
  const rkey = (k: string) => prefix + k;

  // 异步反射：set / delete / clear 都不阻塞调用者
  function writeThrough(key: string, entry: IsrCachedEntry): void {
    const ttl =
      opts.redisTtlSeconds ?? Math.max(1, Math.ceil((entry.hardExpiresAt - Date.now()) / 1000));
    void opts.redis
      .set(rkey(key), serialize(entry), { ttl, tags: entry.tags })
      .catch(err => onErr(err, 'set', key));
  }

  return {
    backend: 'hybrid',
    get: k => lru.get(k),
    async inspectL2(limit: number) {
      // adapter.inspect 已经做了 keyPrefix 边界保护 + SCAN 非阻塞 + 总量上限。
      // 这里再 strip 上层 prefix（'isr:resp:'）让 inventory 端点看到的 key 与 L1 同形态对齐。
      const items = await opts.redis.inspect(limit);
      return items.map(item => ({
        key: item.key.startsWith(prefix) ? item.key.slice(prefix.length) : item.key,
        sizeBytes: item.sizeBytes,
        ttlSecondsRemaining: item.ttlSecondsRemaining,
      }));
    },
    getAsync: async k => {
      const l1 = lru.get(k);
      if (l1) {
        return l1;
      }

      const pending = pendingReads.get(k);
      if (pending) {
        return pending;
      }

      const readPromise = opts.redis
        .get<SerializedEntry>(rkey(k))
        .then(serialized => {
          const entry = deserialize(serialized);
          if (!entry) {
            return undefined;
          }

          if (Date.now() >= entry.hardExpiresAt) {
            void opts.redis.delete(rkey(k)).catch(err => onErr(err, 'delete', k));
            return undefined;
          }

          lru.set(k, entry);
          return entry;
        })
        .catch(err => {
          onErr(err, 'get', k);
          return undefined;
        })
        .finally(() => {
          pendingReads.delete(k);
        });

      pendingReads.set(k, readPromise);
      return readPromise;
    },
    set: (k, v) => {
      lru.set(k, v);
      writeThrough(k, v);
    },
    delete: k => {
      pendingReads.delete(k);
      const hit = lru.delete(k);
      void opts.redis.delete(rkey(k)).catch(err => onErr(err, 'delete', k));
      return hit;
    },
    clear: () => {
      pendingReads.clear();
      lru.clear();
      void opts.redis.clear().catch(err => onErr(err, 'clear'));
    },
    entries: () => lru.entries(),
    keys: () => lru.keys(),
    get size() {
      return lru.size;
    },
    get max() {
      return lru.max;
    },
    async destroy() {
      pendingReads.clear();
      lru.clear();
      await opts.redis.destroy();
    },
  };
}
