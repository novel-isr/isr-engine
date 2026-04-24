/**
 * 轻量级 LRU (Least Recently Used) 缓存实现
 * 用于 Node.js 层面管理高频访问的元数据，避免内存无限增长
 */
export class LRUCache<K, V> {
  private capacity: number;
  private cache: Map<K, V>;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.cache = new Map();
  }

  /**
   * 获取缓存值
   * 如果存在，将其移动到最近使用位置
   */
  get(key: K): V | undefined {
    if (!this.cache.has(key)) {
      return undefined;
    }
    // 刷新位置：先删除再重新插入
    const value = this.cache.get(key);
    if (value !== undefined) {
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  /**
   * 设置缓存值
   * 如果超出容量，删除最久未使用的项
   */
  set(key: K, value: V): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.capacity) {
      // Map 的 keys() 返回迭代器，第一个就是最久未使用的（插入顺序）
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }
    this.cache.set(key, value);
  }

  /**
   * 检查是否存在
   */
  has(key: K): boolean {
    return this.cache.has(key);
  }

  /**
   * 删除指定项
   */
  delete(key: K): void {
    this.cache.delete(key);
  }

  /**
   * 清空缓存
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * 获取当前大小
   */
  size(): number {
    return this.cache.size;
  }

  /**
   * 返回所有 key 的迭代器（按最久→最近使用顺序）
   * 用于 tag 粒度失效等场景的全表扫描
   */
  keys(): IterableIterator<K> {
    return this.cache.keys();
  }

  /**
   * 返回所有 [key, value] 条目的迭代器
   */
  entries(): IterableIterator<[K, V]> {
    return this.cache.entries();
  }
}
