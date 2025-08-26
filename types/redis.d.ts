// Redis 类型声明 - 用于可选依赖
declare module 'redis' {
  export interface RedisClientType {
    connect(): Promise<void>;
    get(key: string): Promise<string | null>;
    set(key: string, value: string, options?: { EX?: number }): Promise<void>;
    del(key: string): Promise<number>;
    flushAll(): Promise<void>;
    quit(): Promise<void>;
  }

  export function createClient(options?: any): RedisClientType;
}
