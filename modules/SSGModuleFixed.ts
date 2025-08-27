/**
 * 修复版的 SSG 模块
 * 解决双实现重复、开发污染 dist 等问题
 */

import fs from 'fs';
import path from 'path';
import { Logger } from '../utils/Logger';

export interface SSGConfig {
  routes: string[] | (() => Promise<string[]>);
  outputDir: {
    production: string;
    development: string;
  };
  onDemandGeneration: boolean;
  cleanupOldFiles: boolean;
  concurrent: number;
  caching: {
    enabled: boolean;
    ttl: number; // seconds
  };
}

export interface SSGGenerationContext {
  route: string;
  mode: 'development' | 'production';
  renderFunction: (url: string, context: any) => Promise<any>;
  outputDir: string;
}

/**
 * 统一的 SSG 生成器 - 解决双实现问题
 */
export class UnifiedSSGGenerator {
  private config: SSGConfig;
  private logger: Logger;
  private generatedPages: Map<string, { path: string; timestamp: number; size: number }> = new Map();
  private renderFunction: ((url: string, context: any) => Promise<any>) | null = null;

  // 缓存机制，避免重复生成
  private generationCache: Map<string, Promise<any>> = new Map();

  constructor(config: Partial<SSGConfig> = {}, verbose = false) {
    this.config = {
      routes: ['/'],
      outputDir: {
        production: 'dist/client',
        development: '.ssg-cache', // 开发时使用独立缓存目录，不污染 dist
      },
      onDemandGeneration: true,
      cleanupOldFiles: false,
      concurrent: 3,
      caching: {
        enabled: true,
        ttl: 3600, // 1小时
      },
      ...config,
    };
    this.logger = new Logger(verbose);
  }

  /**
   * 设置渲染函数 - 统一渲染逻辑
   */
  setRenderFunction(renderFunction: (url: string, context: any) => Promise<any>) {
    this.renderFunction = renderFunction;
  }

  /**
   * 批量生成所有静态页面
   */
  async generateAll(): Promise<{ successful: number; failed: number; total: number }> {
    const routes = await this.getRoutes();
    const mode = process.env.NODE_ENV === 'production' ? 'production' : 'development';
    const outputDir = this.config.outputDir[mode];

    this.logger.info(`🚀 开始 SSG 批量生成 (${mode} 模式): ${routes.length} 个路由`);
    this.logger.info(`📁 输出目录: ${outputDir}`);

    // 清理旧文件（如果启用）
    if (this.config.cleanupOldFiles) {
      await this.cleanupOldFiles(outputDir);
    }

    // 并发生成，控制并发数
    const results = await this.generateConcurrent(routes, {
      mode,
      outputDir,
      concurrent: this.config.concurrent,
    });

    const successful = results.filter(r => r.success).length;
    const failed = results.length - successful;

    this.logger.info(`✅ SSG 批量生成完成: ${successful} 成功, ${failed} 失败`);

    // 生成 sitemap 和 robots.txt
    if (mode === 'production' && successful > 0) {
      const successfulRoutes = results
        .filter(r => r.success)
        .map(r => r.route);
      
      await this.generateSEOFiles(successfulRoutes, outputDir);
    }

    return { successful, failed, total: results.length };
  }

  /**
   * 按需生成单个页面
   */
  async generateOnDemand(route: string): Promise<{
    success: boolean;
    html: string;
    path?: string;
    fromCache: boolean;
    meta: any;
  }> {
    if (!this.config.onDemandGeneration) {
      throw new Error('按需生成已禁用');
    }

    const mode = process.env.NODE_ENV === 'production' ? 'production' : 'development';
    const outputDir = this.config.outputDir[mode];

    // 检查是否正在生成中（防止重复请求）
    const cacheKey = `${mode}:${route}`;
    if (this.generationCache.has(cacheKey)) {
      this.logger.debug(`⏳ 等待正在进行的生成: ${route}`);
      await this.generationCache.get(cacheKey);
    }

    // 检查缓存和文件是否存在
    const cachedResult = await this.checkCache(route, outputDir);
    if (cachedResult) {
      return cachedResult;
    }

    // 开始生成（加锁防止并发）
    const generationPromise = this.generateSinglePage({
      route,
      mode,
      renderFunction: this.renderFunction!,
      outputDir,
    });

    this.generationCache.set(cacheKey, generationPromise);

    try {
      const result = await generationPromise;
      return {
        ...result,
        fromCache: false,
      };
    } finally {
      this.generationCache.delete(cacheKey);
    }
  }

