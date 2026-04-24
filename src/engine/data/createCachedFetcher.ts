/**
 * createCachedFetcher —— 通用 TTL + 并发去重数据加载器
 *
 * 设计目标：
 *   - 给 i18n / SEO 这类「url 或本地 json」加载场景一个唯一的成熟实现
 *   - 同 key 的并发请求自动合并为一次（避免缓存击穿）
 *   - 过期后台刷新可选（SWR 模式）
 *
 * 用例：
 *   const loadMessages = createCachedFetcher<IntlPayload>({
 *     key: ({ locale }) => `intl:${locale}`,
 *     ttl: 60_000,
 *     fetch: async ({ locale }) => {
 *       const r = await fetch(`https://cdn.example.com/i18n/${locale}.json`);
 *       return r.json();
 *     },
 *   });
 *
 *   // 在 hook 里用：
 *   loadIntl: (url) => loadMessages({ locale: detectLocale(url) }),
 */
/**
 * 极简 LRU —— 利用 Map 的插入顺序保留特性
 *
 * 不引外部 lru-cache 包是为了规避用户 RSC bundle 的 ESM/CJS interop 抖动
 * （lru-cache@10 双发布在 rolldown 里偶发 default vs 命名导出错位）
 * 本文件用于 i18n / SEO 数据的请求级缓存（典型 < 100 条），简单 Map 完全够用
 */
class TinyLRU<K, V> {
  private store = new Map<K, V>();
  constructor(private max: number) {}
  get(k: K): V | undefined {
    const v = this.store.get(k);
    if (v !== undefined) {
      // 触发 LRU：删后再 set，使其变成最新插入
      this.store.delete(k);
      this.store.set(k, v);
    }
    return v;
  }
  set(k: K, v: V): void {
    if (this.store.has(k)) this.store.delete(k);
    this.store.set(k, v);
    if (this.store.size > this.max) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
  }
}

export interface CachedFetcherOptions<TArg, TValue> {
  /** 从入参生成缓存 key */
  key: (arg: TArg) => string;
  /** 实际加载逻辑（network / fs / dynamic import 都可） */
  fetch: (arg: TArg) => Promise<TValue>;
  /** 缓存 TTL（毫秒），默认 60s */
  ttl?: number;
  /** LRU 容量，默认 500 */
  max?: number;
  /** 启用 stale-while-revalidate：过期仍返回旧值，后台异步刷新（默认 false） */
  swr?: boolean;
  /** 拉取失败时的回退值（如不提供则抛错） */
  fallback?: (arg: TArg, error: unknown) => TValue | Promise<TValue>;
}

interface Entry<T> {
  value: T;
  expiresAt: number;
}

export type CachedFetcher<TArg, TValue> = (arg: TArg) => Promise<TValue>;

export function createCachedFetcher<TArg, TValue>(
  opts: CachedFetcherOptions<TArg, TValue>
): CachedFetcher<TArg, TValue> {
  const ttl = opts.ttl ?? 60_000;
  const max = opts.max ?? 500;
  const cache = new TinyLRU<string, Entry<TValue>>(max);
  const inflight = new Map<string, Promise<TValue>>();

  async function load(arg: TArg): Promise<TValue> {
    try {
      const v = await opts.fetch(arg);
      cache.set(opts.key(arg), { value: v, expiresAt: Date.now() + ttl });
      return v;
    } catch (err) {
      if (opts.fallback) return await opts.fallback(arg, err);
      throw err;
    }
  }

  return async function cachedFetcher(arg: TArg): Promise<TValue> {
    const key = opts.key(arg);
    const entry = cache.get(key);
    const now = Date.now();

    if (entry && entry.expiresAt > now) {
      return entry.value;
    }

    if (entry && opts.swr) {
      // SWR：返回旧值，后台刷新（不阻塞）；如已有 in-flight 则不重复触发
      if (!inflight.has(key)) {
        const p = load(arg).finally(() => inflight.delete(key));
        inflight.set(key, p);
        p.catch(() => {
          /* 后台刷新失败保留旧值 */
        });
      }
      return entry.value;
    }

    // miss 或非 SWR 过期：合并并发到同一个 promise
    const existing = inflight.get(key);
    if (existing) return existing;

    const p = load(arg).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  };
}
