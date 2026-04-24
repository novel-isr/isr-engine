/**
 * ISR 引擎 —— ISR/SSG/Fallback 编排层（plugin-rsc 模式）
 *
 * 职责范围：
 *   - 配置归一化（mode → renderMode, routes → routeOverrides 等）
 *   - 项目扫描（路由发现，供 virtual:isr-routes 或 CLI stats 使用）
 *   - SEO 引擎初始化（sitemap / robots 生成）
 *   - 启动 Express 服务器 + 挂载 admin 路由（/health / sitemap.xml / robots.txt）
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

import type { ISRConfig, RenderModeType, RouteRule } from '../types';
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

/**
 * 归一化配置字段别名
 *   - `mode` → `renderMode`
 *   - `routes` → `routeOverrides`
 * 兜底默认值，避免脏配置导致启动失败
 */
function normalizeEngineConfig(config: ISRConfig): ISRConfig {
  const normalized: ISRConfig = { ...config };

  if (!normalized.renderMode && (config as { mode?: RenderModeType }).mode) {
    normalized.renderMode = (config as { mode: RenderModeType }).mode;
  }

  if (!normalized.routeOverrides && (config as { routes?: Record<string, RouteRule> }).routes) {
    normalized.routeOverrides = (config as { routes?: Record<string, RouteRule> }).routes;
  }

  if (!normalized.renderMode) {
    normalized.renderMode = 'isr';
  }
  if (!normalized.routeOverrides) {
    normalized.routeOverrides = {};
  }

  return normalized;
}

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

    // 唯一的 SEO 配置入口 —— 用户配置 + env 兜底链 + dev 默认全部由 resolveSeoConfig 收口
    this.resolvedSeo = resolveSeoConfig(this.config);

    this.seoEngine = SEOEngine.getInstance({
      enabled: this.resolvedSeo.enabled,
      baseUrl: this.resolvedSeo.baseUrl,
      sitemap: { enabled: this.resolvedSeo.generateSitemap },
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

    // 2. 项目扫描（路由/组件发现）—— CLI stats 和 virtual:isr-routes 依赖
    this.logger.info('🔍 开始项目扫描...');
    const scanResult = await scanProject(process.cwd());
    this.logger.info(
      `✅ 自动发现 ${scanResult.routes.pages.length} 个页面路由, ${scanResult.routes.apis.length} 个 API 路由`
    );

    // 3. SEO 引擎初始化
    if (this.resolvedSeo.enabled) {
      await this.seoEngine.initialize();
    }

    this.logger.info('🎉 ISR 引擎初始化完成');
  }

  /**
   * 启动服务器 + 注册 admin 路由 + 注册 revalidate invalidator
   */
  async start(): Promise<ServerContext> {
    await this.initialize();

    this.serverContext = await startAppServer(this.config, (requestHandler: Express) => {
      const routes = new ISRRoutes(this, this.logger, {
        renderMode: this.config.renderMode,
        routeOverrides: this.config.routeOverrides,
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
   */
  async shutdown(): Promise<void> {
    this.logger.spin('关闭 ISR 引擎...');

    this.unregisterInvalidator?.();

    await shutdownServer();
    await this.seoEngine.shutdown();

    this.logger.stopSpinner('ISR 引擎已关闭');
    this.logger.success('ISR 引擎关闭完成');
  }
}
