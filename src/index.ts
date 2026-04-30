/**
 * Novel ISR Engine —— 公开入口
 *
 * 定位：ISR / SSG / Fallback / Route / Metrics 编排层 —— 构建于 `@vitejs/plugin-rsc` 之上
 *
 * 分工：
 *   - `@vitejs/plugin-rsc`（官方）：Flight 协议 / 三环境编译 / client & server reference /
 *     Server Actions / CSS 侧效
 *   - isr-engine（本包）：ISR 缓存（内存 LRU + SWR）/ 按路由 TTL / revalidatePath|Tag /
 *     cacheTag / SSG 爬虫 / Fallback Chain 决策 / 路由发现 / 指标 / 中间件 / CLI
 *
 * @version 2.0.0
 */

// ========== 应用入口 ==========
export { createISRApp } from './app/createISRApp';

// ========== 配置 ==========
export { loadConfig } from './config/loadConfig';
export { getEnv } from './config/getEnv';
export { isDev, isProd } from './config/getStatus';

// ========== 服务管理 ==========
export { startAppServer, shutdownServer } from './server/manager';

// ========== Manifest ==========
export { ManifestLoader } from './manifest/ManifestLoader';

// ========== 请求上下文 ==========
export { requestContext, getRequestContext } from './context/RequestContext';

// ========== 类型 ==========
export * from './types/index';

// ========== ISR 引擎（唯一持久对象） ==========
export { default as ISREngine } from './engine/ISREngine';

// ========== 渲染模式 / 路由工具 ==========
export {
  getFallbackChain,
  resolveRenderMode,
  matchRoutePattern,
  getRouteFallbackChain,
} from './engine/RenderMode';
export { RouteManager } from './route/RouteManager';

// ========== 缓存 ==========
export { CacheManager } from './cache';
export { RedisCacheAdapter } from './cache/RedisCacheAdapter';
export { RedisInvalidationBus } from './cache/RedisInvalidationBus';
export type { ICacheAdapter, CacheSetOptions } from './cache/ICacheAdapter';
export type { RedisInvalidationBusConfig } from './cache/RedisInvalidationBus';

// ========== ISR HTTP 缓存 store（L1 内存 / L1+L2 Redis 双层） ==========
export {
  createMemoryCacheStore,
  createHybridCacheStore,
  type IsrCacheStore,
  type IsrCachedEntry,
  type HybridCacheStoreOptions,
} from './plugin/isrCacheStore';

// ========== prom-client 指标 ==========
export {
  promRegistry,
  recordHttpRequest,
  createPrometheusMetricsMiddleware,
  invalidatorRunsTotal,
  invalidatorFailuresTotal,
} from './metrics/PromMetrics';

// ========== Vite 插件：字体优化 ==========
export { createFontPlugin, type FontPluginOptions } from './plugin/createFontPlugin';

// ========== Vite 插件：图片优化（sharp 为 optionalDependency）==========
export {
  createImagePlugin,
  createImageMiddleware,
  type ImagePluginOptions,
} from './plugin/createImagePlugin';

// ========== SEO ==========
export { SEOEngine, createSEOEngine, DEFAULT_SEO_CONFIG, mergeSEOConfig } from './engine/seo';
export type { SEOConfig, SEOPageData, DeepPartial } from './engine/seo';
export { renderPageSeoMeta } from './engine/seo/PageSeoMeta';
export type { PageSeoMeta } from './engine/seo/PageSeoMeta';
export { injectSeoMeta } from './engine/seo/injectSeoMeta';

// ========== i18n ==========
export type { IntlPayload } from './engine/i18n/types';

// ========== 数据加载（i18n / SEO 数据 hook 推荐用此包装） ==========
export { createCachedFetcher } from './defaults/runtime/createCachedFetcher';
export type { CachedFetcher, CachedFetcherOptions } from './defaults/runtime/createCachedFetcher';

// ========== 高阶 FaaS hooks 工厂（声明式配置 → 完整 hooks）==========
export {
  applyRuntimeToServerHooks,
  createAdminIntlLoader,
  createAdminSeoLoader,
  defineAdminSiteHooks,
  defineSiteHooks,
} from './defaults/runtime/defineSiteHooks';
export type {
  AdminSeoFallbackEntry,
  CreateAdminIntlLoaderOptions,
  CreateAdminSeoLoaderOptions,
  DefineAdminSiteHooksOptions,
  IntlMessagesByLocale,
  RuntimeServiceBase,
  RuntimeServices,
  SiteHooksConfig,
  SiteRuntimeConfig,
  SiteRuntimeContext,
  IntlConfig,
  SeoEntry,
  SeoStaticEntry,
  SeoRemoteEntry,
  ServerHooksOutput,
} from './defaults/runtime/defineSiteHooks';

// ========== RSC 集成（revalidate / cacheTag / action registry） ==========
// 注意：Flight 协议本体由 @vitejs/plugin-rsc 提供；本包仅暴露
// "缓存失效 + 渲染期 tag 声明 + action 元数据 registry"
export {
  revalidatePath,
  revalidateTag,
  cacheTag,
  collectTags,
  runWithTagStore,
  registerInvalidator,
  RevalidationError,
  serverActionsRegistry,
  createServerAction,
  ServerActionUtils,
  SERVER_ACTION_ENDPOINT,
  LEGACY_SERVER_ACTION_ENDPOINT,
  getI18n,
  getI18nLocale,
} from './rsc';
export type {
  RevalidateInvalidator,
  ServerActionMetadata,
  ServerActionHandler,
  I18nParams,
  Translate,
} from './rsc';

// ========== 工具 ==========
export { Logger } from '@/logger/Logger';
export { CacheCleanup } from '@/utils/CacheCleanup';
export {
  getCookieHeader,
  parseCookieHeader,
  readCookie,
  type CookieHeaderSource,
} from '@/utils/cookie';

// ========== 项目发现（仅路由扫描 —— "use client"/"use server" 指令由 plugin-rsc 识别） ==========
export {
  scanProject,
  scanRoutes,
  scanComponents,
  parseRouteFromFile,
  parseRoutes,
  parseComponentFromFile,
  parseComponents,
  isCodeFile,
  isTestFile,
  readDirRecursive,
  DEFAULT_SCAN_CONFIG,
} from './discovery';
export type {
  ComponentMetadata,
  ComponentType,
  FileInfo,
  RouteDiscoveryConfig,
  RouteMetadata,
  RouteType,
  ScanConfig,
  ScanResult,
} from './discovery';

// ========== 性能指标 ==========
export { MetricsCollector } from './metrics';
export type { RequestRecord, MetricsSnapshot } from './metrics';

// ========== Vite 插件（一体化） ==========
export {
  createIsrPlugin,
  createIsrCacheHandler,
  createIsrCacheMiddleware,
  type CreateIsrPluginOptions,
  type IsrCacheHandler,
  type IsrCacheMiddlewareOptions,
  type IsrInvalidationBus,
  type IsrInvalidationTarget,
} from './plugin';

// ========== 限流（per-IP / per-key fixed-window）==========
export {
  createRateLimiter,
  createRateLimitStoreFromRuntime,
  createMemoryRateLimitStore,
  createRedisRateLimitStore,
  type RateLimitOptions,
  type ResolvedRateLimitStore,
  type RateLimitStore,
} from './middlewares/RateLimiter';

// ========== A/B 变体（cookie-sticky + RequestContext 注入）==========
export {
  createABVariantMiddleware,
  getVariant,
  type ABVariantOptions,
  type ExperimentConfig,
} from './middlewares/ABVariantMiddleware';
