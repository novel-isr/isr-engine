import { Server } from 'http';

import compression from 'compression';
import express, { Express, Request, Response } from 'express';
import {
  createServer as createViteServer,
  ViteDevServer,
  build as viteBuild,
} from 'vite';

import { RenderMode } from './RenderMode';
import { CacheManager } from '../cache';
import { CSRFallback } from '../modules/CSRFallback';
import { ISRModule } from '../modules/ISRModule';
import { SEOModule } from '../modules/SEOModule';
import { SSGModule } from '../modules/SSGModule';
import {
  NovelISRConfig,
  RenderResult,
  RenderContext,
  RenderMeta,
} from '../types';
import { Logger } from '../utils/Logger';
import { MetricsCollector } from '../utils/MetricsCollector';

/**
 * 企业级 SSR 引擎
 * 自动降级链: ISR → SSR → CSR
 * 公共 API: 只暴露 SSG 和 ISR 模式
 */
export default class ISREngine {
  private config: NovelISRConfig;
  private renderMode: RenderMode;
  private cache: CacheManager;
  private logger: Logger;
  private metrics: MetricsCollector;
  private csrFallback: CSRFallback;
  private ssgModule: SSGModule;
  private isrModule: ISRModule;
  private seoModule: SEOModule;
  private viteServer?: ViteDevServer;
  private expressApp?: Express;
  private httpServer?: Server;
  private stats: {
    requests: number;
    ssrSuccess: number;
    ssrErrors: number;
    cacheHits: number;
    fallbacks: number;
  };

  constructor(config: NovelISRConfig) {
    this.config = config;
    this.renderMode = new RenderMode(config.mode || 'isr', config);
    this.cache = new CacheManager(config.cache || {});
    this.logger = new Logger(config.dev?.verbose);
    this.metrics = new MetricsCollector();

    // 初始化模块
    this.csrFallback = new CSRFallback(config);
    this.ssgModule = new SSGModule(config);
    this.isrModule = new ISRModule(config);
    this.seoModule = new SEOModule(config.seo || {});

    this.stats = {
      requests: 0,
      ssrSuccess: 0,
      ssrErrors: 0,
      cacheHits: 0,
      fallbacks: 0,
    };
  }

  /**
   * 初始化 ISR 引擎
   */
  async initialize(): Promise<void> {
    try {
      this.logger.info('正在初始化 ISR 引擎...');

      // 初始化缓存
      try {
        await this.cache.initialize();
        this.logger.debug('缓存系统初始化成功');
      } catch (error) {
        this.logger.error('缓存系统初始化失败:', error);
        throw new Error(`缓存初始化失败: ${(error as Error).message}`);
      }

      // 在开发模式下初始化 Vite 服务器
      if (process.env.NODE_ENV !== 'production') {
        try {
          await this.initializeViteServer();
          this.logger.debug('Vite 服务器初始化成功');
          
          // 将 Vite 服务器实例传递给 ISR 模块
          if (this.viteServer) {
            (this.isrModule as any).setViteServer(this.viteServer);
            (this.isrModule as any).setMetricsCollector(this.metrics);
          }
        } catch (error) {
          this.logger.error(
            'Vite 服务器初始化失败，将使用生产模式渲染:',
            error
          );
          // 在开发模式下 Vite 失败时，不抛出错误，而是降级到生产模式渲染
        }
      }

      // 初始化 SEO 模块
      try {
        await this.seoModule.initialize();
        this.logger.debug('SEO 模块初始化成功');
      } catch (error) {
        this.logger.warn('SEO 模块初始化失败，SEO 功能将被禁用:', error);
        // SEO 模块失败不应该阻止整个引擎启动
      }

      // Pre-generate static pages if needed
      const hasSSGRoutes = this.hasSSGRoutes();
      if (hasSSGRoutes) {
        try {
          await this.ssgModule.generateStaticPages();
          this.logger.debug('静态页面预生成完成');
        } catch (error) {
          this.logger.error('静态页面预生成失败:', error);
          // 在开发模式下，SSG失败不应该阻止引擎启动
          if (process.env.NODE_ENV !== 'production') {
            this.logger.warn('开发模式下跳过SSG预生成失败，引擎将继续启动');
          } else {
            throw new Error(`SSG 预生成失败: ${(error as Error).message}`);
          }
        }
      } else {
        this.logger.debug('无SSG路由，跳过静态页面预生成');
      }

      this.logger.info(`✅ ISR Engine 初始化完成 (模式: ${this.config.mode})`);
    } catch (error) {
      this.logger.error('❌ ISR Engine 初始化失败:', error);
      throw error;
    }
  }

