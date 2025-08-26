import fs from 'fs';
import path from 'path';

import { Logger } from '../utils/Logger';

/**
 * 增量静态再生模块
 * 处理 ISR 功能和后台重新验证
 */
export class ISRModule {
  private config: Record<string, any>;
  private logger: Logger;
  private revalidationQueue: Set<string>;
  private isRevalidating: Map<string, boolean>;
  private metadataCache: Map<string, any>;
  private viteServer?: any; // ViteDevServer

  constructor(config: Record<string, any>) {
    this.config = config;
    this.logger = new Logger(config.dev?.verbose);
    this.revalidationQueue = new Set();
    this.isRevalidating = new Map();
    this.metadataCache = new Map();
  }

  /**
   * 设置 Vite 服务器实例
   */
  setViteServer(server: any): void {
    this.viteServer = server;
    this.logger.debug('ISR模块已设置 Vite 服务器实例');
  }

  async regenerate(
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
    this.logger.debug(`ISR regenerating: ${url}`);

    try {
      // 检查是否已在重新验证中
      if (this.isRevalidating.get(url)) {
        this.logger.debug(`Already revalidating ${url}, serving stale`);
        return await this.serveCached(url, context);
      }

      this.isRevalidating.set(url, true);

      // 加载服务端入口
      let renderModule;

      if (process.env.NODE_ENV === 'production') {
        // 生产模式：加载构建后的服务端入口
        const serverEntryPath = this.getServerEntryPath();

        // 检查服务端入口文件是否存在
        if (!(await this.fileExists(serverEntryPath))) {
          throw new Error(
            `服务端入口文件不存在: ${serverEntryPath}。请先运行构建命令。`
          );
        }

        const { render } = await import(serverEntryPath);
        renderModule = { render };
      } else {
        // 开发模式：使用Vite的SSR加载
        const viteServer = this.viteServer || context.viteServer;
        if (!viteServer) {
          this.logger.warn('开发模式下Vite服务器不可用，降级到CSR渲染');
          // 直接抛出错误，让上层降级到CSR
          throw new Error('开发模式下无法初始化Vite服务器，请检查配置');
        } else {
          const { render } = await viteServer.ssrLoadModule(
            '/src/entry-server.tsx'
          );
          renderModule = { render };
        }
      }

      // 渲染新内容
      const result = await renderModule.render(url, context.manifest);

      if (result.html) {
        // 保存到 ISR 缓存
        await this.saveToISRCache(url, result);
        this.logger.debug(`ISR cache updated: ${url}`);
      }

      this.isRevalidating.set(url, false);

      return {
        success: true,
        html: result.html,
        helmet: result.helmet,
        preloadLinks: result.preloadLinks || '',
        statusCode: result.statusCode || 200,
        meta: {
          renderMode: 'isr',
          regenerated: true,
          timestamp: Date.now(),
        },
      };
    } catch (error) {
      this.isRevalidating.set(url, false);
      this.logger.error(`ISR regeneration failed for ${url}:`, error);

      // 如果可用，尝试提供缓存版本（但不要再次调用regenerate）
      try {
        const cachedPath = this.getISRCachePath(url);
        if (await this.fileExists(cachedPath)) {
          const html = await fs.promises.readFile(cachedPath, 'utf-8');
          this.logger.warn(`ISR重新生成失败，使用过期缓存: ${url}`);
          return {
            success: true,
            html,
            helmet: null,
            preloadLinks: '',
            statusCode: 200,
            meta: {
              renderMode: 'isr',
              fromCache: true,
              stale: true,
              error: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      } catch (cacheError) {
        this.logger.error(`缓存回退也失败: ${cacheError}`);
      }
      
      // 最后抛出原始错误
      throw error;
    }
  }

  async serveCached(
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
    const cachedPath = this.getISRCachePath(url);
    const metadataPath = this.getISRMetadataPath(url);

    try {
      // Check if cached version exists
      const [htmlExists, metadataExists] = await Promise.all([
        this.fileExists(cachedPath),
        this.fileExists(metadataPath),
      ]);

      if (!htmlExists) {
        // No cached version, generate fresh
        return await this.regenerate(url, context);
      }

      let metadata = {};
      if (metadataExists) {
        const metadataContent = await fs.promises.readFile(
          metadataPath,
          'utf-8'
        );
        metadata = JSON.parse(metadataContent);
      }

      // Check if revalidation is needed
      if (this.shouldRevalidate(url, metadata)) {
        if (this.config.isr?.backgroundRevalidation !== false) {
          // Background revalidation
          this.scheduleBackgroundRevalidation(url, context);
        } else {
          // Blocking revalidation
          this.logger.debug(`需要重新验证，将重新生成: ${url}`);
          return await this.regenerate(url, context);
        }
      }

      // Serve cached content
      const html = await fs.promises.readFile(cachedPath, 'utf-8');

      return {
        success: true,
        html,
        helmet: (metadata as any)?.helmet || null,
        preloadLinks: (metadata as any)?.preloadLinks || '',
        statusCode: (metadata as any)?.statusCode || 200,
        meta: {
          renderMode: 'isr',
          fromCache: true,
          generated: (metadata as any)?.generated,
          needsRevalidation: this.shouldRevalidate(url, metadata),
          timestamp: Date.now(),
        },
      };
    } catch (error) {
      this.logger.error(`Failed to serve ISR cache for ${url}:`, error);
      throw error;
    }
  }

  shouldRevalidate(url: string, metadata: Record<string, any>): boolean {
    if (!metadata.generated) return true;

    const now = Date.now();
    const revalidateTime = this.config.isr.revalidate * 1000;

    return now - metadata.generated > revalidateTime;
  }

  async saveToISRCache(
    url: string,
    renderResult: Record<string, any>
  ): Promise<void> {
    const cachedPath = this.getISRCachePath(url);
    const metadataPath = this.getISRMetadataPath(url);

    try {
      // Ensure cache directory exists
      await this.ensureDirectoryExists(path.dirname(cachedPath));

      // Create full HTML document
      const fullHTML = this.createISRHTML(renderResult, url);

      // Save HTML
      await fs.promises.writeFile(cachedPath, fullHTML, 'utf-8');

      // Save metadata
      const metadata = {
        url,
        generated: Date.now(),
        statusCode: renderResult.statusCode,
        helmet: renderResult.helmet,
        preloadLinks: renderResult.preloadLinks,
        size: Buffer.byteLength(fullHTML, 'utf8'),
      };

      await fs.promises.writeFile(
        metadataPath,
        JSON.stringify(metadata, null, 2),
        'utf-8'
      );

      // Update in-memory cache
      this.metadataCache.set(url, metadata);
    } catch (error) {
      this.logger.error(`Failed to save ISR cache for ${url}:`, error);
      throw error;
    }
  }

  createISRHTML(renderResult: Record<string, any>, url: string): string {
    const { html, helmet, preloadLinks } = renderResult;

    return `<!DOCTYPE html>
<html${helmet?.htmlAttributes?.toString() || ''}>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${helmet?.title?.toString() || '<title>ISR Page</title>'}
  ${helmet?.meta?.toString() || ''}
  ${helmet?.link?.toString() || ''}
  ${preloadLinks || ''}
  ${helmet?.style?.toString() || ''}
  <meta name="generator" content="ISR-Engine ISR">
  <meta name="generated-at" content="${new Date().toISOString()}">
</head>
<body${helmet?.bodyAttributes?.toString() || ''}>
  <div id="root">${html}</div>
  ${helmet?.script?.toString() || ''}
  <script>
    window.__ISR__ = true;
    window.__ROUTE__ = "${url}";
  </script>
</body>
</html>`;
  }

  scheduleBackgroundRevalidation(
    url: string,
    context: Record<string, any>
  ): void {
    if (this.revalidationQueue.has(url) || this.isRevalidating.get(url)) {
      return;
    }

    this.revalidationQueue.add(url);

    // Use setImmediate to avoid blocking current request
    setImmediate(async () => {
      try {
        this.revalidationQueue.delete(url);
        await this.regenerate(url, context);
        this.logger.debug(`Background revalidation completed: ${url}`);
      } catch (error) {
        this.logger.error(`Background revalidation failed for ${url}:`, error);
      }
    });
  }

  getISRCachePath(url: string): string {
    const distPath = this.config.paths?.dist || './dist';
    const cacheDir = path.join(distPath, '.isr-cache');
    const fileName = this.urlToFileName(url);
    return path.join(cacheDir, `${fileName}.html`);
  }

  getISRMetadataPath(url: string): string {
    const distPath = this.config.paths?.dist || './dist';
    const cacheDir = path.join(distPath, '.isr-cache');
    const fileName = this.urlToFileName(url);
    return path.join(cacheDir, `${fileName}.meta.json`);
  }

  urlToFileName(url: string): string {
    if (url === '/') return 'index';
    return url.replace(/^\/+|\/+$/g, '').replace(/\//g, '_');
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

  async clearCache(url?: string): Promise<void> {
    if (url) {
      // Clear specific URL
      const paths = [this.getISRCachePath(url), this.getISRMetadataPath(url)];

      for (const filePath of paths) {
        try {
          await fs.promises.unlink(filePath);
        } catch {
          // Ignore if file doesn't exist
        }
      }

      this.metadataCache.delete(url);
      this.logger.debug(`ISR cache cleared for: ${url}`);
    } else {
      // Clear entire cache
      const distPath = this.config.paths?.dist || './dist';
      const cacheDir = path.join(distPath, '.isr-cache');

      try {
        await fs.promises.rm(cacheDir, { recursive: true, force: true });
        this.metadataCache.clear();
        this.logger.info('ISR cache cleared completely');
      } catch (error) {
        this.logger.error('Failed to clear ISR cache:', error);
      }
    }
  }

  getStats() {
    return {
      cachedPages: this.metadataCache.size,
      revalidationQueue: this.revalidationQueue.size,
      revalidating: Array.from(this.isRevalidating.entries()).filter(
        ([, isRevalidating]) => isRevalidating
      ).length,
    };
  }
}
