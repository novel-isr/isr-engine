/**
 * 服务器管理器
 * 整合 Vite 开发服务器、HTTP 服务器和中间件
 * ISREngine 唯一需要关心的服务器入口
 */

import path from 'path';
import fs from 'fs';
import express, { type Express } from 'express';
import type { ISRConfig } from '@/types';
import { Logger } from '@/logger/Logger';
import { isDev } from '@/config/getStatus';
import type { RouteSetupFn, ServerContext } from './types';
import { createViteDevServer, closeViteDevServer } from './viteDevServer';
import { applyBaseMiddlewaresWithOptions, mountViteOrStatic } from './middleware';
import { startServer, closeServer } from './httpServer';
import { requestContext } from '@/context/RequestContext';
import { createServerRequestContext, applyAnonCookie } from '@/context/createServerRequestContext';
import { createABVariantMiddleware } from '@/middlewares/ABVariantMiddleware';
import { resolveManifestLoader } from '@/experiments/ManifestLoader';
import { resolveExposureQueue } from '@/experiments/ExposureQueue';
import { createLocaleRedirectMiddleware } from '@/middlewares/LocaleRedirect';
import { resolveI18nConfig } from '@/runtime/i18n';

const logger = Logger.getInstance();

/** 服务器上下文 */
let serverContext: ServerContext | null = null;

/**
 * 加载生产环境 Manifest
 */
function loadProdManifest(): Record<string, unknown> | null {
  const manifestPaths = [
    'dist/.vite/manifest.json',
    'dist/client/.vite/manifest.json',
    'dist/manifest.json',
  ];

  for (const relativePath of manifestPaths) {
    const absolutePath = path.resolve(process.cwd(), relativePath);
    if (fs.existsSync(absolutePath)) {
      try {
        const content = fs.readFileSync(absolutePath, 'utf-8');
        logger.info(`✅ 已加载 Manifest: ${relativePath}`);
        return JSON.parse(content) as Record<string, unknown>;
      } catch {
        logger.warn(`Manifest 解析失败: ${relativePath}`);
      }
    }
  }

  logger.warn('⚠️ 未找到 Manifest 文件，静态资源可能无法正确加载');
  return null;
}

/**
 * 初始化开发模式服务器上下文
 */
async function initDevContext(requestHandler: Express): Promise<ServerContext> {
  logger.info('🔧 初始化开发模式服务器...');

  const viteDevMiddleware = await createViteDevServer();

  return {
    requestHandler,
    viteDevMiddleware,
    isDev: true,
    manifest: null,
    httpServer: null,
  };
}

/**
 * 初始化生产模式服务器上下文
 */
async function initProdContext(requestHandler: Express): Promise<ServerContext> {
  logger.info('🏭 初始化生产模式服务器...');

  // 1. 加载构建 Manifest
  const manifest = loadProdManifest();

  // 2. 检查构建目录
  const clientDir = path.resolve(process.cwd(), 'dist/client');
  const serverDir = path.resolve(process.cwd(), 'dist/server');

  if (!fs.existsSync(clientDir)) {
    logger.warn(`⚠️ 客户端构建目录不存在: ${clientDir}`);
    logger.warn('请先运行 build 命令');
  }

  if (!fs.existsSync(serverDir)) {
    logger.warn(`⚠️ 服务端构建目录不存在: ${serverDir}`);
  }

  logger.info('✅ 生产环境准备就绪');

  return {
    manifest,
    requestHandler,
    httpServer: null,
    viteDevMiddleware: null,
    isDev: false,
  };
}

/**
 * 初始化服务器上下文（内部使用）
 */