  async render(
    url: string,
    context: RenderContext = {}
  ): Promise<RenderResult> {
    this.stats.requests++;
    const startTime = Date.now();
    const renderMode = context.renderMode || 'isr';
    const strategy = context.strategy || 'auto';
    
    // 开始指标收集
    const metricsId = this.metrics.startRender(url, renderMode, strategy);

    try {
      this.logger.debug(`Rendering: ${url}`);

      // Check cache first (但SSR模式应该跳过缓存)
      const shouldUseCache = context.renderMode !== 'ssr' && context.strategy !== 'server';
      
      if (shouldUseCache) {
        const cacheKey = this.generateCacheKey(url, context);
        const cached = await this.cache.get(cacheKey);

        if (cached && !this.shouldBypassCache(url, context)) {
          this.stats.cacheHits++;
          this.logger.debug(`Cache hit for: ${url}`);
          return this.createRenderResult(cached, { fromCache: true });
        }
      } else {
        this.logger.debug(`跳过缓存检查: ${context.renderMode} 模式不使用缓存`);
      }

      // Enterprise-level automatic fallback rendering
      const result = await this.renderWithFallback(url, context);

      // Cache the result if successful (ISR handles its own caching, SSR不缓存)
      if (result.success && result.html && !result.meta.skipCache && shouldUseCache) {
        const cacheKey = this.generateCacheKey(url, context);
        await this.cache.set(cacheKey, result, this.getCacheTTL(url));
        this.logger.debug(`结果已缓存: ${url}`);
      } else if (!shouldUseCache) {
        this.logger.debug(`跳过结果缓存: ${context.renderMode} 模式不使用缓存`);
      }

      this.stats.ssrSuccess++;
      const renderTime = Date.now() - startTime;
      
      // 添加渲染时间到结果元数据
      if (result.meta) {
        result.meta.renderTime = renderTime;
      }
      
      // 记录成功的渲染指标
      this.metrics.endRender(
        metricsId,
        url,
        result.meta.renderMode as any || renderMode as any,
        result.meta.strategy as any || strategy as any,
        startTime,
        true, // success
        result.statusCode || 200,
        result.html?.length || 0,
        result.meta.fromCache || false,
        undefined, // no error
        result.meta.cacheAge,
        context.userAgent
      );
      
      this.logger.debug(
        `Rendered ${url} in ${renderTime}ms (strategy: ${result.meta.strategy})`
      );

      return result;
    } catch (error) {
      this.stats.ssrErrors++;
      this.logger.error(`Render error for ${url}:`, error);

      // 记录失败的渲染指标
      this.metrics.endRender(
        metricsId,
        url,
        renderMode as any,
        strategy as any,
        startTime,
        false, // success = false
        500, // error status code
        0, // no content length
        false, // not from cache
        (error as Error).message,
        undefined, // no cache age
        context.userAgent
      );

      if (this.config.errorHandling?.enableFallback) {
        this.stats.fallbacks++;
        return await this.handleRenderError(url, context, error as Error);
      }

      throw error;
    }
  }

