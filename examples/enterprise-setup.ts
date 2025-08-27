/**
 * 企业级ISR引擎配置示例
 * 展示如何在生产环境中配置和使用Novel ISR引擎
 */

import { createNovelEngine } from '@novel-isr/engine';
import {
  MultiTierCacheStrategy,
  CacheKeyGenerator,
  CacheWarmupManager,
  CachePrefetchManager,
} from '@novel-isr/engine/cache';
import {
  ISRQueue,
  ISRResourceMonitor,
  ISRHealthChecker,
} from '@novel-isr/engine/modules';
import {
  RuntimeConfigManager,
  ConfigSchema,
} from '@novel-isr/engine/config';
import {
  SeoManager,
  SitemapGenerator,
} from '@novel-isr/engine/modules';
import {
  globalErrorHandler,
} from '@novel-isr/engine/utils';

// 定义配置模式
const configSchema: ConfigSchema = {
  'server.port': {
    type: 'number',
    required: true,
    default: 3000,
    description: '服务器端口',
  },
  'cache.redis.url': {
    type: 'string',
    required: false,
    description: 'Redis连接URL',
    sensitive: true,
  },
  'isr.revalidate': {
    type: 'number',
    required: false,
    default: 3600,
    description: 'ISR重新验证间隔（秒）',
    validation: (value) => value > 0 && value < 86400,
  },
  'seo.baseUrl': {
    type: 'string',
    required: true,
    description: '网站基础URL',
  },
  'preload.maxItems': {
    type: 'number',
    required: false,
    default: 10,
    description: '最大预加载项目数',
    validation: (value) => value > 0 && value <= 50,
  },
};

/**
 * 企业级ISR引擎配置
 */