async function initServerContext(config?: ISRConfig): Promise<ServerContext> {
  if (serverContext) {
    return serverContext;
  }

  const requestHandler = express();

  // 根据环境初始化
  serverContext = isDev()
    ? await initDevContext(requestHandler)
    : await initProdContext(requestHandler);

  // 仅应用前置中间件（安全 / 压缩 / Body 解析）
  // Vite / 静态资源中间件将在 setupRoutes 之后挂载，确保 ops 路由能先于 Vite 匹配
  applyBaseMiddlewaresWithOptions(serverContext);

  // 详见 src/context/createServerRequestContext.ts —— 三个 ID 的生成 + anonId
  // cookie 缺失检测都收口在这一处。
  // cookieDomain 子域分发部署时设 `.your-domain.com`，让浏览器自动带到所有子域；
  // 单一域名 / localhost 留空。
  const cookieDomain = config?.runtime?.cookieDomain;
  serverContext.requestHandler.use((req, res, next) => {
    const { data, needsAnonCookie } = createServerRequestContext(req);
    if (needsAnonCookie) applyAnonCookie(res, data.anonId, cookieDomain);
    requestContext.run(data, () => next());
  });

  // Locale redirect —— runtime.i18n.prefixDefault=true 时挂上，让裸 URL 302 到带前缀
  // 形式（详见 middlewares/LocaleRedirect）；必须早于 ISR cache / 静态。
  if (config?.runtime?.i18n?.prefixDefault) {
    const localeRedirect = createLocaleRedirectMiddleware({
      i18n: resolveI18nConfig(config.runtime.i18n),
    });
    if (localeRedirect) serverContext.requestHandler.use(localeRedirect);
  }

  // Rate limiting / trace snapshot 已从 engine 移除 —— 业界共识（Next.js / Remix /
  // Astro 都不做）：rate-limit 走 CDN/WAF/Gateway，trace 走 OTel + Sentry/Honeycomb。

  // A/B variant —— 同 cli/start.ts：manifest > static + exposure tracking
  const hasStaticExps =
    config?.runtime?.experiments && Object.keys(config.runtime.experiments).length > 0;
  const hasManifest = !!config?.runtime?.experimentManifest?.endpoint;
  if (hasStaticExps || hasManifest) {
    const baseOrigin = config?.runtime?.services?.api;
    const manifestLoader = resolveManifestLoader(
      config?.runtime?.experimentManifest,
      config?.runtime?.experiments ?? {},
      baseOrigin
    );
    if (manifestLoader) await manifestLoader.init();
    const exposureQueue = resolveExposureQueue(config?.runtime?.experimentTracking, baseOrigin);

    serverContext.requestHandler.use(
      createABVariantMiddleware({
        experiments: config?.runtime?.experiments ?? {},
        manifestLoader,
        exposureQueue,
      })
    );

    const expKeys = manifestLoader
      ? Object.keys(manifestLoader.getCurrent())
      : Object.keys(config?.runtime?.experiments ?? {});
    logger.info(
      `🧪 A/B testing 已启用：${expKeys.join(', ') || '(empty)'}${manifestLoader ? ' [manifest]' : ' [static]'}${exposureQueue ? ' + exposure tracking' : ''}`
    );
  }

  logger.info(`✅ 服务器上下文已初始化 (${isDev() ? '开发' : '生产'}模式)`);

  return serverContext;
}

/**
 * 启动服务器
 * @returns 服务器上下文，包含 loadRenderFunction 等方法
 */
export async function startAppServer(
  config: ISRConfig,
  setupRoutes: RouteSetupFn
): Promise<ServerContext> {
  // 1. 初始化上下文
  if (!serverContext) {
    await initServerContext(config);
  }

  if (!serverContext) {
    throw new Error('服务器上下文初始化失败');
  }

  // 2. 注册 ops 路由（/health / /metrics / /sitemap.xml / /robots.txt 等）
  //    必须在 Vite middleware 之前，否则 @vitejs/plugin-rsc 的 server handler 会
  //    把 /health 当作页面请求
  setupRoutes(serverContext.requestHandler);

  // 3. 挂载 Vite 开发中间件 / 生产静态资源
  mountViteOrStatic(serverContext);

  // 4. 解析配置并启动 HTTP 服务器
  const serverConfig = {
    port: config.server.port,
    host: config.server.host,
    strictPort: config.server.strictPort,
  };
  const result = await startServer(serverContext.requestHandler, serverConfig);

  serverContext.httpServer = result.server;
  serverContext.url = result.url;

  logger.success(`🚀 ${isDev() ? '开发' : '生产'}服务器已启动: ${result.url}`);

  return serverContext;
}

/**
 * 关闭服务器
 */
export async function shutdownServer(): Promise<void> {
  if (!serverContext) {
    return;
  }

  // 关闭 HTTP 服务器
  if (serverContext.httpServer) {
    await closeServer(serverContext.httpServer);
    logger.info('HTTP 服务器已关闭');
  }

  // 关闭 Vite 开发服务器
  if (serverContext.isDev) {
    await closeViteDevServer();
    logger.info('Vite 开发中间件已关闭');
  }

  serverContext = null;
  logger.success('✅ 服务器已完全关闭');
}
