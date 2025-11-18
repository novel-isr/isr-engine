/**
 * 企业级 ISR 引擎 V2
 * 集成所有企业级模块，提供完整的 ISR/SSR/SSG/CSR 解决方案
 *
 * 核心功能：
 * - 企业级自动降级链 (ISR -> SSG -> CSR)
 * - 企业级 RSC Runtime 支持
 * - 高级 SEO 优化引擎
 * - 多层级缓存优化
 * - AppShell 共享架构
 * - 性能监控和分析
 * - 生产级错误处理
 */

import { Server } from 'http';
import express, { Express, Request, Response } from 'express';
import compression from 'compression';
import helmet from 'helmet';
import type { ReactElement } from 'react';

// 核心模块
import { FallbackChainEngine } from './FallbackChainEngine';
import { EnterpriseRSCRuntime } from '../modules/EnterpriseRSCRuntime';
import { EnterpriseSEOEngine } from '../modules/EnterpriseSEOEngine';
import { EnterpriseCacheEngine } from '../cache/EnterpriseCacheEngine';
import { AppShellManager } from '../modules/AppShellManager';

// 传统模块（兼容性）
import { CacheManager } from '../cache';
import { CSRFallback } from '../modules/CSRFallback';
import { ISRModule } from '../modules/ISRModule';
import { SEOModule } from '../modules/SEOModule';
import { SSGGenerator } from '../modules/SSGGenerator';
import { RSCRenderer } from '../modules/RSCRenderer';
import { SSRRenderer } from '../modules/SSRRenderer';
import type { RSCRuntime } from '../rsc/RSCRuntime';

// 工具模块
import { Logger } from '../utils/Logger';
import { MetricsCollector } from '../utils/MetricsCollector';
import { ErrorHandler } from '../utils/ErrorHandler';
import { CacheCleanup } from '../utils/CacheCleanup';

// 类型和配置
import type { NovelISRConfig, RenderResult, RenderContext, RenderMeta } from '../types';
import { createServer as createViteServer, ViteDevServer, build as viteBuild } from 'vite';

export interface EnterpriseISRConfig extends NovelISRConfig {
  // 企业级特性配置
  enterprise: {
    enabled: boolean;
    fallbackChain: {
      enabled: boolean;
      strategies: Array<{
        name: string;
        priority: number;
        timeout: number;
        retries: number;
      }>;
      adaptive: {
        enabled: boolean;
        learningRate: number;
        performanceThreshold: number;
      };
    };
    cache: {
      multiLayer: boolean;
      compression: boolean;
      encryption: boolean;
      analytics: boolean;
    };
    seo: {
      advanced: boolean;
      structuredData: boolean;
      performance: boolean;
      multiLanguage: boolean;
    };
    monitoring: {
      detailed: boolean;
      realtime: boolean;
      alerts: boolean;
      dashboard: boolean;
    };
  };
}

/**
 * 企业级 ISR 引擎实现
 */
export class EnterpriseISREngine {
  private config: EnterpriseISRConfig;
  private logger: Logger;
  private metrics: MetricsCollector;
  private errorHandler: ErrorHandler;

  // 企业级模块
  private fallbackChainEngine?: FallbackChainEngine;
  private enterpriseRSCRuntime?: EnterpriseRSCRuntime;
  private enterpriseSEOEngine?: EnterpriseSEOEngine;
  private enterpriseCacheEngine?: EnterpriseCacheEngine;
  private appShellManager?: AppShellManager;

  // 传统模块（兼容性）
  private cache?: CacheManager;
  private csrFallback?: CSRFallback;
  private isrModule?: ISRModule;
  private seoModule?: SEOModule;
  private ssgGenerator?: SSGGenerator;
  private rscRuntime?: RSCRenderer;
  private ssrRenderer?: SSRRenderer;

  // 服务器相关
  private viteServer?: ViteDevServer;
  private expressApp?: Express;
  private httpServer?: Server;

  // 统计信息
  private stats: {
    requests: number;
    successfulRenders: number;
    failedRenders: number;
    cacheHits: number;
    fallbacksUsed: number;
    averageResponseTime: number;
    uptime: number;
  };

  constructor(config: Partial<EnterpriseISRConfig>) {
    // 合并配置
    this.config = {
      ...this.getDefaultConfig(),
      ...config,
      enterprise: {
        ...this.getDefaultEnterpriseConfig(),
        ...config.enterprise,
      },
    } as EnterpriseISRConfig;

    // 初始化核心工具
    this.logger = new Logger(this.config.dev?.verbose || false);
    this.metrics = new MetricsCollector();
    this.errorHandler = new ErrorHandler({});

    // 初始化统计信息
    this.stats = {
      requests: 0,
      successfulRenders: 0,
      failedRenders: 0,
      cacheHits: 0,
      fallbacksUsed: 0,
      averageResponseTime: 0,
      uptime: Date.now(),
    };
  }