  /**
   * Enterprise automatic fallback rendering
   * Handles ISR → SSR → CSR fallback chain transparently
   */
  async renderWithFallback(
    url: string,
    context: RenderContext
  ): Promise<RenderResult> {
    let fallbackChain = this.renderMode.getFallbackChain(url);
    let lastError = null;

    // 支持查询参数强制指定渲染策略
    if (context.forceMode) {
      console.log(`🎯 强制渲染模式: ${context.forceMode.toUpperCase()}`);
      fallbackChain = this.getForcedFallbackChain(context.forceMode, context.forceFallback);
    }

    // 支持单独测试特定策略
    if (context.forceFallback) {
      console.log(`🎯 强制降级策略: ${context.forceFallback.toUpperCase()}`);
      fallbackChain = [context.forceFallback];
    }

    console.log(`📋 降级链: ${fallbackChain.join(' → ')}`);

    for (const strategy of fallbackChain) {
      try {
        const strategyText = {
          'static': 'SSG静态文件',
          'cached': 'ISR缓存',
          'regenerate': 'ISR重新生成',
          'server': 'SSR实时渲染',
          'client': 'CSR客户端渲染'
        }[strategy] || strategy;
        
        this.logger.debug(`🔄 正在尝试策略: ${strategyText} (${strategy}) - ${url}`);
        console.log(`🎯 ISR引擎策略: ${strategyText} | 路径: ${url}`);

        let result;
        switch (strategy) {
          case 'static':
            console.log('📄 执行 SSG 静态文件服务...');
            result = await this.renderStatic(url, context);
            break;
          case 'cached':
            console.log('💾 检查 ISR 缓存...');
            result = await this.isrModule.serveCached(url, context);
            break;
          case 'regenerate':
            console.log('🔄 执行 ISR 增量重新生成...');
            // 在开发模式下，传递Vite服务器实例给ISR模块
            const isrContext = {
              ...context,
              renderMode: 'isr',
              strategy: 'regenerate',
              viteServer:
                process.env.NODE_ENV !== 'production'
                  ? this.viteServer
                  : undefined,
            };
            result = await this.isrModule.regenerate(url, isrContext);
            break;
          case 'server':
            console.log('⚡ 执行 SSR 实时服务端渲染...');
            result = await this.renderServer(url, { ...context, renderMode: 'ssr', strategy: 'server' });
            break;
          case 'client':
            console.log('🌐 降级到 CSR 客户端渲染...');
            result = await this.renderCSR(url, { ...context, renderMode: 'csr', strategy: 'client' });
            break;
          default:
            throw new Error(`Unknown strategy: ${strategy}`);
        }

        // Add strategy info to result
        if (result && 'meta' in result && result.meta) {
          result.meta.strategy = strategy;
          result.meta.fallbackUsed = fallbackChain.indexOf(strategy) > 0;
        }

        console.log(`✅ 策略成功: ${strategyText} | 路径: ${url} | 是否降级: ${fallbackChain.indexOf(strategy) > 0 ? '是' : '否'}`);
        return result as RenderResult;
      } catch (error) {
        lastError = error;
        const strategyText = {
          'static': 'SSG静态文件',
          'cached': 'ISR缓存',
          'regenerate': 'ISR重新生成',
          'server': 'SSR实时渲染',
          'client': 'CSR客户端渲染'
        }[strategy] || strategy;
        
        console.log(`❌ 策略失败: ${strategyText} | 路径: ${url} | 错误: ${(error as any)?.message || error}`);
        this.logger.warn(
          `Strategy ${strategy} failed for ${url}: ${(error as any)?.message || error}`
        );

        // 移除特例处理 - 严格按照降级链顺序执行

        // If this isn't the last strategy, continue to next
        if (strategy !== fallbackChain[fallbackChain.length - 1]) {
          continue;
        }

        // Last strategy failed, throw error
        throw lastError;
      }
    }

    throw new Error('All rendering strategies failed');
  }

  async renderStatic(
    url: string,
    context: RenderContext
  ): Promise<RenderResult> {
    try {
      const result = await this.ssgModule.renderStatic(url, context);
      return result as RenderResult;
    } catch (error) {
      // 在开发模式下，SSG 可能不可用，抛出错误让降级链继续
      console.log(`⚠️ SSG 渲染失败，将继续降级链: ${(error as Error).message}`);
      throw error;
    }
  }

  async renderCSR(url: string, context: RenderContext): Promise<RenderResult> {
    this.logger.debug(`Falling back to CSR for: ${url}`);
    const result = await this.csrFallback.render(url, context);
    return result as RenderResult;
  }

  async handleRenderError(
    url: string,
    context: RenderContext,
    error: Error
  ): Promise<RenderResult> {
    this.logger.warn(`Falling back to CSR for: ${url}`);

    try {
      const result = await this.csrFallback.render(url, context, error);
      return result as RenderResult;
    } catch (fallbackError) {
      this.logger.error('Fallback also failed:', fallbackError);

      return this.createRenderResult(
        {
          success: false,
          html: this.getErrorPageHTML(error),
          helmet: null,
          preloadLinks: '',
          statusCode: 500,
          meta: {
            renderMode: 'error',
            timestamp: Date.now(),
            error: true,
            fallback: true,
          },
        },
        {
          error: true,
          fallback: true,
        }
      );
    }
  }

