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

    try {
      this.logger.debug(`Rendering: ${url}`);

      // Check cache first
      const cacheKey = this.generateCacheKey(url, context);
      const cached = await this.cache.get(cacheKey);

      if (cached && !this.shouldBypassCache(url, context)) {
        this.stats.cacheHits++;
        this.logger.debug(`Cache hit for: ${url}`);
        return this.createRenderResult(cached, { fromCache: true });
      }

      // Enterprise-level automatic fallback rendering
      const result = await this.renderWithFallback(url, context);

      // Cache the result if successful (ISR handles its own caching)
      if (result.success && result.html && !result.meta.skipCache) {
        await this.cache.set(cacheKey, result, this.getCacheTTL(url));
      }

      this.stats.ssrSuccess++;
      this.logger.debug(
        `Rendered ${url} in ${Date.now() - startTime}ms (strategy: ${result.meta.strategy})`
      );

      return result;
    } catch (error) {
      this.stats.ssrErrors++;
      this.logger.error(`Render error for ${url}:`, error);

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
    const fallbackChain = this.renderMode.getFallbackChain(url);
    let lastError = null;

    // 在开发模式下，如果Vite服务器不可用，直接使用CSR
    if (process.env.NODE_ENV !== 'production' && !this.viteServer) {
      this.logger.warn(`开发模式下Vite服务器不可用，直接使用CSR渲染: ${url}`);
      return await this.renderCSR(url, context);
    }

    for (const strategy of fallbackChain) {
      try {
        this.logger.debug(`Attempting strategy: ${strategy} for ${url}`);

        let result;
        switch (strategy) {
          case 'static':
            result = await this.renderStatic(url, context);
            break;
          case 'cached':
            result = await this.isrModule.serveCached(url, context);
            break;
          case 'regenerate':
            // 在开发模式下，传递Vite服务器实例给ISR模块
            const isrContext = {
              ...context,
              viteServer:
                process.env.NODE_ENV !== 'production'
                  ? this.viteServer
                  : undefined,
            };
            result = await this.isrModule.regenerate(url, isrContext);
            break;
          case 'server':
            result = await this.renderServer(url, context);
            break;
          case 'client':
            result = await this.renderCSR(url, context);
            break;
          default:
            throw new Error(`Unknown strategy: ${strategy}`);
        }

        // Add strategy info to result
        if (result && 'meta' in result && result.meta) {
          result.meta.strategy = strategy;
          result.meta.fallbackUsed = fallbackChain.indexOf(strategy) > 0;
        }

        return result as RenderResult;
      } catch (error) {
        lastError = error;
        this.logger.warn(
          `Strategy ${strategy} failed for ${url}: ${(error as any)?.message || error}`
        );

        // 在开发模式下，如果ISR/SSR失败，直接降级到CSR
        if (process.env.NODE_ENV !== 'production' && 
            (strategy === 'cached' || strategy === 'regenerate' || strategy === 'server')) {
          this.logger.warn(`开发模式下${strategy}策略失败，直接降级到CSR: ${url}`);
          try {
            return await this.renderCSR(url, context);
          } catch (csrError) {
            this.logger.error(`CSR降级也失败: ${csrError}`);
            // 继续尝试其他策略
          }
        }

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
    const result = await this.ssgModule.renderStatic(url, context);
    return result as RenderResult;
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
    return `${this.config.paths?.server || 'dist/server'}/entry-server.js`;
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

      // 检查是否存在 src/entry-server.tsx
      const entryServerPath = path.resolve(projectRoot, 'src/entry-server.tsx');
      if (!fs.existsSync(entryServerPath)) {
        this.logger.warn(`未找到服务端入口文件: ${entryServerPath}`);
        this.logger.warn('将创建默认的服务端入口文件');
        
        // 创建默认的服务端入口文件
        await this.createDefaultServerEntry(entryServerPath);
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
      // 在开发模式下使用 Vite 的 SSR 加载
      const { render } = await this.viteServer.ssrLoadModule(
        '/src/entry-server.tsx'
      );
      return { render };
    } catch (error) {
      this.logger.error('加载 Vite SSR 模块失败:', error);
      throw error;
    }
  }

  /**
   * 使用 Vite 进行生产构建
   */
  public async buildWithVite(): Promise<void> {
    this.logger.info('正在使用 Vite 进行生产构建...');

    try {
      // 构建客户端
      await viteBuild({
        build: {
          outDir: 'dist/client',
          ssrManifest: true,
        },
      });

      // 构建服务端
      await viteBuild({
        build: {
          ssr: true,
          outDir: 'dist/server',
          rollupOptions: {
            input: '/src/entry-server.tsx',
          },
        },
      });

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
      const staticPath = this.config.paths?.client || './dist/client';
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

        // 跳过 API 路由和静态资源
        if (this.shouldSkipISR(url)) {
          return res.status(404).json({ error: 'Not Found' });
        }

        const context: RenderContext = {
          userAgent: req.get('User-Agent'),
          acceptLanguage: req.get('Accept-Language'),
          referer: req.get('Referer'),
          bypassCache: req.query.nocache === '1',
          viteHMR: process.env.NODE_ENV !== 'production',
        };

        const result = await this.render(url, context);

        if (result && result.html) {
          res.status(result.statusCode || 200);
          res.setHeader('Content-Type', 'text/html; charset=utf-8');

          // 添加 ISR 元信息头
          if (result.meta) {
            res.setHeader('X-ISR-Mode', result.meta.renderMode || 'unknown');
            res.setHeader('X-ISR-Strategy', result.meta.strategy || 'unknown');
            res.setHeader('X-ISR-Timestamp', result.meta.timestamp.toString());

            if (result.meta.fromCache) {
              res.setHeader('X-ISR-Cache', 'HIT');
            }

            if (result.meta.fallbackUsed) {
              res.setHeader('X-ISR-Fallback', 'true');
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

  /**
   * 创建默认的服务端入口文件
   */
  private async createDefaultServerEntry(entryPath: string): Promise<void> {
    const fs = await import('fs');
    const path = await import('path');
    
    // 确保 src 目录存在
    const srcDir = path.dirname(entryPath);
    if (!fs.existsSync(srcDir)) {
      await fs.promises.mkdir(srcDir, { recursive: true });
    }

    // 检查是否存在 App.tsx 或 App.jsx
    const appFiles = ['App.tsx', 'App.jsx', 'App.js'];
    let appImport = './App';
    let appExists = false;
    
    for (const appFile of appFiles) {
      const appPath = path.resolve(srcDir, appFile);
      if (fs.existsSync(appPath)) {
        appExists = true;
        break;
      }
    }

    // 如果没有 App 组件，创建一个简单的
    if (!appExists) {
      const defaultApp = `import React from 'react';

export default function App() {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '100vh',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", sans-serif'
    }}>
      <div style={{ textAlign: 'center' }}>
        <h1 style={{ color: '#007acc', marginBottom: '1rem' }}>
          🚀 Novel ISR Engine
        </h1>
        <p style={{ color: '#666', marginBottom: '2rem' }}>
          企业级增量静态再生引擎已成功启动！
        </p>
        <div style={{ 
          padding: '1rem', 
          backgroundColor: '#f5f5f5', 
          borderRadius: '8px',
          fontSize: '0.9rem',
          color: '#333'
        }}>
          <p><strong>自动降级链:</strong> ISR → SSR → CSR</p>
          <p><strong>当前模式:</strong> 开发模式</p>
          <p><strong>HMR:</strong> 已启用</p>
        </div>
      </div>
    </div>
  );
}
`;
      const appPath = path.resolve(srcDir, 'App.tsx');
      await fs.promises.writeFile(appPath, defaultApp, 'utf-8');
      this.logger.info(`已创建默认 App 组件: ${appPath}`);
    }

    // 创建客户端入口文件
    const clientEntryPath = path.resolve(srcDir, 'entry-client.tsx');
    if (!fs.existsSync(clientEntryPath)) {
      const defaultClientEntry = `import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}
`;
      await fs.promises.writeFile(clientEntryPath, defaultClientEntry, 'utf-8');
      this.logger.info(`已创建默认客户端入口文件: ${clientEntryPath}`);
    }

    const defaultServerEntry = `import React from 'react';
import { renderToString } from 'react-dom/server';
import App from './App';

export function render(url: string, context?: any) {
  const html = renderToString(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );

  return {
    html: \`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Novel ISR App</title>
</head>
<body>
  <div id="root">\${html}</div>
  <script type="module" src="/src/entry-client.tsx"></script>
</body>
</html>\`,
    statusCode: 200,
    helmet: null,
    preloadLinks: ''
  };
}
`;

    await fs.promises.writeFile(entryPath, defaultServerEntry, 'utf-8');
    this.logger.info(`已创建默认服务端入口文件: ${entryPath}`);
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