  /**
   * 初始化企业级 ISR 引擎
   */
  async initialize(): Promise<void> {
    try {
      this.logger.info('🚀 初始化企业级 ISR 引擎 V2...');

      // 开发环境清理
      if (process.env.NODE_ENV !== 'production') {
        await CacheCleanup.cleanupOnDevStart();
      }

      // 初始化企业级缓存引擎
      if (this.config.enterprise.cache.multiLayer) {
        this.enterpriseCacheEngine = new EnterpriseCacheEngine(
          {
            enabled: true,
            strategy: 'hybrid',
            compression: {
              enabled: this.config.enterprise.cache.compression,
              algorithm: 'gzip',
              level: 6,
              minSize: 1024,
            },
            security: {
              enableEncryption: this.config.enterprise.cache.encryption,
              enableAccessControl: false,
              allowedOrigins: ['*'],
            },
            monitoring: {
              enableMetrics: this.config.enterprise.cache.analytics,
              enableHealthCheck: true,
              metricsInterval: 60000,
              alertThresholds: {
                hitRateLow: 0.5,
                latencyHigh: 1000,
                errorRateHigh: 0.1,
              },
            },
          },
          this.config.dev?.verbose
        );
        await this.enterpriseCacheEngine.initialize();
        this.logger.info('✅ 企业级缓存引擎已初始化');
      } else {
        // 使用传统缓存管理器
        this.cache = new CacheManager(this.config.cache || {});
        await this.cache.initialize();
        this.logger.info('✅ 传统缓存管理器已初始化');
      }

      // 初始化企业级 SEO 引擎
      if (this.config.enterprise.seo.advanced) {
        this.enterpriseSEOEngine = new EnterpriseSEOEngine(
          process.cwd(),
          {
            enabled: true,
            baseUrl: this.config.seo?.baseUrl || 'http://localhost:3000',
            structuredData: {
              enabled: this.config.enterprise.seo.structuredData,
              organization: {},
              website: {},
              breadcrumbs: true,
              articles: true,
              products: false,
            },
            performance: {
              enableCriticalCSS: this.config.enterprise.seo.performance,
              enableResourceHints: true,
              enablePreloading: true,
              enableWebpImages: false,
            },
            monitoring: {
              enableAnalytics: this.config.enterprise.monitoring.detailed,
              enableCoreWebVitals: true,
              reportingEndpoint: undefined,
            },
          },
          this.config.dev?.verbose
        );
        await this.enterpriseSEOEngine.initialize();
        this.logger.info('✅ 企业级 SEO 引擎已初始化');
      } else {
        // 使用传统 SEO 模块
        this.seoModule = new SEOModule(this.config.seo || {});
        await this.seoModule.initialize();
        this.logger.info('✅ 传统 SEO 模块已初始化');
      }

      // 初始化企业级 RSC Runtime
      if (this.config.rsc?.enabled !== false) {
        this.enterpriseRSCRuntime = new EnterpriseRSCRuntime(process.cwd(), {
          enabled: true,
          maxWorkers: this.config.rsc?.maxWorkers || 4,
          cacheSize: 1000,
          componentsDir: './src/components',
        });
        await this.enterpriseRSCRuntime.initialize();
        this.logger.info('✅ 企业级 RSC Runtime 已初始化');
      }

      // 初始化 AppShell 管理器
      this.appShellManager = new AppShellManager(
        process.cwd(),
        {
          enabled: true,
          template: 'src/App.tsx',
          multiEntry: { enabled: false, entries: {} },
          caching: { enabled: true, strategy: 'hybrid', ttl: 3600 },
          optimization: {
            codeSplitting: true,
            preloadCritical: true,
            lazyLoadNonCritical: true,
            bundleAnalysis: false,
          },
        },
        this.config.dev?.verbose
      );
      await this.appShellManager.initialize();
      this.logger.info('✅ AppShell 管理器已初始化');

      // 初始化 Vite 服务器（开发模式）- 必须在加载 renderServer 之前
      if (process.env.NODE_ENV !== 'production') {
        await this.initializeViteServer();
      }

      // 初始化传统模块（兼容性）
      await this.initializeCompatibilityModules();

      // 将 Vite 服务器实例传递给 ISR 模块
      if (this.viteServer && this.isrModule) {
        (this.isrModule as any).setViteServer(this.viteServer);
        this.logger.debug('✅ Vite 服务器实例已传递给 ISR 模块');
      }

      // 初始化企业级降级链引擎
      if (this.config.enterprise.fallbackChain.enabled) {
        // 🔗 强制加载 render/renderServer 函数（不允许 fallback）
        const renderServerFn = await this.loadRenderServerFunction();

        // ✅ 强制验证：如果加载失败，直接抛出错误（符合规则：禁止 fallback 机制）
        if (!renderServerFn) {
          const errorMessage = [
            '❌ 无法加载 render 函数，服务端渲染引擎无法启动',
            '',
            '请检查以下问题：',
            '1. src/entry.tsx 必须导出 render 函数（返回 React App 元素）或兼容的 renderServer 函数',
            '2. render 函数需返回 { appElement, helmetContext, rscRuntime }，供引擎执行 SSR',
            '3. 开发模式：确保 Vite 服务器已正确初始化',
            '4. 生产模式：确保已运行构建命令生成 dist/server/entry.js',
            '',
            '当前环境：' + (process.env.NODE_ENV || 'development'),
            '工作目录：' + process.cwd(),
          ].join('\n');

          this.logger.error(errorMessage);
          throw new Error('render 函数加载失败');
        }

        this.logger.info('✅ render 入口加载成功');

        this.fallbackChainEngine = new FallbackChainEngine(
          {
            strategies: this.config.enterprise.fallbackChain.strategies.map(s => ({
              name: s.name as any,
              priority: s.priority,
              timeout: s.timeout,
              retries: s.retries,
            })),
            performance: {
              enableAdaptive: this.config.enterprise.fallbackChain.adaptive.enabled,
              performanceThreshold:
                this.config.enterprise.fallbackChain.adaptive.performanceThreshold,
              errorRateThreshold: 10,
              adaptiveWindow: 300,
            },
          },
          {
            cache: (this.enterpriseCacheEngine || this.cache) as any,
            ssgGenerator: this.ssgGenerator as any,
            isrModule: this.isrModule as any,
            csrFallback: this.csrFallback as any,
            seoModule: (this.enterpriseSEOEngine || this.seoModule) as any,
            metrics: this.metrics,
            renderServerFn,
          },
          this.config.dev?.verbose
        );
        await this.fallbackChainEngine.initialize();
        this.logger.info('✅ 企业级降级链引擎已初始化');
      }

      this.logger.info('🎉 企业级 ISR 引擎 V2 初始化完成');
    } catch (error) {
      this.logger.error('❌ 企业级 ISR 引擎初始化失败:', error);
      throw error;
    }
  }

