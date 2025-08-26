import fs from 'fs';
import path from 'path';

import { Logger } from '../utils/Logger';

/**
 * 静态站点生成模块
 * 处理静态页面的预生成
 */
export class SSGModule {
  private config: Record<string, any>;
  private logger: Logger;
  private staticPages: Map<string, any>;

  constructor(config: Record<string, any>) {
    this.config = config;
    this.logger = new Logger(config.dev?.verbose);
    this.staticPages = new Map();
  }

  async generateStaticPages() {
    this.logger.info('Starting static page generation...');

    try {
      const routes = await this.getRoutesToGenerate();
      const results = await Promise.allSettled(
        routes.map((route: string) => this.generatePage(route))
      );

      const successful = results.filter((r) => r.status === 'fulfilled').length;
      const failed = results.length - successful;

      this.logger.info(
        `SSG completed: ${successful} successful, ${failed} failed`
      );

      // 生成 sitemap
      if (this.config.seo?.generateSitemap !== false) {
        try {
          await this.generateSitemap(
            routes.filter(
              (_: string, i: number) => results[i].status === 'fulfilled'
            )
          );
        } catch (error) {
          this.logger.error('Sitemap generation failed:', error);
          // 在开发环境下不因sitemap失败而中断
          if (process.env.NODE_ENV !== 'production') {
            this.logger.warn('Skipping sitemap generation in development mode');
          } else {
            throw error;
          }
        }
      }

      // 生成 robots.txt
      if (this.config.seo?.generateRobots !== false) {
        await this.generateRobotsTxt();
      }

      return { successful, failed, total: results.length };
    } catch (error) {
      this.logger.error('SSG generation failed:', error);
      throw error;
    }
  }

  async generatePage(route: string) {
    this.logger.debug(`Generating static page: ${route}`);

    try {
      // 在开发模式下，跳过SSG生成，因为没有构建的服务端文件
      if (process.env.NODE_ENV !== 'production') {
        this.logger.warn(`跳过SSG生成 ${route}：开发模式下无需预生成静态页面`);
        return { route, success: true, path: 'skipped-dev-mode' };
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
    const filePath = this.getStaticFilePath(url);

    try {
      if (await this.fileExists(filePath)) {
        const html = await fs.promises.readFile(filePath, 'utf-8');
        return {
          success: true,
          html,
          helmet: null,
          preloadLinks: '',
          statusCode: 200,
          meta: {
            renderMode: 'ssg',
            static: true,
            path: filePath,
            timestamp: Date.now(),
          },
        };
      }

      // If static file doesn't exist, generate it on-demand
      this.logger.warn(
        `Static file not found: ${filePath}, generating on-demand`
      );
      await this.generatePage(url);
      return await this.renderStatic(url, context);
    } catch (error) {
      this.logger.error(`Failed to serve static page ${url}:`, error);
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
    return path.resolve(serverPath, 'entry-server.js');
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