  createRenderResult(
    data: Partial<RenderResult>,
    meta: Partial<RenderMeta> = {}
  ): RenderResult {
    return {
      success: data.success !== undefined ? data.success : !meta.error,
      html: data.html || '',
      helmet: data.helmet,
      preloadLinks: data.preloadLinks || '',
      statusCode: data.statusCode || 200,
      meta: {
        renderMode: this.config.mode || 'unknown',
        timestamp: Date.now(),
        strategy: meta.strategy || 'unknown',
        fallbackUsed: meta.fallbackUsed || false,
        skipCache: meta.strategy === 'cached' || meta.strategy === 'regenerate', // ISR handles its own caching
        ...meta,
      },
    };
  }

  generateCacheKey(url: string, context: RenderContext): string {
    const base = `ssr:${url}`;
    const contextHash = this.hashObject(context);
    return contextHash ? `${base}:${contextHash}` : base;
  }

  hashObject(obj: Record<string, any>): string {
    if (!obj || Object.keys(obj).length === 0) return '';
    return Buffer.from(JSON.stringify(obj)).toString('base64');
  }

  shouldBypassCache(url: string, context: RenderContext): boolean {
    if (this.config.dev?.hmr) return true;
    if (context.bypassCache) return true;
    if (url.includes('no-cache')) return true;
    return false;
  }

  getCacheTTL(url: string): number {
    // Different TTL for different routes
    if (url === '/') return (this.config.cache?.ttl || 3600) * 2;
    if (url.startsWith('/api/')) return 300; // 5 minutes for API routes
    return this.config.cache?.ttl || 3600;
  }

  getServerEntryPath(): string {
    return `${this.config.paths?.server || 'dist/server'}/entry.js`;
  }

  getErrorPageHTML(error: Error): string {
    return `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Server Error</title>
          <meta charset="utf-8">
        </head>
        <body>
          <div id="root">
            <h1>Server Error</h1>
            <p>Something went wrong. Please try again later.</p>
            ${this.config.dev?.verbose ? `<pre>${error.stack}</pre>` : ''}
          </div>
          <script>
            // Enable client-side routing as fallback
            window.__SSR_ERROR__ = true;
          </script>
        </body>
      </html>
    `;
  }

  /**
   * 检查是否有任何路由使用SSG模式
   */
  private hasSSGRoutes(): boolean {
    if (!this.config.routes) return false;

    return Object.values(this.config.routes).some((mode) => mode === 'ssg');
  }

  /**
   * 根据强制模式获取降级链
   */
  private getForcedFallbackChain(forceMode: string, forceFallback?: string): string[] {
    // 如果指定了具体的降级策略，只使用该策略
    if (forceFallback) {
      return [forceFallback];
    }

    // 根据强制模式返回对应的降级链
    switch (forceMode.toLowerCase()) {
      case 'ssg':
        return ['static', 'client'];
      case 'isr':
        return ['cached', 'regenerate', 'server', 'client'];
      case 'ssr':
        return ['server', 'client'];
      case 'csr':
        return ['client'];
      default:
        console.warn(`⚠️ 未知的强制模式: ${forceMode}，使用默认ISR降级链`);
        return ['cached', 'regenerate', 'server', 'client'];
    }
  }

  getStats() {
    return {
      ...this.stats,
      cacheHitRate:
        this.stats.requests > 0
          ? ((this.stats.cacheHits / this.stats.requests) * 100).toFixed(2) +
            '%'
          : '0%',
      successRate:
        this.stats.requests > 0
          ? ((this.stats.ssrSuccess / this.stats.requests) * 100).toFixed(2) +
            '%'
          : '0%',
    };
  }