  /**
   * 渲染页面（企业级）
   */
  async render(url: string, context: RenderContext = {}): Promise<RenderResult> {
    const startTime = Date.now();
    this.stats.requests++;

    try {
      this.logger.debug(`🎨 企业级渲染: ${url}`);

      // 如果启用了降级链引擎，使用企业级渲染
      if (this.config.enterprise.fallbackChain.enabled && this.fallbackChainEngine) {
        return await this.renderWithFallbackChain(url, context, startTime);
      } else {
        // 使用传统渲染逻辑
        return await this.renderTraditional(url, context, startTime);
      }
    } catch (error) {
      this.stats.failedRenders++;
      this.logger.error(`❌ 企业级渲染失败: ${url}`, error);
      throw error;
    }
  }

  /**
   * 使用降级链渲染
   */
  private async renderWithFallbackChain(
    url: string,
    context: RenderContext,
    startTime: number
  ): Promise<RenderResult> {
    await this.ensureRouteData(url, context);

    // 使用企业级降级链引擎
    const result = await this.fallbackChainEngine!.executeChain(url, context);

    // 应用企业级 SEO 优化
    if (this.config.enterprise.seo.advanced && this.enterpriseSEOEngine) {
      const optimizedResult = await this.enterpriseSEOEngine.optimizePage(url, context, result);

      if (this.stats) {
        this.stats.successfulRenders++;
        this.updateAverageResponseTime(Date.now() - startTime);
      }

      return optimizedResult;
    }

    this.stats.successfulRenders++;
    this.updateAverageResponseTime(Date.now() - startTime);

    return result;
  }

  /**
   * 传统渲染（兼容性）
   */
  private async renderTraditional(
    url: string,
    context: RenderContext,
    startTime: number
  ): Promise<RenderResult> {
    // 简化的传统渲染逻辑
    // 这里可以实现基本的 ISR/SSR/SSG 逻辑

    const result: RenderResult = {
      success: true,
      html: this.generateBasicHTML(url),
      helmet: null,
      preloadLinks: '',
      statusCode: 200,
      meta: {
        renderMode: 'ssr',
        strategy: 'traditional',
        timestamp: Date.now(),
        renderTime: Date.now() - startTime,
      },
    };

    this.stats.successfulRenders++;
    this.updateAverageResponseTime(Date.now() - startTime);

    return result;
  }

