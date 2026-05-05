/**
 * ISR ops 路由注册
 *
 * plugin-rsc 模式下所有页面请求由 @vitejs/plugin-rsc 的 server handler 处理；
 * 本模块只挂载引擎级运维端点：
 *   GET  /health            健康检查（JSON）
 *   GET  /sitemap.xml       站点地图（SEO 引擎生成）
 *   GET  /robots.txt        爬虫规则
 *
 * dev-only 缓存统计端点（/__isr/stats）由缓存中间件内部挂载，
 * 因为它需要访问 createIsrCacheHandler 返回的 handler.stats()。
 */

import type { Express, Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';

import type { RenderModeType, RouteRule } from '@/types';
import type ISREngine from '@/engine/ISREngine';
import type { Logger } from '@/logger/Logger';

export class ISRRoutes {
  private readonly defaultMode: RenderModeType;
  private readonly routes: Record<string, RouteRule>;

  constructor(
    private engine: ISREngine,
    private logger: Logger,
    config?: {
      renderMode?: RenderModeType;
      routes?: Record<string, RouteRule>;
    }
  ) {
    this.defaultMode = config?.renderMode || 'isr';
    this.routes = config?.routes || {};
  }

  setup(requestHandler: Express): void {
    // 健康检查
    requestHandler.get('/health', (_req: Request, res: Response) => {
      res.json({
        status: 'healthy',
        version: '2.0.0',
        mode: 'plugin-rsc',
        defaultRenderMode: this.defaultMode,
        routes: Object.keys(this.routes).length,
        timestamp: new Date().toISOString(),
      });
    });

    // 站点地图 —— 优先返回 SSG/public 已存在的文件，否则由 SEO 引擎动态生成
    requestHandler.get('/sitemap.xml', async (_req: Request, res: Response) => {
      try {
        const candidates = [
          path.resolve(process.cwd(), 'dist/client/sitemap.xml'),
          path.resolve(process.cwd(), '.isr-hyou/ssg/sitemap.xml'),
          path.resolve(process.cwd(), 'public/sitemap.xml'),
        ];

        for (const p of candidates) {
          if (fs.existsSync(p)) {
            res.setHeader('Content-Type', 'application/xml; charset=utf-8');
            res.send(await fs.promises.readFile(p, 'utf-8'));
            return;
          }
        }

        await this.engine.generateSeo();
        for (const p of candidates) {
          if (fs.existsSync(p)) {
            res.setHeader('Content-Type', 'application/xml; charset=utf-8');
            res.send(await fs.promises.readFile(p, 'utf-8'));
            return;
          }
        }

        res.setHeader('Content-Type', 'application/xml; charset=utf-8');
        res.send(
          `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>`
        );
      } catch (error) {
        this.logger.error('生成 sitemap 失败:', error);
        res.status(500).send('Internal Server Error');
      }
    });

    // Robots.txt
    requestHandler.get('/robots.txt', async (_req: Request, res: Response) => {
      try {
        const candidates = [
          path.resolve(process.cwd(), 'dist/client/robots.txt'),
          path.resolve(process.cwd(), '.isr-hyou/ssg/robots.txt'),
          path.resolve(process.cwd(), 'public/robots.txt'),
        ];

        for (const p of candidates) {
          if (fs.existsSync(p)) {
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.send(await fs.promises.readFile(p, 'utf-8'));
            return;
          }
        }

        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.send('User-agent: *\nAllow: /\nSitemap: /sitemap.xml\n');
      } catch (error) {
        this.logger.error('生成 robots.txt 失败:', error);
        res.status(500).send('Internal Server Error');
      }
    });

    this.logger.debug('ISRRoutes: 已注册 ops 端点 (/health, /sitemap.xml, /robots.txt)');
  }
}
