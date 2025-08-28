import fs from 'fs';
import path from 'path';

import { Logger } from '../utils/Logger';
import { UnifiedSSGGenerator, SSGConfig } from './SSGModuleFixed';

/**
 * 静态站点生成模块 - 重构版本
 * 使用统一的 SSG 生成器，解决双实现和开发污染问题
 * 
 * @deprecated 建议使用 SSGManager 获得更好的功能
 */
export class SSGModule {
  private config: Record<string, any>;
  private logger: Logger;
  private staticPages: Map<string, any>;
  private generator: UnifiedSSGGenerator;

  constructor(config: Record<string, any>) {
    this.config = config;
    this.logger = new Logger(config.dev?.verbose);
    this.staticPages = new Map();
    
    // 使用统一的 SSG 生成器
    const ssgConfig: Partial<SSGConfig> = {
      routes: config.ssg?.routes || ['/'],
      outputDir: {
        production: config.paths?.client || 'dist/client',
        development: '.ssg-cache', // 开发时使用独立目录，不污染 dist
      },
      onDemandGeneration: config.ssg?.onDemandGeneration !== false,
      cleanupOldFiles: config.ssg?.cleanupOldFiles || false,
      concurrent: config.ssg?.concurrent || 3,
      caching: {
        enabled: config.ssg?.caching?.enabled !== false,
        ttl: config.ssg?.caching?.ttl || 3600,
      },
    };
    
    this.generator = new UnifiedSSGGenerator(ssgConfig, config.dev?.verbose);
    
    this.logger.info('📦 SSG 模块已升级为统一生成器模式');
    if (process.env.NODE_ENV !== 'production') {
      this.logger.info('🔧 开发模式: 使用独立缓存目录 (.ssg-cache) 避免污染 dist');
    }
  }

  /**
   * 设置渲染函数 - 由ISR引擎调用
   */
  setRenderFunction(renderFunction: (url: string, context: any) => Promise<any>) {
    this.generator.setRenderFunction(renderFunction);
    this.logger.debug('✅ SSG模块: 渲染函数已设置');
  }

  async generateStaticPages() {
    this.logger.info('🚀 开始静态页面生成 (使用统一生成器)...');

    try {
      // 使用统一生成器生成所有页面
      const results = await this.generator.generateAll();

      this.logger.info(
        `✅ SSG 完成: ${results.successful} 成功, ${results.failed} 失败 (总计: ${results.total})`
      );

      return results;
    } catch (error) {
      this.logger.error('❌ SSG 生成失败:', error);
      throw error;
    }
  }



  async generatePage(route: string) {
    this.logger.debug(`Generating static page: ${route}`);

    try {
      // 在开发模式下，使用 Vite SSR 来生成静态页面
      if (process.env.NODE_ENV !== 'production') {
        console.log(`🔄 SSG模块: 开发模式下使用 Vite SSR 生成静态页面 - ${route}`);
        return await this.generatePageWithVite(route);
      }

      // 加载服务端入口
      const serverEntryPath = this.getServerEntryPath();

      // 检查服务端入口文件是否存在
      if (!(await this.fileExists(serverEntryPath))) {
        throw new Error(
          `服务端入口文件不存在: ${serverEntryPath}。请先运行构建命令。`
        );
      }

      const { render } = await import(serverEntryPath);

      // 渲染页面
      const result = await render(route);

      if (!result.html) {
        throw new Error(`No HTML generated for route: ${route}`);
      }

      // 创建完整的 HTML 文档
      const fullHTML = this.createStaticHTML(result, route);

      // 写入文件系统
      const filePath = this.getStaticFilePath(route);
      await this.ensureDirectoryExists(path.dirname(filePath));
      await fs.promises.writeFile(filePath, fullHTML, 'utf-8');

      this.staticPages.set(route, {
        path: filePath,
        size: Buffer.byteLength(fullHTML, 'utf8'),
        generated: Date.now(),
      });

      this.logger.debug(`Generated: ${route} -> ${filePath}`);
      return { route, success: true, path: filePath };
    } catch (error) {
      this.logger.error(`Failed to generate ${route}:`, error);
      throw error;
    }
  }

