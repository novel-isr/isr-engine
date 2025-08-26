/**
 * ISR 引擎类型定义
 * 企业级渲染模式和自动降级链
 */

// 渲染模式类型定义
export type RenderModeType = 'ssg' | 'isr';
export type InternalStrategyType =
  | 'static'
  | 'cached'
  | 'regenerate'
  | 'server'
  | 'client';
export type CacheStrategyType = 'no-cache' | 'memory' | 'redis' | 'filesystem';

// 公共 API - 只向用户暴露这两种模式
export const RenderModes = {
  SSG: 'ssg' as const, // 静态站点生成 - 构建时
  ISR: 'isr' as const, // 增量静态再生 - 运行时带降级
} as const;

// 内部渲染策略 (不向用户暴露)
export const InternalStrategies = {
  STATIC: 'static' as const, // 服务预构建文件
  CACHED: 'cached' as const, // 从 ISR 缓存服务
  REGENERATE: 'regenerate' as const, // ISR 重新生成
  SERVER: 'server' as const, // SSR 降级
  CLIENT: 'client' as const, // CSR 降级
} as const;

// 缓存策略
export const CacheStrategies = {
  NO_CACHE: 'no-cache' as const,
  MEMORY: 'memory' as const,
  REDIS: 'redis' as const,
  FILE_SYSTEM: 'filesystem' as const,
} as const;

// ISR 自动降级链
export const FallbackChain: Record<string, InternalStrategyType[]> = {
  isr: ['cached', 'regenerate', 'server', 'client'],
  ssg: ['static', 'client'],
};

// 配置接口定义
export interface ServerConfig {
  port?: number;
  host?: string;
}

export interface ISRConfig {
  revalidate?: number;
  backgroundRevalidation?: boolean;
}

export interface CacheConfig {
  strategy?: CacheStrategyType;
  ttl?: number;
}

export interface SEOConfig {
  enabled?: boolean;
  generateSitemap?: boolean;
  generateRobots?: boolean;
  baseUrl?: string;
}

export interface DevConfig {
  verbose?: boolean;
  hmr?: boolean;
}

// 路径配置接口
export interface PathsConfig {
  dist?: string;
  server?: string;
  client?: string;
  static?: string;
}

// 错误处理配置接口
export interface ErrorHandlingConfig {
  enableFallback?: boolean;
  logErrors?: boolean;
  customErrorPage?: string;
}

// 渲染结果接口
export interface RenderResult {
  success: boolean;
  html: string;
  helmet?: any;
  preloadLinks?: string;
  statusCode: number;
  meta: RenderMeta;
}

// 渲染元数据接口
export interface RenderMeta {
  renderMode: string;
  timestamp: number;
  strategy?: string;
  fallbackUsed?: boolean;
  skipCache?: boolean;
  fromCache?: boolean;
  error?: boolean | string;
  fallback?: boolean;
  [key: string]: any;
}

// 缓存项接口
export interface CacheItem {
  key: string;
  value: any;
  size: number;
  createdAt: number;
  expiresAt: number | null;
  accessCount: number;
}

// 缓存统计接口
export interface CacheStats {
  hits: number;
  misses: number;
  sets: number;
  deletes: number;
  evictions: number;
  hitRate: string;
  strategy: string;
  size: number | string;
}

// 渲染上下文接口
export interface RenderContext {
  userAgent?: string;
  acceptLanguage?: string;
  referer?: string;
  bypassCache?: boolean;
  viteHMR?: boolean;
  manifest?: any;
  [key: string]: any;
}

// 企业级配置接口
export interface EnterpriseConfigOptions {
  mode?: RenderModeType;
  routes?: Record<string, RenderModeType>;
  port?: number;
  host?: string;
  compression?: boolean;
  cors?: boolean;
  revalidate?: number;
  backgroundRevalidation?: boolean;
  maxAge?: number;
  cacheStrategy?: CacheStrategyType;
  cacheTtl?: number;
  maxCacheSize?: number;
  distPath?: string;
  serverPath?: string;
  staticPath?: string;
  publicPath?: string;
  seo?: boolean;
  generateSitemap?: boolean;
  generateRobots?: boolean;
  baseUrl?: string;
  verbose?: boolean;
  hmr?: boolean;
  logErrors?: boolean;
  monitoring?: boolean;
  analytics?: boolean;
  loadBalancing?: boolean;
}

// 主配置接口
export interface NovelISRConfig {
  mode?: RenderModeType;
  routes?: Record<string, RenderModeType>;
  server?: ServerConfig;
  isr?: ISRConfig;
  cache?: CacheConfig;
  seo?: SEOConfig;
  dev?: DevConfig;
  paths?: PathsConfig;
  errorHandling?: ErrorHandlingConfig;
  // 兼容性属性
  compression?: boolean;
  verbose?: boolean;
}

// 兼容旧接口
export interface NovelSSRConfig extends NovelISRConfig {}
