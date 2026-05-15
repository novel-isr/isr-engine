/**
 * 缓存适配器接口
 * 定义缓存后端的统一契约，支持内存/Redis等多种实现
 */

/** 缓存条目元数据 */
export interface CacheEntryMeta {
  /** 创建时间 (ms) */
  createdAt: number;
  /** TTL 秒数，undefined 表示永不过期 */
  ttl?: number;
  /** 过期时间戳 (ms) */
  expiresAt?: number;
  /** 数据大小估算 (bytes) */
  size?: number;
}

/** 缓存条目 */
export interface CacheEntry<T = unknown> {
  value: T;
  meta: CacheEntryMeta;
}

/** 缓存设置选项 */
export interface CacheSetOptions {
  /** TTL 秒数 */
  ttl?: number;
  /** 标签（用于批量失效） */
  tags?: string[];
}

/**
 * 内省（inventory）项 —— 不返回 value 本身，只返回元数据。
 * adapter.inspect() 给 admin inventory 端点用，让它能列出当前后端持有的所有 key。
 */
export interface CacheInspectionItem {
  key: string;
  /** value 序列化后字节数（Redis 的 STRLEN / 内存 JSON.stringify 长度） */
  sizeBytes: number;
  /** 入缓存时间戳，没记录返回 undefined（如 Redis 已存的旧 entry 没含 storedAt） */
  storedAt: number | undefined;
  /** 距硬过期还剩秒数（Redis TTL / 内存 expiresAt-now），无 TTL 返回 undefined */
  ttlSecondsRemaining: number | undefined;
  /** entry 关联的 tags（业务声明）；某些 adapter 不存可返回 [] */
  tags: string[];
}

/**
 * 缓存适配器接口
 * 所有实现必须保证线程安全和异步兼容
 */
export interface ICacheAdapter {
  /** 适配器名称 */
  readonly name: string;

  /** 获取缓存值 */
  get<T = unknown>(key: string): Promise<T | undefined>;

  /** 设置缓存值 */
  set<T = unknown>(key: string, value: T, options?: CacheSetOptions): Promise<void>;

  /** 检查是否存在 */
  has(key: string): Promise<boolean>;

  /** 删除缓存 */
  delete(key: string): Promise<boolean>;

  /** 清空所有缓存 */
  clear(): Promise<void>;

  /** 获取多个缓存值 */
  getMany<T = unknown>(keys: string[]): Promise<Map<string, T | undefined>>;

  /** 设置多个缓存值 */
  setMany<T = unknown>(
    entries: Array<{ key: string; value: T; options?: CacheSetOptions }>
  ): Promise<void>;

  /** 按标签批量失效 */
  invalidateByTag(tag: string): Promise<number>;

  /** 连接状态 */
  isConnected(): boolean;

  /**
   * 列出当前后端持有的 key 元数据 —— 给 inventory admin 端点用。
   *
   * 必须 bounded：实现方负责限制单次返回数量（默认 cap）+ 用 SCAN 类非阻塞游标
   * 而不是 KEYS。Redis 实现遵守 keyPrefix 边界，不扫到别的应用的 key。
   *
   * @param limit 单次返回上限；实现方可以再向下截断。0 / 负数视为默认。
   */
  inspect(limit: number): Promise<CacheInspectionItem[]>;

  /** 销毁适配器，释放资源 */
  destroy(): Promise<void>;
}
