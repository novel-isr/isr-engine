/**
 * ISR 引擎 —— ISR/SSG/Fallback 编排层（plugin-rsc 模式）
 *
 * 职责范围：
 *   - 配置归一化（补齐 defaults，收口 cache / routes / renderMode）
 *   - 项目扫描（路由发现，供 virtual:isr-routes 和 sitemap 使用）
 *   - SEO 引擎初始化（sitemap / robots 生成）
 *   - 启动 Express 服务器 + 挂载 ops 路由（/health / sitemap.xml / robots.txt）
 *   - ISR 缓存失效 invalidator 的注册（来自 revalidatePath / revalidateTag 调用）
 *
 * 非职责：
 *   - 渲染：由 @vitejs/plugin-rsc 在 rsc/ssr/client 三环境完成
 *   - Flight 协议：由 react-server-dom-webpack 承担
 *   - ISR 内存缓存：由 createIsrCacheHandler 在 Vite/Express 中间件链里提供
 *   - SSG 预生成：由 cli/build.ts + ssg/spider 在构建阶段完成
 */

import fs from 'node:fs';
import path from 'node:path';

import type { ISRConfig } from '../types';
export { normalizeEngineConfig } from '@/config/normalizeEngineConfig';
import { normalizeEngineConfig } from '@/config/normalizeEngineConfig';
import { Logger } from '../logger/Logger';
import { CacheCleanup } from '../utils/CacheCleanup';
import { isDev } from '../config/getStatus';

import { scanProject } from '@/discovery';
import { startAppServer, shutdownServer, type ServerContext } from '@/server';
import { ISRRoutes } from '@/isr/ISRRoutes';

import { SEOEngine, resolveSeoConfig, type ResolvedSeoConfig } from './seo';
import { MiddlewareComposer, traceMiddleware, performanceMiddleware } from '../middlewares';
import { registerInvalidator } from '@/rsc/revalidate';

import type { Express } from 'express';

export default class ISREngine {
  private readonly logger: Logger = Logger.getInstance();
  private readonly config: ISRConfig;
  private readonly resolvedSeo: ResolvedSeoConfig;
  private readonly middlewareComposer: MiddlewareComposer;
  private readonly seoEngine: SEOEngine;

  private serverContext?: ServerContext;
  private unregisterInvalidator?: () => void;

  constructor(config: ISRConfig) {
    this.config = normalizeEngineConfig(config);

    this.middlewareComposer = MiddlewareComposer.getInstance();
    this.middlewareComposer.use([traceMiddleware, performanceMiddleware]);

    // 唯一的 SEO baseUrl 入口 —— runtime.site + dev 默认由 resolveSeoConfig 收口
    this.resolvedSeo = resolveSeoConfig(this.config);

    this.seoEngine = SEOEngine.getInstance({
      baseUrl: this.resolvedSeo.baseUrl,
    });
  }

  /**
   * 初始化（不依赖 serverContext 的部分）
   */
  async initialize(): Promise<void> {
    this.logger.info('🚀 初始化 ISR 引擎...');

    // 1. 开发环境清理缓存目录
    if (isDev()) {
      await CacheCleanup.cleanupOnDevStart();
    }

    // 2. 项目扫描（路由/组件发现）—— virtual:isr-routes 和 sitemap 依赖
    this.logger.info('🔍 开始项目扫描...');
    const scanResult = await scanProject(process.cwd());
    this.logger.info(
      `✅ 自动发现 ${scanResult.routes.pages.length} 个页面路由, ${scanResult.routes.apis.length} 个 API 路由`
    );

    // 3. SEO 引擎初始化
    await this.seoEngine.initialize();

    this.logger.info('🎉 ISR 引擎初始化完成');
  }

  /**
   * 启动服务器 + 注册 ops 路由 + 注册 revalidate invalidator
   */
  async start(): Promise<ServerContext> {
    await this.initialize();

    this.serverContext = await startAppServer(this.config, (requestHandler: Express) => {
      const routes = new ISRRoutes(this, this.logger, {
        renderMode: this.config.renderMode,
        routes: this.config.routes,
      });
      routes.setup(requestHandler);
    });

    // 注册 revalidate invalidator —— Server Actions 调用 revalidatePath/Tag 时触发本方法
    // 目前 engine 只做日志 + CacheCleanup 兜底；真实的内存 LRU 失效由 createIsrCacheHandler 注册的 invalidator 完成
    this.unregisterInvalidator = registerInvalidator(async target => {
      this.logger.info(
        `♻️ ISREngine received invalidate: ${target.kind}=${target.value}（disk/persistent tier no-op in plugin-rsc mode）`
      );
    });

    return this.serverContext;
  }

  /**
   * plugin-rsc 模式标识（供 ISRRoutes 等决定是否注册 * 渲染路由）
   */
  isPluginRscMode(): boolean {
    // 当前引擎版本只支持 plugin-rsc 模式（legacy render(url,ctx) 契约已移除）
    return true;
  }

  /**
   * 生成站点地图 + robots.txt
   */
  async generateSeo(): Promise<void> {
    const outputDir = path.resolve(process.cwd(), '.isr-hyou/ssg');
    await fs.promises.mkdir(outputDir, { recursive: true });

    const robotsTxt = this.seoEngine.generateRobotsTxt();
    await fs.promises.writeFile(path.join(outputDir, 'robots.txt'), robotsTxt, 'utf-8');

    const sitemapXml = await this.seoEngine.generateSitemap();
    await fs.promises.writeFile(path.join(outputDir, 'sitemap.xml'), sitemapXml, 'utf-8');
  }

  /**
   * 关闭引擎
   *
   * 所有清理步骤用 allSettled 跑，保证其中一步失败不会阻止后续释放。
   * 否则 shutdownServer 抛错时 seoEngine 永不清理 → sitemap 写盘 handle 泄漏、
   * 下次进程启动 `.isr-hyou/ssg` 里残留旧 robots.txt。
   */
  async shutdown(): Promise<void> {
    this.logger.spin('关闭 ISR 引擎...');

    this.unregisterInvalidator?.();

    const results = await Promise.allSettled([shutdownServer(), this.seoEngine.shutdown()]);
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

    this.logger.stopSpinner('ISR 引擎已关闭');

    if (failures.length > 0) {
      for (const f of failures) {
        this.logger.warn(
          `shutdown 子步骤失败: ${(f.reason as Error)?.message ?? String(f.reason)}`
        );
      }
      // 抛聚合错误让进程 supervisor 感知到异常关闭
      throw new Error(`ISREngine shutdown 部分失败（${failures.length}/${results.length}）`);
    }

    this.logger.success('ISR 引擎关闭完成');
  }
}