  /**
   * 生成基础 HTML
   */
  private generateBasicHTML(url: string): string {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Enterprise ISR Engine</title>
</head>
<body>
  <div id="root">
    <h1>Enterprise ISR Engine V2</h1>
    <p>Rendering: ${url}</p>
    <p>Timestamp: ${new Date().toISOString()}</p>
    <p>Engine: ${this.config.enterprise.enabled ? 'Enterprise' : 'Traditional'}</p>
  </div>
</body>
</html>
`;
  }

  /**
   * 启动 Express 服务器
   */
  async start(): Promise<Server> {
    await this.initialize();

    this.expressApp = express();

    // 配置中间件
    await this.setupMiddleware();

    // 配置路由
    this.setupRoutes();

    // 启动服务器
    const port = this.config.server?.port || 3000;
    const host = this.config.server?.host || 'localhost';

    return new Promise((resolve, reject) => {
      this.httpServer = this.expressApp!.listen(port, host, () => {
        this.logger.info(`🚀 企业级 ISR 引擎服务器启动: http://${host}:${port}`);
        resolve(this.httpServer!);
      });

      this.httpServer.on('error', error => {
        this.logger.error('❌ 服务器启动失败:', error);
        reject(error);
      });
    });
  }

  /**
   * 设置中间件
   */
  private async setupMiddleware(): Promise<void> {
    if (!this.expressApp) return;

    // 安全中间件 - 开发环境放宽CSP限制
    const isDev = process.env.NODE_ENV !== 'production';
    this.expressApp.use(
      helmet({
        contentSecurityPolicy: {
          directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", 'https:'],
            scriptSrc: isDev
              ? ["'self'", "'unsafe-inline'", "'unsafe-eval'", 'https:', 'http:', 'ws:', 'wss:']
              : ["'self'"],
            imgSrc: ["'self'", 'data:', 'https:', 'http:'],
            connectSrc: isDev
              ? [
                  "'self'",
                  'ws://localhost:*',
                  'wss://localhost:*',
                  'http://localhost:*',
                  'https://localhost:*',
                ]
              : ["'self'"],
            fontSrc: ["'self'", 'https:', 'data:'],
            objectSrc: ["'none'"],
            mediaSrc: ["'self'", 'https:', 'data:'],
            frameSrc: ["'self'"],
          },
        },
      })
    );

    // 压缩中间件
    this.expressApp.use(compression());

    // 解析中间件
    this.expressApp.use(express.json());
    this.expressApp.use(express.urlencoded({ extended: true }));

    // 自定义头部
    this.expressApp.use((req: Request, res: Response, next) => {
      res.setHeader('X-Powered-By', 'Enterprise-ISR-Engine-V2');
      res.setHeader('X-Enterprise-Features', this.getEnabledFeatures().join(','));
      next();
    });

    // Vite 中间件（开发模式）
    if (this.viteServer && process.env.NODE_ENV !== 'production') {
      this.expressApp.use(this.viteServer.middlewares);
    }

    // 静态文件服务
    if (process.env.NODE_ENV === 'production') {
      this.expressApp.use(express.static('./dist/client'));
    } else {
      // 开发环境的静态资源处理
      this.expressApp.use(express.static('./public'));
      this.expressApp.use('/assets', express.static('./src/assets'));

      // 404静态资源的fallback处理
      this.expressApp.get('/favicon.ico', (req: Request, res: Response) => {
        res.status(204).end();
      });

      this.expressApp.get('/css/*', (req: Request, res: Response) => {
        res.setHeader('Content-Type', 'text/css');
        res.send('/* Development placeholder CSS */');
      });

      this.expressApp.get('/fonts/*', (req: Request, res: Response) => {
        res.status(404).send('Font not found in development');
      });
    }
  }

  /**
   * 设置路由
   */
  private setupRoutes(): void {
    if (!this.expressApp) return;

    // 健康检查
    this.expressApp.get('/health', (req: Request, res: Response) => {
      res.json({
        status: 'healthy',
        version: '2.0.0',
        features: this.getEnabledFeatures(),
        uptime: Date.now() - this.stats.uptime,
        stats: this.getStats(),
        timestamp: new Date().toISOString(),
      });
    });

    // 企业级指标端点
    this.expressApp.get('/metrics/enterprise', (req: Request, res: Response) => {
      const enterpriseMetrics = {
        fallbackChain: this.fallbackChainEngine?.getMetrics(),
        cache: this.enterpriseCacheEngine?.getMetrics(),
        seo: this.enterpriseSEOEngine?.getSEOMetrics(),
        rsc: this.enterpriseRSCRuntime?.getPerformanceMetrics(),
        appShell: this.appShellManager?.getPerformanceMetrics(),
      };

      res.json(enterpriseMetrics);
    });

    // 缓存管理端点
    this.expressApp.post('/cache/clear', async (req: Request, res: Response) => {
      try {
        if (this.enterpriseCacheEngine) {
          await this.enterpriseCacheEngine.clear();
        } else {
          await this.cache?.clear();
        }
        res.json({ success: true, message: '企业级缓存已清理' });
      } catch (error) {
        res.status(500).json({ success: false, error: (error as Error).message });
      }
    });

    // 站点地图端点
    this.expressApp.get('/sitemap.xml', async (req: Request, res: Response) => {
      try {
        let sitemapContent = '';

        if (this.enterpriseSEOEngine) {
          sitemapContent = await this.enterpriseSEOEngine.generateSitemap();
        } else if (this.seoModule) {
          sitemapContent = await this.seoModule.generateSitemapContent();
        }

        res.setHeader('Content-Type', 'application/xml');
        res.send(sitemapContent);
      } catch (error) {
        res.status(500).send('Sitemap generation failed');
      }
    });

    // Robots.txt 端点
    this.expressApp.get('/robots.txt', (req: Request, res: Response) => {
      try {
        let robotsContent = '';

        if (this.enterpriseSEOEngine) {
          robotsContent = this.enterpriseSEOEngine.generateRobotsTxt();
        } else if (this.seoModule) {
          robotsContent = this.seoModule.createRobotsContent();
        }

        res.setHeader('Content-Type', 'text/plain');
        res.send(robotsContent);
      } catch (error) {
        res.status(500).send('Robots.txt generation failed');
      }
    });

    // 主要渲染路由
    this.expressApp.get('*', async (req: Request, res: Response) => {
      try {
        const url = req.url;

        // 跳过静态资源
        if (this.isStaticResource(url)) {
          return res.status(404).send('Not Found');
        }

        // 跳过系统路径和浏览器特殊请求
        if (this.isSystemPath(url)) {
          this.logger.debug(`⏭️  跳过系统路径: ${url}`);
          return res.status(404).send('Not Found');
        }

        const context: RenderContext = {
          userAgent: req.get('User-Agent'),
          acceptLanguage: req.get('Accept-Language'),
          referer: req.get('Referer'),
          bypassCache: req.query.nocache === '1',
          requestedRenderMode: req.query.mode as string, // 'ssr' | 'isr' | 'ssg' | 'csr'
          requestedFallbackStrategy: req.query.fallback as string, // 'cached' | 'server' | 'client'
          viteHMR: process.env.NODE_ENV !== 'production',
        };

        const result = await this.render(url, context);

        if (result.success && result.html) {
          res.status(result.statusCode || 200);
          res.setHeader('Content-Type', 'text/html; charset=utf-8');

          // 添加企业级头部信息
          if (result.meta) {
            res.setHeader('X-Render-Mode', result.meta.renderMode || 'unknown');
            res.setHeader('X-Render-Strategy', result.meta.strategy || 'unknown');
            res.setHeader('X-Render-Time', (result.meta.renderTime || 0).toString() + 'ms');

            if (result.meta.fromCache) {
              res.setHeader('X-Cache-Status', 'HIT');
            }
            if (result.meta.fallbackUsed) {
              res.setHeader('X-Fallback-Used', 'true');
            }
          }

          res.send(result.html);
        } else {
          res.status(500).send('Rendering failed');
        }
      } catch (error) {
        this.logger.error(`❌ 路由处理错误: ${req.url}`, error);
        res.status(500).send('Internal Server Error');
      }
    });
  }

  /**
   * 初始化兼容性模块
   */
  private async initializeCompatibilityModules(): Promise<void> {
    // 传统缓存（如果未使用企业级缓存）
    if (!this.enterpriseCacheEngine) {
      this.cache = new CacheManager(this.config.cache || {});
      await this.cache.initialize();
    }

    // CSR 降级
    this.csrFallback = new CSRFallback(this.config);

    // ISR 模块
    this.isrModule = new ISRModule(this.config);

    // 传统 SEO（如果未使用企业级 SEO）
    if (!this.enterpriseSEOEngine) {
      this.seoModule = new SEOModule(this.config.seo || {});
      await this.seoModule.initialize();
    }

    // SSG 生成器
    const ssgConfig = {
      routes: this.config.ssg?.routes || ['/'],
      outputDir: {
        production: this.config.paths?.client || 'dist/client',
        development: '.isr-hyou/ssg',
      },
    };
    this.ssgGenerator = new SSGGenerator(ssgConfig, this.config.dev?.verbose);

    // 传统 RSC（如果未使用企业级 RSC）
    if (!this.enterpriseRSCRuntime) {
      this.rscRuntime = new RSCRenderer(
        {
          enabled: this.config.rsc?.enabled !== false,
        },
        this.config.dev?.verbose || false
      );
    }

    this.logger.debug('✅ 兼容性模块已初始化');
  }

  /**
   * 初始化 Vite 服务器
   */
  private async initializeViteServer(): Promise<void> {
    try {
      this.viteServer = await createViteServer({
        server: { middlewareMode: true },
        appType: 'custom',
        ssr: { noExternal: ['@novel-isr/engine'] },
      });

      // Vite server integration handled internally by EnterpriseRSCRuntime

      this.logger.info('✅ Vite 开发服务器已初始化');
    } catch (error) {
      this.logger.warn('⚠️ Vite 服务器初始化失败:', error);
    }
  }

  /**
   * 加载 renderServer 函数（从 entry.tsx）
   *
   * 职责：
   * 1. 开发模式：从 Vite SSR 加载 src/entry.tsx
   * 2. 生产模式：从构建输出 dist/server/entry.js 加载
   * 3. 验证函数签名正确性
   *
   * @returns renderServer 函数或 undefined（不允许 fallback，调用方必须验证）
   */
  private async loadRenderServerFunction(): Promise<
    ((url: string, context: Record<string, unknown>) => Promise<unknown>) | undefined
  > {
    const isDevelopment = process.env.NODE_ENV !== 'production';

    // 开发模式：使用 Vite SSR 加载
    if (isDevelopment && this.viteServer) {
      try {
        const entryPath = 'src/entry.tsx';
        this.logger.debug(`🔍 尝试从 Vite SSR 加载: ${entryPath}`);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const entryModule = (await this.viteServer.ssrLoadModule(entryPath)) as any;

        if (!entryModule) {
          this.logger.error(`❌ 模块加载失败: ${entryPath} 返回 undefined`);
          return undefined;
        }

        const resolvedFactory = this.resolveEntryRenderFunction(entryModule);

        if (!resolvedFactory) {
          this.logger.error('❌ entry.tsx 未导出 render（App 构建）或 legacy renderServer 函数');
          this.logger.error('   导出的键:', Object.keys(entryModule));
          return undefined;
        }

        if (resolvedFactory.needsWrapping) {
          this.logger.debug('✅ 开发模式：使用 entry.tsx 的 render 函数创建 SSR 渲染包装器');
          return this.createRenderServerWrapper(resolvedFactory.factory as EntryRenderFunction);
        }

        this.logger.warn('⚠️ 开发模式：检测到 legacy renderServer 导出，建议迁移到 render');
        return resolvedFactory.factory as LegacyRenderServerFunction;
      } catch (viteError) {
        this.logger.error('❌ Vite SSR 加载失败:', viteError);
        this.logger.error('   错误详情:', (viteError as Error).stack);
        // 开发模式下 Vite 失败是严重错误，直接返回
        return undefined;
      }
    }

    // 生产模式：从构建输出加载
    this.logger.debug('🔍 生产模式：从构建输出加载 renderServer');

    const possiblePaths = [
      // 相对于 isr-engine 的路径
      '../../../novel-rating-website/dist/server/entry.js',
      '../../../novel-rating-website/dist/entry.server.js',
      // 相对于工作目录的路径
      './dist/server/entry.js',
      './dist/entry.server.js',
    ];

    for (const relativePath of possiblePaths) {
      try {
        // 将相对路径转换为绝对路径
        const fs = await import('fs');
        const path = await import('path');
        const absolutePath = path.resolve(__dirname, relativePath);

        // 检查文件是否存在
        if (!fs.existsSync(absolutePath)) {
          this.logger.debug(`   跳过不存在的路径: ${absolutePath}`);
          continue;
        }

        this.logger.debug(`   尝试加载: ${absolutePath}`);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const entryModule = (await import(/* @vite-ignore */ absolutePath)) as any;

        const resolvedFactory = this.resolveEntryRenderFunction(entryModule);

        if (!resolvedFactory) {
          this.logger.warn(`   ${relativePath} 未导出 render 或 renderServer 函数`);
          continue;
        }

        if (resolvedFactory.needsWrapping) {
          this.logger.debug(`✅ 生产模式：使用 ${relativePath} 的 render 函数创建 SSR 包装器`);
          return this.createRenderServerWrapper(resolvedFactory.factory as EntryRenderFunction);
        }

        this.logger.warn(`⚠️ 生产模式：使用 legacy renderServer 导出（建议迁移到 render）`);
        return resolvedFactory.factory as LegacyRenderServerFunction;
      } catch (importError) {
        this.logger.debug(`   加载失败 ${relativePath}:`, (importError as Error).message);
        // 继续尝试下一个路径
      }
    }

    this.logger.error('❌ 所有路径加载失败，未找到 renderServer 函数');
    this.logger.error('   已尝试的路径:', possiblePaths);
    return undefined;
  }

  private resolveEntryRenderFunction(
    entryModule: Record<string, unknown>
  ): EntryRenderFactory | null {
    if (typeof entryModule.render === 'function') {
      return {
        needsWrapping: true,
        factory: entryModule.render.bind(entryModule) as EntryRenderFunction,
      };
    }

    if (typeof entryModule.renderServer === 'function') {
      return {
        needsWrapping: false,
        factory: entryModule.renderServer.bind(entryModule) as LegacyRenderServerFunction,
      };
    }

    return null;
  }

  private createRenderServerWrapper(factory: EntryRenderFunction) {
    return async (url: string, context: RenderContext): Promise<RenderResult> => {
      await this.ensureRouteData(url, context);

      if (!context.viteServer && this.viteServer) {
        context.viteServer = this.viteServer;
      }

      context.renderMode = context.requestedRenderMode || context.renderMode || 'ssr';
      context.strategy = context.strategy || 'server';

      const { appElement, helmetContext, rscRuntime } = await factory(url, context);

      if (!appElement) {
        throw new Error('render 函数未返回有效的 React 元素，无法执行 SSR');
      }

      return this.getSSRRenderer().render({
        url,
        context,
        appElement,
        helmetContext: helmetContext || { helmet: undefined },
        rscRuntime,
      });
    };
  }

  private getSSRRenderer(): SSRRenderer {
    if (!this.ssrRenderer) {
      this.ssrRenderer = new SSRRenderer(this.config.dev?.verbose);
    }
    return this.ssrRenderer;
  }

  private async ensureRouteData(url: string, context: RenderContext): Promise<void> {
    if (!context.routeData) {
      context.routeData = await this.fetchRouteData(url, context);
    }
  }

  private async fetchRouteData(
    url: string,
    context: RenderContext
  ): Promise<Record<string, unknown>> {
    try {
      const pathname = new URL(url, 'http://localhost').pathname;

      if (pathname === '/render-test' || pathname === '/') {
        const endpoint = this.getBooksApiEndpoint();
        const startedAt = Date.now();

        this.logger.info(`📡 [RSC] 请求书籍数据: ${endpoint}`);
        const response = await fetch(endpoint, {
          headers: {
            Accept: 'application/json',
          },
          cache: 'no-store',
        });

        this.logger.info(
          `📡 [RSC] 书籍接口响应: ${response.status} ${response.statusText || ''}`.trim()
        );

        if (!response.ok) {
          this.logger.warn(`获取书籍数据失败: ${response.status}`);
          return { books: [] };
        }

        const payload = await response.json();
        if (!Array.isArray(payload?.data)) {
          this.logger.error('书籍接口返回格式不符合最新契约，缺少 data 数组');
          return { books: [] };
        }
        const books = payload.data;

        this.logger.info(
          `📡 [RSC] 书籍数据解析完成: ${books.length} 本书 (耗时 ${Date.now() - startedAt}ms)`
        );

        if (books.length === 0) {
          this.logger.warn('书籍接口返回为空，Flight 组件将呈现空状态');
        } else {
          this.logger.debug(`实时获取书籍数据: ${books.length} 条`);
        }

        return { books };
      }

      return {};
    } catch (error) {
      this.logger.error('获取路由数据失败:', error);
      return {};
    }
  }

  private getBooksApiEndpoint(): string {
    const fallback = 'http://localhost:3001/api/books';
    const rawBase = this.config.apiUrl?.trim();

    try {
      if (!rawBase) {
        return fallback;
      }

      const url = new URL(rawBase);
      const normalizedPath = this.normalizeApiPath(url.pathname);
      url.pathname = normalizedPath + '/books';
      url.search = '';
      url.hash = '';
      return url.toString();
    } catch (error) {
      this.logger.warn(
        `API 基础地址无效 (${rawBase ?? 'undefined'}): ${(error as Error).message}，使用默认 ${fallback}`
      );
      return fallback;
    }
  }

  private normalizeApiPath(pathname: string): string {
    if (!pathname || pathname === '/') {
      return '/api';
    }

    const trimmed = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
    if (trimmed.endsWith('/api')) {
      return trimmed;
    }

    if (trimmed.includes('/api/')) {
      return trimmed.split('/api/')[0] + '/api';
    }

    return `${trimmed}/api`;
  }

  /**
   * 检查是否为静态资源
   */
  private isStaticResource(url: string): boolean {
    return /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot)$/i.test(url);
  }

  /**
   * 检查是否为系统路径(不应被ISR处理)
   */
  private isSystemPath(url: string): boolean {
    const systemPaths = [
      '/.well-known/', // 浏览器/操作系统特殊路径
      '/favicon.ico', // 网站图标
      '/apple-touch-icon', // Apple 设备图标
      '/browserconfig.xml', // Windows 磁贴配置
      '/manifest.json', // PWA manifest
      '/__vite', // Vite 内部路径
      '/@vite', // Vite 内部路径
      '/@fs/', // Vite 文件系统
      '/@id/', // Vite 模块 ID
    ];

    return systemPaths.some(path => url.startsWith(path));
  }

  /**
   * 获取启用的功能
   */
  private getEnabledFeatures(): string[] {
    const features = [];

    if (this.config.enterprise.enabled) features.push('enterprise');
    if (this.config.enterprise.fallbackChain.enabled) features.push('fallback-chain');
    if (this.config.enterprise.cache.multiLayer) features.push('multi-layer-cache');
    if (this.config.enterprise.seo.advanced) features.push('advanced-seo');
    if (this.config.rsc?.enabled) features.push('rsc');
    if (this.config.enterprise.monitoring.detailed) features.push('detailed-monitoring');

    return features;
  }

  /**
   * 更新平均响应时间
   */
  private updateAverageResponseTime(responseTime: number): void {
    const total = this.stats.averageResponseTime * (this.stats.successfulRenders - 1);
    this.stats.averageResponseTime = (total + responseTime) / this.stats.successfulRenders;
  }

  /**
   * 获取统计信息
   */
  getStats(): any {
    return {
      ...this.stats,
      hitRate: this.stats.requests > 0 ? this.stats.cacheHits / this.stats.requests : 0,
      successRate: this.stats.requests > 0 ? this.stats.successfulRenders / this.stats.requests : 0,
      uptime: Date.now() - this.stats.uptime,
    };
  }

  /**
   * 获取默认配置
   */
  private getDefaultConfig(): NovelISRConfig {
    return {
      mode: 'isr',
      server: { port: 3000, host: 'localhost' },
      cache: { strategy: 'memory', ttl: 3600 },
      dev: { verbose: false, hmr: true },
      seo: { enabled: true, generateSitemap: true },
    };
  }

  /**
   * 获取默认企业级配置
   */
  private getDefaultEnterpriseConfig() {
    return {
      enabled: true,
      fallbackChain: {
        enabled: true,
        strategies: [
          { name: 'static', priority: 1, timeout: 500, retries: 1 },
          { name: 'cached', priority: 2, timeout: 200, retries: 1 },
          { name: 'regenerate', priority: 3, timeout: 5000, retries: 2 },
          { name: 'server', priority: 4, timeout: 8000, retries: 1 },
          { name: 'client', priority: 5, timeout: 1000, retries: 0 },
        ],
        adaptive: {
          enabled: true,
          learningRate: 0.1,
          performanceThreshold: 3000,
        },
      },
      cache: {
        multiLayer: true,
        compression: true,
        encryption: false,
        analytics: true,
      },
      seo: {
        advanced: true,
        structuredData: true,
        performance: true,
        multiLanguage: true,
      },
      monitoring: {
        detailed: true,
        realtime: false,
        alerts: false,
        dashboard: false,
      },
    };
  }

  /**
   * 关闭引擎
   */
  async shutdown(): Promise<void> {
    this.logger.info('🛑 关闭企业级 ISR 引擎...');

    // 关闭 HTTP 服务器
    if (this.httpServer) {
      await new Promise<void>(resolve => {
        this.httpServer!.close(() => resolve());
      });
    }

    // 关闭 Vite 服务器
    if (this.viteServer) {
      await this.viteServer.close();
    }

    // 关闭企业级模块
    if (this.fallbackChainEngine) {
      await this.fallbackChainEngine.shutdown();
    }
    if (this.enterpriseRSCRuntime) {
      await this.enterpriseRSCRuntime.cleanup();
    }
    if (this.enterpriseSEOEngine) {
      await this.enterpriseSEOEngine.shutdown();
    }
    if (this.enterpriseCacheEngine) {
      await this.enterpriseCacheEngine.shutdown();
    }
    if (this.appShellManager) {
      await this.appShellManager.shutdown();
    }

    // 关闭传统模块
    if (this.cache) {
      await this.cache.shutdown();
    }

    this.logger.info('✅ 企业级 ISR 引擎已关闭');
  }
}

/**
 * 工厂函数：创建企业级 ISR 引擎实例
 */
export function createEnterpriseISREngine(
  config: Partial<EnterpriseISRConfig> = {}
): EnterpriseISREngine {
  return new EnterpriseISREngine(config);
}

type AppRenderPayload = {
  appElement: ReactElement;
  helmetContext?: { helmet?: unknown };
  rscRuntime?: RSCRuntime;
};

type EntryRenderFunction = (url: string, context: RenderContext) => Promise<AppRenderPayload>;

type LegacyRenderServerFunction = (url: string, context: RenderContext) => Promise<RenderResult>;

type EntryRenderFactory =
  | {
      needsWrapping: true;
      factory: EntryRenderFunction;
    }
  | {
      needsWrapping: false;
      factory: LegacyRenderServerFunction;
    };