  /**
   * 初始化 Vite 开发服务器
   */
  private async initializeViteServer(): Promise<void> {
    try {
      this.logger.info('正在初始化 Vite 开发服务器...');

      // 查找项目根目录的 vite 配置
      const projectRoot = process.cwd();

      // 检查是否存在 vite 配置文件
      const fs = await import('fs');
      const path = await import('path');
      const configFiles = [
        'vite.config.ts',
        'vite.config.js',
        'vite.config.mjs',
      ];
      const hasViteConfig = configFiles.some((file) =>
        fs.existsSync(path.resolve(projectRoot, file))
      );

      if (!hasViteConfig) {
        this.logger.warn('未找到 Vite 配置文件，使用默认配置');
      }

      // 检查是否存在统一入口文件
      const entryPath = path.resolve(projectRoot, 'src/entry.tsx');
      
      if (fs.existsSync(entryPath)) {
        this.logger.info(`✅ 使用统一入口文件: ${entryPath}`);
      } else {
        this.logger.error(`未找到必需的入口文件: ${entryPath}`);
        this.logger.error('请创建 src/entry.tsx 文件作为应用入口');
        throw new Error(`入口文件不存在: ${entryPath}`);
      }

      this.viteServer = await createViteServer({
        root: projectRoot,
        server: {
          middlewareMode: true,
          hmr: this.config.dev?.hmr !== false,
        },
        appType: 'custom',
        ssr: {
          noExternal: ['@novel-isr/engine'],
        },
        // 添加更多容错配置
        optimizeDeps: {
          force: false,
        },
        clearScreen: false,
        logLevel: this.config.dev?.verbose ? 'info' : 'warn',
      });
      
      // 将 Vite 服务器实例保存到全局变量，供 SSG 模块使用
      (global as any).__viteServer = this.viteServer;

      this.logger.info('✅ Vite 开发服务器初始化完成');
    } catch (error) {
      this.logger.error('❌ Vite 服务器初始化失败:', error);

      // 提供更详细的错误信息
      if ((error as any)?.message?.includes('Could not resolve')) {
        this.logger.error('可能的解决方案:');
        this.logger.error('1. 检查 vite.config.ts 中的 import 路径是否正确');
        this.logger.error('2. 确保所有依赖都已安装');
        this.logger.error('3. 尝试删除 node_modules 并重新安装');
      }

      throw error;
    }
  }

  /**
   * 获取 Vite SSR 模块
   */
  public async getViteSSRModule(): Promise<{
    render: (url: string, context?: any) => Promise<any>;
  }> {
    if (!this.viteServer) {
      throw new Error('Vite 服务器未初始化');
    }

    try {
      // 加载统一入口文件
      const entryModule = await this.viteServer.ssrLoadModule('/src/entry.tsx');
      
      if (entryModule.renderServer) {
        return { render: entryModule.renderServer };
      } else if (entryModule.render) {
        return { render: entryModule.render };
      } else {
        throw new Error('统一入口文件必须导出renderServer或render函数');
      }
    } catch (error) {
      this.logger.error('加载统一入口文件失败:', error);
      throw error;
    }
  }

  /**
   * 使用 Vite 进行生产构建
   */
  public async buildWithVite(): Promise<void> {
    this.logger.info('正在使用 Vite 进行生产构建...');

    try {
      // 构建客户端 - 设置环境变量
      process.env.BUILD_TARGET = 'client';
      await viteBuild({
        build: {
          outDir: 'dist/client',
          manifest: true,
          ssrManifest: true,
        },
      });

      // 构建服务端 - 设置环境变量
      process.env.BUILD_TARGET = 'server';
      await viteBuild({
        build: {
          ssr: true,
          outDir: 'dist/server',
          rollupOptions: {
            input: './src/entry.tsx',
          },
        },
      });

      // 清除环境变量
      delete process.env.BUILD_TARGET;

      this.logger.info('✅ Vite 构建完成');
    } catch (error) {
      this.logger.error('Vite 构建失败:', error);
      throw error;
    }
  }

  /**
   * 渲染服务端 (使用 Vite)
   */
  async renderServer(
    url: string,
    context: RenderContext
  ): Promise<RenderResult> {
    try {
      let renderModule;

      if (process.env.NODE_ENV === 'production') {
        // 生产模式：加载构建后的模块
        try {
          const serverEntryPath = this.getServerEntryPath();
          this.logger.debug(`加载服务端入口: ${serverEntryPath}`);
          const { render } = await import(serverEntryPath);
          renderModule = { render };
        } catch (error) {
          this.logger.error('加载服务端入口文件失败:', error);
          throw new Error(
            `服务端入口文件加载失败: ${(error as Error).message}`
          );
        }
      } else {
        // 开发模式：使用 Vite 热重载
        if (!this.viteServer) {
          this.logger.warn('Vite 服务器未初始化，尝试加载生产模式入口文件');
          try {
            const serverEntryPath = this.getServerEntryPath();
            const { render } = await import(serverEntryPath);
            renderModule = { render };
          } catch (error) {
            throw new Error('Vite 服务器未初始化且无法加载生产模式入口文件');
          }
        } else {
          try {
            renderModule = await this.getViteSSRModule();
          } catch (error) {
            this.logger.error('Vite SSR 模块加载失败，尝试生产模式:', error);
            const serverEntryPath = this.getServerEntryPath();
            const { render } = await import(serverEntryPath);
            renderModule = { render };
          }
        }
      }

      if (!renderModule || typeof renderModule.render !== 'function') {
        throw new Error('渲染函数未找到或不是有效的函数');
      }

      this.logger.debug(`开始渲染页面: ${url}`);
      const result = await renderModule.render(url, context);

      if (!result || !result.html) {
        throw new Error('渲染结果无效：缺少 HTML 内容');
      }

      this.stats.ssrSuccess++;
      this.logger.debug(`页面渲染成功: ${url} (${result.html.length} 字符)`);

      return this.createRenderResult(result, {
        renderMode: 'ssr',
        timestamp: Date.now(),
        viteHMR: process.env.NODE_ENV !== 'production' && !!this.viteServer,
      });
    } catch (error) {
      this.logger.error(`❌ 服务端渲染失败 ${url}:`, error);
      this.stats.ssrErrors++;
      throw error;
    }
  }