  async renderStatic(
    url: string,
    context: Record<string, any>
  ): Promise<{
    success: boolean;
    html: string;
    helmet: any;
    preloadLinks: string;
    statusCode: number;
    meta: Record<string, any>;
  }> {
    // 使用统一生成器的按需生成功能
    const cleanUrl = url.split('?')[0];
    
    console.log(`📄 SSG模块: 尝试提供静态页面 - ${cleanUrl} (使用统一生成器)`);

    try {
      const result = await this.generator.generateOnDemand(cleanUrl);
      
      console.log(`✅ SSG模块: 页面已提供 - ${cleanUrl} (来自${result.fromCache ? '缓存' : '新生成'})`);
      
      return {
        success: result.success,
        html: result.html,
        helmet: null, // 统一生成器已经包含在 HTML 中
        preloadLinks: '',
        statusCode: 200,
        meta: {
          ...result.meta,
          fromCache: result.fromCache,
          path: result.path,
          timestamp: Date.now(),
        },
      };
    } catch (error) {
      console.error(`❌ SSG模块: 提供静态页面失败 ${cleanUrl}:`, error);
      this.logger.error(`Static page generation failed ${cleanUrl}:`, error);
      throw error;
    }
  }

  createStaticHTML(renderResult: Record<string, any>, route: string): string {
    const { html, helmet, preloadLinks } = renderResult;

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
  <meta name="generator" content="ISR-Engine SSG">
  <meta name="generated-at" content="${new Date().toISOString()}">
</head>
<body${helmet?.bodyAttributes?.toString() || ''}>
  <div id="root">${html}</div>
  ${helmet?.script?.toString() || ''}
  <script>
    window.__SSG__ = true;
    window.__ROUTE__ = "${route}";
  </script>
</body>
</html>`;
  }

  async getRoutesToGenerate() {
    // Default routes - in a real implementation, this could read from a config file
    const defaultRoutes = ['/', '/about'];

    // Try to load routes from config
    try {
      const configPath = path.join(process.cwd(), 'ssg.config.js');
      if (await this.fileExists(configPath)) {
        const config = await import(configPath);
        return config.routes || defaultRoutes;
      }
    } catch {
      this.logger.debug('No SSG config found, using default routes');
    }

    return defaultRoutes;
  }

  getStaticFilePath(route: string): string {
    const clientPath = this.config.paths?.client || 'dist/client';
    const staticDir = path.resolve(process.cwd(), clientPath);

    if (route === '/') {
      return path.join(staticDir, 'index.html');
    }

    // Handle nested routes
    const cleanRoute = route.replace(/^\/+|\/+$/g, '');
    if (cleanRoute.includes('/')) {
      return path.join(staticDir, cleanRoute, 'index.html');
    }

    return path.join(staticDir, `${cleanRoute}.html`);
  }

  getServerEntryPath(): string {
    const serverPath = this.config.paths?.server || './dist/server';
    return path.resolve(serverPath, 'entry.js');
  }

  async ensureDirectoryExists(dirPath: string): Promise<void> {
    try {
      await fs.promises.access(dirPath);
    } catch {
      await fs.promises.mkdir(dirPath, { recursive: true });
    }
  }

  async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.promises.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async generateSitemap(routes: string[]): Promise<void> {
    const sitemapContent = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${routes
  .map(
    (route: string) => `  <url>
    <loc>${this.config.seo?.baseUrl || 'http://localhost:3000'}${route}</loc>
    <lastmod>${new Date().toISOString()}</lastmod>
    <changefreq>daily</changefreq>
    <priority>${route === '/' ? '1.0' : '0.8'}</priority>
  </url>`
  )
  .join('\n')}
</urlset>`;

    // 使用客户端输出目录，与错误信息中的路径保持一致
    const clientPath = this.config.paths?.client || 'dist/client';
    const sitemapPath = path.resolve(process.cwd(), clientPath, 'sitemap.xml');

    // 确保目录存在
    await this.ensureDirectoryExists(path.dirname(sitemapPath));

    try {
      await fs.promises.writeFile(sitemapPath, sitemapContent, 'utf-8');
      this.logger.info(`Sitemap generated: ${sitemapPath}`);
    } catch (error) {
      this.logger.error(`Failed to generate sitemap: ${error}`);
      // 在开发模式下，sitemap生成失败不应该阻止启动
      if (process.env.NODE_ENV !== 'production') {
        this.logger.warn('开发模式下跳过sitemap生成失败');
        return;
      }
      throw error;
    }
  }