  /**
   * 检查静态文件是否存在且有效
   */
  async checkCache(route: string, outputDir: string): Promise<{
    success: boolean;
    html: string;
    path: string;
    fromCache: boolean;
    meta: any;
  } | null> {
    const filePath = this.getStaticFilePath(route, outputDir);
    const pageInfo = this.generatedPages.get(route);

    try {
      const stats = await fs.promises.stat(filePath);
      const now = Date.now();

      // 检查文件是否在缓存时间内
      if (this.config.caching.enabled && pageInfo) {
        const ageSeconds = (now - pageInfo.timestamp) / 1000;
        if (ageSeconds < this.config.caching.ttl) {
          const html = await fs.promises.readFile(filePath, 'utf-8');
          this.logger.debug(`💾 SSG 缓存命中: ${route} (年龄: ${Math.round(ageSeconds)}s)`);
          
          return {
            success: true,
            html,
            path: filePath,
            fromCache: true,
            meta: {
              renderMode: 'ssg',
              strategy: 'static',
              cached: true,
              fileSize: stats.size,
              lastModified: stats.mtime.toISOString(),
              cacheAge: ageSeconds,
            },
          };
        }
      }

      // 文件存在但缓存过期，仍然返回内容（后台可以重新生成）
      if (await this.fileExists(filePath)) {
        const html = await fs.promises.readFile(filePath, 'utf-8');
        this.logger.debug(`📄 SSG 文件存在但缓存过期: ${route}`);
        
        return {
          success: true,
          html,
          path: filePath,
          fromCache: false, // 标记为非缓存，触发后台重新生成
          meta: {
            renderMode: 'ssg',
            strategy: 'static',
            stale: true,
            fileSize: stats.size,
            lastModified: stats.mtime.toISOString(),
          },
        };
      }
    } catch (error) {
      // 文件不存在或读取失败
    }

    return null;
  }