  /**
   * 启动 Express 服务器
   */
  async start(): Promise<Server> {
    await this.initialize();

    // 创建 Express 应用
    this.expressApp = express();

    // 配置中间件
    await this.setupMiddleware();

    // 配置路由
    this.setupRoutes();

    // 启动 HTTP 服务器
    const port = this.config.server?.port || 3000;
    const host = this.config.server?.host || 'localhost';

    return new Promise((resolve, reject) => {
      this.httpServer = this.expressApp!.listen(port, host, () => {
        this.logger.info(`🚀 服务器启动成功: http://${host}:${port}`);
        resolve(this.httpServer!);
      });

      this.httpServer.on('error', (error) => {
        this.logger.error('服务器启动失败:', error);
        reject(error);
      });
    });
  }

  /**
   * 设置 Express 中间件
   */
  private async setupMiddleware(): Promise<void> {
    if (!this.expressApp) return;

    // 启用 gzip 压缩
    if (this.config.compression !== false) {
      this.expressApp.use(compression());
    }

    // 解析 JSON 请求体
    this.expressApp.use(express.json());
    this.expressApp.use(express.urlencoded({ extended: true }));

    // 设置安全头
    this.expressApp.use((req: Request, res: Response, next) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('X-XSS-Protection', '1; mode=block');
      res.setHeader('X-Powered-By', 'Novel-ISR-Engine');
      next();
    });

    // 在开发模式下集成 Vite 中间件
    if (process.env.NODE_ENV !== 'production' && this.viteServer) {
      this.expressApp.use(this.viteServer.middlewares);
    }