  getGeneratedPages() {
    return Array.from(this.staticPages.entries()).map(
      ([route, info]: [string, any]) => ({
        route,
        ...info,
      })
    );
  }

  async cleanupOldPages(): Promise<void> {
    const clientPath = this.config.paths?.client || 'dist/client';
    const staticDir = path.resolve(process.cwd(), clientPath);

    try {
      // 确保目录存在
      if (!(await this.fileExists(staticDir))) {
        return;
      }

      const files = await fs.promises.readdir(staticDir, { recursive: true });
      const htmlFiles = files.filter((f) => f.endsWith('.html'));

      for (const file of htmlFiles) {
        const fullPath = path.join(staticDir, file);
        const route = this.getRouteFromPath(file);

        if (!this.staticPages.has(route)) {
          await fs.promises.unlink(fullPath);
          this.logger.debug(`Cleaned up old page: ${fullPath}`);
        }
      }
    } catch (error) {
      this.logger.error('Failed to cleanup old pages:', error);
    }
  }

  getRouteFromPath(filePath: string): string {
    if (filePath === 'index.html') return '/';
    return '/' + filePath.replace('.html', '').replace(/\/index$/, '');
  }

  /**
   * 在开发模式下使用 Vite SSR 生成静态页面
   */
  async generatePageWithVite(route: string) {
    console.log(`🔄 SSG模块: 开发模式下生成静态页面 - ${route}`);
    
    try {
      // 获取 Vite 服务器实例
      const viteServer = (global as any).__viteServer;
      if (!viteServer) {
        throw new Error('Vite 服务器不可用');
      }

      // 使用 Vite 的 ssrLoadModule 加载入口文件
      const entryModule = await viteServer.ssrLoadModule('/src/entry.tsx');
      if (!entryModule.renderServer) {
        throw new Error('入口文件没有导出 renderServer 函数');
      }

      // 执行服务端渲染
      const renderResult = await entryModule.renderServer(route, {
        renderMode: 'ssg',
        strategy: 'static',
        isSSG: true, // 标记为SSG模式，避免嵌套HTML
        viteServer,
      });

      if (!renderResult.html) {
        throw new Error(`SSG 渲染失败: 没有生成 HTML`);
      }

      // 在开发模式下，我们将内容写入临时文件以模拟静态文件
      const filePath = this.getStaticFilePath(route);
      await this.ensureDirectoryExists(path.dirname(filePath));
      await fs.promises.writeFile(filePath, renderResult.html, 'utf-8');

      this.staticPages.set(route, {
        path: filePath,
        size: Buffer.byteLength(renderResult.html, 'utf8'),
        generated: Date.now(),
      });

      console.log(`✅ SSG模块: 开发模式静态页面生成完成 ${route} -> ${filePath}`);
      return { route, success: true, path: filePath };
    } catch (error) {
      console.error(`❌ SSG模块: 开发模式生成失败 ${route}:`, error);
      throw error;
    }
  }

  async generateRobotsTxt(): Promise<void> {
    const robotsContent = `User-agent: *
Allow: /

Sitemap: ${this.config.seo?.baseUrl || 'http://localhost:3000'}/sitemap.xml`;

    const clientPath = this.config.paths?.client || 'dist/client';
    const robotsPath = path.resolve(process.cwd(), clientPath, 'robots.txt');

    // 确保目录存在
    await this.ensureDirectoryExists(path.dirname(robotsPath));

    try {
      await fs.promises.writeFile(robotsPath, robotsContent, 'utf-8');
      this.logger.info(`Robots.txt generated: ${robotsPath}`);
    } catch (error) {
      this.logger.error(`Failed to generate robots.txt: ${error}`);
      // 在开发模式下，robots.txt生成失败不应该阻止启动
      if (process.env.NODE_ENV !== 'production') {
        this.logger.warn('开发模式下跳过robots.txt生成失败');
        return;
      }
      throw error;
    }
  }
}
