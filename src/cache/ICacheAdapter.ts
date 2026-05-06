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

  /** 销毁适配器，释放资源 */
  destroy(): Promise<void>;
}