    // 静态文件服务
    if (process.env.NODE_ENV === 'production') {
      const staticPath = this.config.paths?.client || './dist';
      this.expressApp.use(express.static(staticPath));
    }
  }

  /**
   * 设置路由
   */
  private setupRoutes(): void {
    if (!this.expressApp) return;

    // 健康检查端点
    this.expressApp.get('/health', (req: Request, res: Response) => {
      res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        stats: this.getStats(),
      });
    });

    // 详细指标端点
    this.expressApp.get('/metrics', (req: Request, res: Response) => {
      const format = req.query.format as string;
      const detailed = req.query.detailed === 'true';
      
      if (detailed) {
        res.json(this.metrics.getDetailedReport());
      } else {
        const stats = this.metrics.getStats();
        
        if (format === 'prometheus') {
          // Prometheus格式输出
          res.set('Content-Type', 'text/plain');
          res.send(this.formatPrometheusMetrics(stats));
        } else {
          res.json(stats);
        }
      }
    });

    // 性能趋势端点
    this.expressApp.get('/metrics/trends', (req: Request, res: Response) => {
      const interval = parseInt(req.query.interval as string) || 5;
      res.json(this.metrics.getPerformanceTrends(interval));
    });

    // 重置指标端点（仅开发模式）
    if (this.config.dev?.verbose) {
      this.expressApp.post('/metrics/reset', (req: Request, res: Response) => {
        this.metrics.reset();
        res.json({ message: '指标已重置', timestamp: new Date().toISOString() });
      });
    }

    // 统计信息端点
    this.expressApp.get('/ssr-stats', (req: Request, res: Response) => {
      res.json(this.getStats());
    });

    // 缓存统计端点
    this.expressApp.get('/cache-stats', (req: Request, res: Response) => {
      res.json(this.cache.getStats());
    });

    // 清理缓存端点
    this.expressApp.post(
      '/cache/clear',
      async (req: Request, res: Response) => {
        try {
          await this.cache.clear();
          res.json({ success: true, message: '缓存已清理' });
        } catch (error) {
          res.status(500).json({
            success: false,
            error: (error as Error).message,
          });
        }
      }
    );

    // 主要的 ISR 路由处理器
    this.expressApp.get('*', async (req: Request, res: Response) => {
      try {
        const url = req.url;
        const cleanUrl = url.split('?')[0]; // 清理后的 URL（用于路由匹配）

        // 跳过 API 路由和静态资源
        if (this.shouldSkipISR(url)) {
          return res.status(404).json({ error: 'Not Found' });
        }

        // 支持查询参数强制指定渲染模式
        const forceMode = req.query.mode as string;
        const forceFallback = req.query.fallback as string;

        console.log(`🌐 请求处理: 原始URL=${url}, 清理URL=${cleanUrl}, 强制模式=${forceMode}, 强制策略=${forceFallback}`);

        const context: RenderContext = {
          userAgent: req.get('User-Agent'),
          acceptLanguage: req.get('Accept-Language'),
          referer: req.get('Referer'),
          bypassCache: req.query.nocache === '1',
          viteHMR: process.env.NODE_ENV !== 'production',
          forceMode, // 强制渲染模式
          forceFallback, // 强制降级策略
          originalUrl: url, // 保存原始 URL
          cleanUrl: cleanUrl, // 保存清理后的 URL
        };

        // 使用清理后的 URL 进行渲染，但保留原始 URL 用于日志和调试
        const result = await this.render(cleanUrl, context);

        if (result && result.html) {
          res.status(result.statusCode || 200);
          res.setHeader('Content-Type', 'text/html; charset=utf-8');

          // 添加 ISR 元信息头
          if (result.meta) {
            res.setHeader('X-ISR-Mode', result.meta.renderMode || 'unknown');
            res.setHeader('X-ISR-Strategy', result.meta.strategy || 'unknown');
            res.setHeader('X-ISR-Timestamp', result.meta.timestamp.toString());

            // 缓存状态头信息
            if (result.meta.fromCache) {
              res.setHeader('X-ISR-Cache', 'HIT');
            } else {
              res.setHeader('X-ISR-Cache', 'MISS');
            }

            // 根据策略设置缓存类型
            switch (result.meta.strategy) {
              case 'cached':
                res.setHeader('X-Cache-Type', 'ISR-Cache');
                res.setHeader('X-Cache-Status', result.meta.fromCache ? 'HIT' : 'REGENERATED');
                if (result.meta.cacheAge) {
                  res.setHeader('X-Cache-Age', Math.floor(result.meta.cacheAge / 1000).toString() + 's');
                }
                break;
              case 'regenerate':
                res.setHeader('X-Cache-Type', 'ISR-Regenerate');
                res.setHeader('X-Cache-Status', 'REGENERATED');
                break;
              case 'static':
                res.setHeader('X-Cache-Type', 'SSG-Static');
                res.setHeader('X-Cache-Status', 'STATIC-FILE');
                break;
              case 'server':
                res.setHeader('X-Cache-Type', 'No-Cache');
                res.setHeader('X-Cache-Status', 'REAL-TIME');
                break;
              case 'client':
                res.setHeader('X-Cache-Type', 'CSR-Fallback');
                res.setHeader('X-Cache-Status', 'CLIENT-SIDE');
                break;
              default:
                res.setHeader('X-Cache-Type', 'Unknown');
                res.setHeader('X-Cache-Status', 'UNKNOWN');
            }

            // 添加详细的缓存信息
            if (result.meta.needsRevalidation !== undefined) {
              res.setHeader('X-Cache-Needs-Revalidation', result.meta.needsRevalidation.toString());
            }
            if (result.meta.contentLength) {
              res.setHeader('X-Content-Length', result.meta.contentLength.toString());
            }

            if (result.meta.fallbackUsed) {
              res.setHeader('X-ISR-Fallback', 'true');
            }

            // 添加渲染时间信息
            if (result.meta.renderTime) {
              res.setHeader('X-Render-Time', result.meta.renderTime.toString() + 'ms');
            }
          }

          res.send(result.html);
        } else {
          res.status(500).send('渲染失败');
        }
      } catch (error) {
        this.logger.error(`路由处理错误 ${req.url}:`, error);
        res.status(500).send('服务器内部错误');
      }
    });
  }

  /**
   * 格式化Prometheus指标
   */
  private formatPrometheusMetrics(stats: any): string {
    const timestamp = Date.now();
    return `
# HELP isr_requests_total Total number of requests
# TYPE isr_requests_total counter
isr_requests_total ${stats.totalRequests} ${timestamp}

# HELP isr_successful_renders_total Total number of successful renders
# TYPE isr_successful_renders_total counter
isr_successful_renders_total ${stats.successfulRenders} ${timestamp}

# HELP isr_failed_renders_total Total number of failed renders
# TYPE isr_failed_renders_total counter
isr_failed_renders_total ${stats.failedRenders} ${timestamp}

# HELP isr_cache_hits_total Total number of ISR cache hits
# TYPE isr_cache_hits_total counter
isr_cache_hits_total ${stats.isrCacheHits} ${timestamp}

# HELP isr_regenerations_total Total number of ISR regenerations
# TYPE isr_regenerations_total counter
isr_regenerations_total ${stats.isrRegenerations} ${timestamp}

# HELP isr_ssr_renders_total Total number of SSR renders
# TYPE isr_ssr_renders_total counter
isr_ssr_renders_total ${stats.ssrRenders} ${timestamp}

# HELP isr_ssg_serves_total Total number of SSG serves
# TYPE isr_ssg_serves_total counter
isr_ssg_serves_total ${stats.ssgServes} ${timestamp}

# HELP isr_csr_fallbacks_total Total number of CSR fallbacks
# TYPE isr_csr_fallbacks_total counter
isr_csr_fallbacks_total ${stats.csrFallbacks} ${timestamp}

# HELP isr_render_duration_ms Average render duration in milliseconds
# TYPE isr_render_duration_ms gauge
isr_render_duration_ms ${stats.averageRenderTime} ${timestamp}

# HELP isr_max_render_duration_ms Maximum render duration in milliseconds
# TYPE isr_max_render_duration_ms gauge
isr_max_render_duration_ms ${stats.maxRenderTime} ${timestamp}

# HELP isr_min_render_duration_ms Minimum render duration in milliseconds
# TYPE isr_min_render_duration_ms gauge
isr_min_render_duration_ms ${stats.minRenderTime === Infinity ? 0 : stats.minRenderTime} ${timestamp}

# HELP isr_concurrent_requests Current number of concurrent requests
# TYPE isr_concurrent_requests gauge
isr_concurrent_requests ${stats.currentConcurrentRequests} ${timestamp}

# HELP isr_max_concurrent_requests Maximum number of concurrent requests
# TYPE isr_max_concurrent_requests gauge
isr_max_concurrent_requests ${stats.maxConcurrentRequests} ${timestamp}

# HELP isr_timeout_errors_total Total number of timeout errors
# TYPE isr_timeout_errors_total counter
isr_timeout_errors_total ${stats.timeoutErrors} ${timestamp}

# HELP isr_render_errors_total Total number of render errors
# TYPE isr_render_errors_total counter
isr_render_errors_total ${stats.renderErrors} ${timestamp}
`.trim();
  }

  /**
   * 判断是否应该跳过 ISR 处理
   */
  private shouldSkipISR(url: string): boolean {
    // API 路由
    if (url.startsWith('/api/') || url.startsWith('/_')) {
      return true;
    }

    // 静态资源
    const staticExtensions = [
      '.js',
      '.css',
      '.scss',
      '.sass',
      '.less',
      '.styl',
      '.stylus',
      '.png',
      '.jpg',
      '.jpeg',
      '.gif',
      '.svg',
      '.ico',
      '.woff',
      '.woff2',
      '.ttf',
      '.eot',
      '.json',
      '.xml',
    ];

    return staticExtensions.some((ext) => url.endsWith(ext));
  }



  async shutdown(): Promise<void> {
    this.logger.info('正在关闭 ISR 引擎...');

    // 关闭 HTTP 服务器
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => {
          this.logger.info('HTTP 服务器已关闭');
          resolve();
        });
      });
    }

    // 关闭 Vite 服务器
    if (this.viteServer) {
      await this.viteServer.close();
      this.logger.info('Vite 服务器已关闭');
    }

    await this.cache.shutdown();
    this.logger.info('ISR 引擎关闭完成');
  }
}