  /**
   * 并发生成多个页面
   */
  private async generateConcurrent(
    routes: string[],
    context: { mode: 'development' | 'production'; outputDir: string; concurrent: number }
  ): Promise<Array<{ route: string; success: boolean; error?: string }>> {
    const results: Array<{ route: string; success: boolean; error?: string }> = [];
    const chunks = this.chunkArray(routes, context.concurrent);

    for (const chunk of chunks) {
      const chunkPromises = chunk.map(async (route) => {
        try {
          await this.generateSinglePage({
            route,
            mode: context.mode,
            renderFunction: this.renderFunction!,
            outputDir: context.outputDir,
          });
          return { route, success: true };
        } catch (error) {
          this.logger.error(`❌ 生成失败 ${route}:`, error);
          return {
            route,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      });

      const chunkResults = await Promise.all(chunkPromises);
      results.push(...chunkResults);

      // 批次间的小延迟，避免资源耗尽
      if (chunks.length > 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    return results;
  }

  /**
   * 生成单个页面
   */
  private async generateSinglePage(context: SSGGenerationContext): Promise<{
    success: boolean;
    html: string;
    path: string;
    meta: any;
  }> {
    const { route, mode, renderFunction, outputDir } = context;

    if (!renderFunction) {
      throw new Error('渲染函数未设置');
    }

    this.logger.debug(`🔄 生成静态页面: ${route} (${mode})`);

    // 执行渲染
    const renderResult = await renderFunction(route, {
      renderMode: 'ssg',
      strategy: 'static',
      mode,
      isSSG: true,
    });

    if (!renderResult || !renderResult.html) {
      throw new Error(`渲染失败: ${route} - 没有生成 HTML`);
    }

    // 创建完整 HTML 文档
    const fullHTML = this.createStaticHTML(renderResult, route);

    // 写入文件
    const filePath = this.getStaticFilePath(route, outputDir);
    await this.ensureDirectoryExists(path.dirname(filePath));
    await fs.promises.writeFile(filePath, fullHTML, 'utf-8');

    // 记录生成信息
    const pageInfo = {
      path: filePath,
      timestamp: Date.now(),
      size: Buffer.byteLength(fullHTML, 'utf8'),
    };
    this.generatedPages.set(route, pageInfo);

    this.logger.debug(`✅ 生成完成: ${route} -> ${filePath} (${pageInfo.size} bytes)`);

    return {
      success: true,
      html: fullHTML,
      path: filePath,
      meta: {
        renderMode: 'ssg',
        strategy: 'static',
        generated: true,
        timestamp: pageInfo.timestamp,
        size: pageInfo.size,
      },
    };
  }

  /**
   * 获取要生成的路由列表
   */
  private async getRoutes(): Promise<string[]> {
    if (typeof this.config.routes === 'function') {
      return await this.config.routes();
    }
    return this.config.routes;
  }

  /**
   * 获取静态文件路径
   */
  private getStaticFilePath(route: string, outputDir: string): string {
    const resolvedOutputDir = path.resolve(process.cwd(), outputDir);

    if (route === '/') {
      return path.join(resolvedOutputDir, 'index.html');
    }

    const cleanRoute = route.replace(/^\/+|\/+$/g, '');
    
    // 处理嵌套路由
    if (cleanRoute.includes('/')) {
      return path.join(resolvedOutputDir, cleanRoute, 'index.html');
    }

    return path.join(resolvedOutputDir, `${cleanRoute}.html`);
  }

  /**
   * 创建完整的静态 HTML 文档
   */
  private createStaticHTML(renderResult: any, route: string): string {
    const { html, helmet, preloadLinks } = renderResult;
    const now = new Date().toISOString();

    return `<!DOCTYPE html>
<html${helmet?.htmlAttributes?.toString() || ''}>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${helmet?.title?.toString() || '<title>Static Page</title>'}
  ${helmet?.meta?.toString() || ''}
  ${helmet?.link?.toString() || ''}
  ${preloadLinks || ''}
  ${helmet?.style?.toString() || ''}
  <meta name="generator" content="Novel ISR Engine SSG">
  <meta name="generated-at" content="${now}">
  <meta name="ssg-route" content="${route}">
</head>
<body${helmet?.bodyAttributes?.toString() || ''}>
  <div id="root">${html}</div>
  <script>
    window.__SSG__ = true;
    window.__RENDER_STRATEGY__ = 'static';
    window.__ISR_MODE__ = 'ssg';
    window.__ROUTE__ = "${route}";
    window.__GENERATED_AT__ = "${now}";
  </script>
  ${helmet?.script?.toString() || ''}
</body>
</html>`;
  }

  /**
   * 生成 SEO 文件
   */
  private async generateSEOFiles(routes: string[], outputDir: string): Promise<void> {
    const tasks = [];

    // 生成 sitemap.xml
    tasks.push(this.generateSitemap(routes, outputDir));

    // 生成 robots.txt
    tasks.push(this.generateRobotsTxt(outputDir));

    await Promise.all(tasks);
  }

  private async generateSitemap(routes: string[], outputDir: string): Promise<void> {
    const baseUrl = process.env.SITE_BASE_URL || 'http://localhost:3000';
    const sitemapContent = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${routes
  .map(route => `  <url>
    <loc>${baseUrl}${route}</loc>
    <lastmod>${new Date().toISOString()}</lastmod>
    <changefreq>daily</changefreq>
    <priority>${route === '/' ? '1.0' : '0.8'}</priority>
  </url>`)
  .join('\n')}
</urlset>`;

    const sitemapPath = path.join(outputDir, 'sitemap.xml');
    await fs.promises.writeFile(sitemapPath, sitemapContent, 'utf-8');
    this.logger.info(`📄 Sitemap 生成: ${sitemapPath}`);
  }

  private async generateRobotsTxt(outputDir: string): Promise<void> {
    const baseUrl = process.env.SITE_BASE_URL || 'http://localhost:3000';
    const robotsContent = `User-agent: *
Allow: /

Sitemap: ${baseUrl}/sitemap.xml`;

    const robotsPath = path.join(outputDir, 'robots.txt');
    await fs.promises.writeFile(robotsPath, robotsContent, 'utf-8');
    this.logger.info(`🤖 Robots.txt 生成: ${robotsPath}`);
  }

  /**
   * 清理旧文件
   */
  private async cleanupOldFiles(outputDir: string): Promise<void> {
    try {
      if (await this.fileExists(outputDir)) {
        const files = await fs.promises.readdir(outputDir, { recursive: true });
        const htmlFiles = files.filter(f => typeof f === 'string' && f.endsWith('.html'));

        for (const file of htmlFiles) {
          const fullPath = path.join(outputDir, file as string);
          const route = this.getRouteFromPath(file as string);

          if (!this.generatedPages.has(route)) {
            await fs.promises.unlink(fullPath);
            this.logger.debug(`🗑️ 清理旧文件: ${fullPath}`);
          }
        }
      }
    } catch (error) {
      this.logger.warn('清理旧文件失败:', error);
    }
  }

  private getRouteFromPath(filePath: string): string {
    if (filePath === 'index.html') return '/';
    return '/' + filePath.replace('.html', '').replace(/\/index$/, '');
  }

  // 工具函数
  private chunkArray<T>(array: T[], chunkSize: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += chunkSize) {
      chunks.push(array.slice(i, i + chunkSize));
    }
    return chunks;
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.promises.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private async ensureDirectoryExists(dirPath: string): Promise<void> {
    try {
      await fs.promises.access(dirPath);
    } catch {
      await fs.promises.mkdir(dirPath, { recursive: true });
    }
  }

  /**
   * 获取生成统计信息
   */
  getStats() {
    return {
      generatedPages: this.generatedPages.size,
      totalSize: Array.from(this.generatedPages.values())
        .reduce((sum, page) => sum + page.size, 0),
      lastGenerated: Math.max(...Array.from(this.generatedPages.values())
        .map(page => page.timestamp), 0),
      cacheEnabled: this.config.caching.enabled,
      cacheTTL: this.config.caching.ttl,
    };
  }

  /**
   * 清除所有缓存
   */
  async clearCache(): Promise<void> {
    this.generatedPages.clear();
    this.generationCache.clear();
    
    // 清理开发模式的缓存目录
    const devCacheDir = path.resolve(process.cwd(), this.config.outputDir.development);
    try {
      if (await this.fileExists(devCacheDir)) {
        await fs.promises.rm(devCacheDir, { recursive: true, force: true });
        this.logger.info(`🗑️ SSG 开发缓存已清理: ${devCacheDir}`);
      }
    } catch (error) {
      this.logger.warn('清理 SSG 开发缓存失败:', error);
    }
  }
}