/**
 * Novel ISR Engine - 企业级入口文件
 *
 * 提供完整的 ISR/SSR/SSG/CSR 解决方案
 * 支持 React Server Components (RSC)
 * 企业级性能和安全特性
 *
 * @version 2.0.0
 * @author Novel Team
 */
import { EnterpriseISREngine } from './engines/EnterpriseISREngine';
import type { EnterpriseISRConfig } from './engines/EnterpriseISREngine';
import type { NovelISRConfig, RenderContext } from './types';

// ========== 企业级引擎 ==========
export { EnterpriseISREngine } from './engines/EnterpriseISREngine';
export { FallbackChainEngine, createFallbackChainEngine } from './engines/FallbackChainEngine';

// ========== 企业级模块 ==========
export { EnterpriseRSCRuntime, createEnterpriseRSCRuntime } from './modules/EnterpriseRSCRuntime';
export { EnterpriseSEOEngine, createEnterpriseSEOEngine } from './modules/EnterpriseSEOEngine';
export { AppShellManager, createAppShellManager } from './modules/AppShellManager';

// ========== 企业级缓存 ==========
export { EnterpriseCacheEngine, createEnterpriseCacheEngine } from './cache/EnterpriseCacheEngine';

// ========== 传统模块（兼容性） ==========
export { default as ISREngine } from './engines/ISREngine';
export { RenderMode } from './engines/RenderMode';
export { ISRFactory, createNovelEngine, NovelEngine } from './engines/ISRFactory';

// ========== 缓存系统 ==========
export { CacheManager } from './cache';
export {
  MultiTierCacheStrategy,
  CacheKeyGenerator,
  CacheWarmupManager,
  CachePrefetchManager,
} from './cache/CacheStrategies';

// ========== 核心模块 ==========
export { ISRModule } from './modules/ISRModule';
export { SSGGenerator } from './modules/SSGGenerator';
export { SSGManager } from './modules/SSGManager';
export { CSRFallback } from './modules/CSRFallback';
export { SEOModule } from './modules/SEOModule';
export {
  SitemapGenerator,
  RobotsGenerator,
  RedirectManager,
  SeoManager,
} from './modules/SeoEnhancements';
export { RSCRenderer } from './modules/RSCRenderer';
export { ISRQueue, ISRResourceMonitor, ISRHealthChecker } from './modules/ISREnhancements';
export { SpiderEngine } from './modules/SpiderEngine';
export { BundleAnalyzer, IntelligentPreloader } from './modules/BundleOptimizer';

// ========== RSC 系统 ==========
export {
  PlumberSerializer,
  PlumberDeserializer,
  PlumberProtocolHandler,
  plumberProtocol,
} from './rsc/PlumberProtocol';
export { RSCRuntime, rscRuntime } from './rsc/RSCRuntime';
export type { RSCComponentMeta, RSCRuntimeConfig } from './rsc/RSCRuntime';
export {
  serverActionsRegistry,
  serverActionsMiddleware,
  serverAction,
  createServerAction,
  ServerActionUtils,
} from './rsc/ServerActions';
export type {
  ServerActionMetadata,
  ServerActionExecution,
  ServerActionHandler,
} from './rsc/ServerActions';
export type { RSCPayload } from './modules/RSCRenderer';

// ========== 工具模块 ==========
export { Logger } from './utils/Logger';
export { MetricsCollector } from './utils/MetricsCollector';
export { ErrorHandler } from './utils/ErrorHandler';
export { CacheCleanup } from './utils/CacheCleanup';

// ========== 路由系统 ==========
export { RouteManager } from './route/RouteManager';

// ========== 配置系统 ==========
export { EnterpriseConfig } from './config/EnterpriseConfig';
export { ISRConfig } from './config/ISRConfig';
export { RuntimeConfigManager, ConfigTemplateGenerator } from './config/RuntimeConfig';

// ========== Vite 插件（传统） ==========
export { createViteISRPlugin, createViteDevMiddleware } from './plugin/ViteISRPlugin';

// ========== 类型定义 ==========
export * from './types';

/**
 * 快速启动函数 - 企业级
 * 提供开箱即用的企业级 ISR 解决方案
 */
export async function createEnterpriseApp(
  options: {
    config?: Partial<EnterpriseISRConfig>;
    mode?: 'development' | 'production';
    features?: {
      rsc?: boolean;
      multiCache?: boolean;
      advancedSEO?: boolean;
      monitoring?: boolean;
      appShell?: boolean;
    };
  } = {}
) {
  const {
    config = {},
    mode = process.env.NODE_ENV === 'production' ? 'production' : 'development',
    features = {},
  } = options;

  // 默认启用所有企业级功能
  const defaultFeatures = {
    rsc: true,
    multiCache: true,
    advancedSEO: true,
    monitoring: true,
    appShell: true,
    ...features,
  };

  // 构建企业级配置
  const enterpriseConfig = {
    mode: 'isr',
    dev: {
      verbose: mode === 'development',
      hmr: mode === 'development',
    },
    enterprise: {
      enabled: true,
      // 降级链配置：已移除 CSR(客户端渲染) 策略
      fallbackChain: {
        enabled: true,
        strategies: [
          // 注：已移除以下 CSR 策略配置
          // { name: 'client', priority: 5, timeout: 1000, retries: 0 },
          { name: 'static', priority: 1, timeout: 500, retries: 1 },
          { name: 'cached', priority: 2, timeout: 200, retries: 1 },
          { name: 'regenerate', priority: 3, timeout: 5000, retries: 2 },
          { name: 'server', priority: 4, timeout: 8000, retries: 1 },
        ],
        adaptive: {
          enabled: true,
          learningRate: 0.1,
          performanceThreshold: 3000,
        },
      },
      cache: {
        multiLayer: defaultFeatures.multiCache,
        compression: true,
        encryption: mode === 'production',
        analytics: defaultFeatures.monitoring,
      },
      seo: {
        advanced: defaultFeatures.advancedSEO,
        structuredData: true,
        performance: true,
        multiLanguage: false,
      },
      monitoring: {
        detailed: defaultFeatures.monitoring,
        realtime: mode === 'development',
        alerts: mode === 'production',
        dashboard: false,
      },
    },
    rsc: {
      enabled: defaultFeatures.rsc,
      maxWorkers: 4,
      cacheSize: 1000,
    },
    ...config,
  } as EnterpriseISRConfig;

  // 创建企业级引擎
  const engine = new EnterpriseISREngine(enterpriseConfig);

  return {
    engine,
    config: enterpriseConfig,

    // 便捷方法
    start: async (_port = 3000) => {
      return await engine.start();
    },

    render: async (url: string, context: RenderContext = {}) => {
      return await engine.render(url, context);
    },

    getStats: () => {
      return engine.getStats();
    },

    shutdown: async () => {
      return await engine.shutdown();
    },
  };
}

/**
 * 快速启动函数 - 传统模式
 * 提供向后兼容的 ISR 解决方案
 */
export async function createISRApp(config: Partial<NovelISRConfig> = {}) {
  const { default: ISREngine } = await import('./engines/ISREngine');
  const engine = new ISREngine(config);

  return {
    engine,
    config,

    start: async (_port = 3000) => {
      return await engine.start();
    },

    render: async (url: string, context: RenderContext = {}) => {
      return await engine.render(url, context);
    },

    getStats: () => {
      return engine.getStats();
    },

    shutdown: async () => {
      return await engine.shutdown();
    },
  };
}

// ========== 默认导出 ==========
export default EnterpriseISREngine;