export async function createEnterpriseISREngine() {
  console.log('🚀 初始化企业级ISR引擎...');

  // 1. 初始化运行时配置管理
  const configManager = new RuntimeConfigManager({
    configFile: './config/production.json',
    watchForChanges: true,
    enableRemoteConfig: process.env.REMOTE_CONFIG_URL ? true : false,
    remoteConfigUrl: process.env.REMOTE_CONFIG_URL,
    refreshInterval: 300000, // 5分钟
    schema: configSchema,
    verbose: process.env.NODE_ENV === 'development',
  });

  await configManager.initialize();
  console.log('✅ 配置管理器初始化完成');

  // 2. 初始化多层缓存策略
  const cacheConfig = {
    l1: {
      maxSize: configManager.get('cache.l1.maxSize', 1000),
      ttl: configManager.get('cache.l1.ttl', 300), // 5分钟
    },
    l2: {
      enabled: configManager.has('cache.redis.url'),
      redis: {
        host: configManager.get('cache.redis.host', 'localhost'),
        port: configManager.get('cache.redis.port', 6379),
        password: configManager.get('cache.redis.password'),
      },
      ttl: configManager.get('cache.l2.ttl', 3600), // 1小时
    },
    l3: {
      enabled: true,
      maxSize: configManager.get('cache.l3.maxSize', 10000),
      ttl: configManager.get('cache.l3.ttl', 86400), // 24小时
    },
    verbose: process.env.NODE_ENV === 'development',
  };

  const cacheStrategy = new MultiTierCacheStrategy(cacheConfig);
  await cacheStrategy.initialize();
  console.log('✅ 多层缓存策略初始化完成');

  // 3. 初始化SEO管理器
  const seoConfig = {
    baseUrl: configManager.get('seo.baseUrl'),
    sitemap: {
      enabled: configManager.get('seo.sitemap.enabled', true),
      filename: 'sitemap.xml',
      routes: [],
      autoDiscovery: true,
    },
    robots: {
      enabled: configManager.get('seo.robots.enabled', true),
      rules: [
        {
          userAgent: '*',
          disallow: ['/admin/', '/api/', '/private/'],
          allow: ['/api/public/'],
          crawlDelay: 1,
        },
        {
          userAgent: 'Googlebot',
          disallow: [],
        },
      ],
    },
    redirects: [],
    canonicalization: {
      enabled: true,
      trailingSlash: 'remove' as const,
      wwwRedirect: 'remove' as const,
    },
  };

  const seoManager = new SeoManager(seoConfig, process.env.NODE_ENV === 'development');
  await seoManager.initialize();
  console.log('✅ SEO管理器初始化完成');

  // 4. 初始化ISR队列和资源监控
  const isrQueue = new ISRQueue({
    maxQueueSize: configManager.get('isr.maxQueueSize', 1000),
    maxConcurrentJobs: configManager.get('isr.maxConcurrentJobs', 3),
    verbose: process.env.NODE_ENV === 'development',
  });

  const resourceMonitor = new ISRResourceMonitor({
    maxMemoryUsage: configManager.get('monitor.maxMemoryUsage', 512),
    maxDiskUsage: configManager.get('monitor.maxDiskUsage', 90),
    maxCpuUsage: configManager.get('monitor.maxCpuUsage', 80),
    checkInterval: configManager.get('monitor.checkInterval', 30000),
    verbose: process.env.NODE_ENV === 'development',
  });

  const healthChecker = new ISRHealthChecker(isrQueue, resourceMonitor, process.env.NODE_ENV === 'development');

  resourceMonitor.startMonitoring();
  console.log('✅ 资源监控启动完成');

  // 5. 初始化缓存预热和预取
  const renderFunction = async (url: string) => {
    // 这里应该是实际的渲染函数
    console.log(`渲染页面: ${url}`);
    return { html: `<html><body>Page: ${url}</body></html>` };
  };

  const warmupManager = new CacheWarmupManager(
    cacheStrategy,
    {
      routes: configManager.get('warmup.routes', ['/', '/about', '/contact']),
      priority: 10,
      batchSize: configManager.get('warmup.batchSize', 5),
      interval: configManager.get('warmup.interval', 1000),
      maxConcurrent: configManager.get('warmup.maxConcurrent', 3),
    },
    renderFunction
  );

  const prefetchManager = new CachePrefetchManager(
    cacheStrategy,
    [
      {
        pattern: /^\/$/,
        relatedPaths: ['/about', '/contact'],
        priority: 10,
        maxAge: 3600,
      },
      {
        pattern: /^\/products\/(.+)/,
        relatedPaths: ['/products', '/cart'],
        priority: 8,
        maxAge: 1800,
      },
    ],
    renderFunction
  );

  console.log('✅ 缓存预热和预取管理器初始化完成');

  // 6. 初始化错误处理
  globalErrorHandler.registerFallbackStrategy({
    name: 'enterprise-fallback',
    condition: (error) => error.severity >= 3, // 高严重性错误
    handler: async (error, context) => {
      console.error('企业级降级策略触发:', error.message);
      // 发送到监控系统
      // await monitoringService.reportError(error);
      return {
        fallbackStrategy: 'cached-or-csr',
        renderMode: 'csr',
        reason: 'Enterprise fallback triggered',
      };
    },
    priority: 200,
  });

  console.log('✅ 企业级错误处理配置完成');

  // 7. 创建ISR引擎实例
  const engine = createNovelEngine({
    mode: 'isr',
    server: {
      port: configManager.get('server.port', 3000),
      host: configManager.get('server.host', '0.0.0.0'),
    },
    routes: {
      '/': 'ssg',
      '/about': 'isr',
      '/products/*': 'isr',
      '/admin/*': 'csr',
      '/*': 'isr',
    },
    isr: {
      revalidate: configManager.get('isr.revalidate', 3600),
      backgroundRevalidation: configManager.get('isr.backgroundRevalidation', true),
      maxConcurrentRegenerations: configManager.get('isr.maxConcurrentRegenerations', 3),
      renderTimeout: configManager.get('isr.renderTimeout', 30000),
    },
    cache: {
      strategy: 'memory', // 将被多层缓存策略覆盖
      ttl: 3600,
    },
    seo: {
      enabled: true,
      generateSitemap: true,
      generateRobots: true,
      baseUrl: configManager.get('seo.baseUrl'),
    },
    dev: {
      verbose: process.env.NODE_ENV === 'development',
      hmr: process.env.NODE_ENV === 'development',
    },
  });

  // 8. 集成企业级组件
  // 替换默认缓存策略
  (engine as any).cacheStrategy = cacheStrategy;
  (engine as any).seoManager = seoManager;
  (engine as any).isrQueue = isrQueue;
  (engine as any).resourceMonitor = resourceMonitor;
  (engine as any).healthChecker = healthChecker;
  (engine as any).configManager = configManager;

  // 9. 设置生命周期钩子
  engine.on('server:start', async () => {
    console.log('🌟 ISR引擎服务器启动，开始缓存预热...');
    
    // 启动缓存预热
    await warmupManager.startWarmup();
    
    // 生成SEO文件
    await seoManager.generateAllFiles('./dist');
    
    console.log('✅ 企业级ISR引擎完全启动');
  });

  engine.on('request', async (context: any) => {
    // 处理预取逻辑
    await prefetchManager.onPageRequest(context.url);
  });

  engine.on('error', async (error: any) => {
    // 企业级错误处理
    console.error('ISR引擎错误:', error);
    
    // 记录到队列统计
    if (error.type === 'isr') {
      // 可以在这里记录ISR相关错误
    }
  });

  // 10. 健康检查端点
  engine.addRoute('/health', async (req: any, res: any) => {
    const health = await healthChecker.getHealthStatus();
    
    res.status(health.status === 'healthy' ? 200 : 
              health.status === 'degraded' ? 206 : 500)
       .json({
         status: health.status,
         timestamp: new Date().toISOString(),
         checks: health.checks,
         metrics: health.metrics,
         recommendations: health.recommendations,
       });
  });

  // 11. 管理端点
  engine.addRoute('/admin/stats', async (req: any, res: any) => {
    res.json({
      cache: cacheStrategy.getStats(),
      isr: isrQueue.getMetrics(),
      resources: resourceMonitor.getResourceStats(),
      config: configManager.getSafeConfig(),
    });
  });

  // 12. 优雅关闭处理
  process.on('SIGTERM', async () => {
    console.log('🔄 收到SIGTERM信号，开始优雅关闭...');
    
    resourceMonitor.stopMonitoring();
    isrQueue.pause();
    await cacheStrategy.clear();
    await configManager.shutdown();
    
    console.log('✅ 企业级ISR引擎优雅关闭完成');
    process.exit(0);
  });

  console.log('🎯 企业级ISR引擎配置完成，准备启动...');
  
  return engine;
}

// 使用示例
if (require.main === module) {
  createEnterpriseISREngine()
    .then(engine => {
      engine.start();
    })
    .catch(error => {
      console.error('❌ 企业级ISR引擎启动失败:', error);
      process.exit(1);
    });
}

export default createEnterpriseISREngine;