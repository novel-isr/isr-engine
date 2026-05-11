/**
 * 生产服务器命令
 *
 * 流程：
 *   1. 动态 import dist/rsc/index.js → 默认导出 { fetch: handler }（Fetch API）
 *   2. Express 装配：
 *        security/body → ops(/health, /metrics) →
 *        ISR cache (framework-agnostic handler) →
 *        express.static(dist/client)  ← 命中 SSG 预生成的 index.html
 *        Web Request → handler(req) → Web Response → Express res
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import express, { type Express } from 'express';
import { Readable } from 'node:stream';

import { loadConfig } from '../config/loadConfig';
import { logger } from '@/logger';
import { DEFAULT_PORT } from '@/config/defaults';
import { createIsrCacheHandler } from '@/plugin/isrCacheMiddleware';
import { startServer, closeServer } from '@/server/httpServer';
import { resolveOpsConfig, createOpsAuthMiddleware } from '@/server/opsConfig';
import type { RuntimeConfig } from '@/types';

interface StartOptions {
  port: string;
  host?: string;
}

function safeOrigin(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/**
 * 从 ssr.config 路由表里提取要写入 sitemap 的路由（剔除通配符 / 内部 / API）
 * 导出以便单测覆盖（纯函数）
 */
export function extractRoutesForSitemap(config: { routes?: Record<string, unknown> }): string[] {
  const routes = (config.routes ?? {}) as Record<string, unknown>;
  const out: string[] = [];
  for (const path of Object.keys(routes)) {
    if (path.includes('*') || path.includes(':')) continue; // 通配 / 动态路由跳过
    if (path.startsWith('/__') || path.startsWith('/api/')) continue;
    out.push(path);
  }
  return out;
}

/**
 * 把 ssr.config.ts 的 telemetry 第三方配置映射到可选 adapter 使用的 env。
 * 这一步必须发生在 import dist/rsc/index.js 之前，因为内置 entry.server 会在模块加载时
 * 初始化 auto hooks。engine 仍不静态 import vendor SDK；这里仅做启动期配置桥接。
 */
export function applyTelemetryIntegrationEnv(runtime: RuntimeConfig | undefined): void {
  const telemetry = runtime?.telemetry;
  if (!telemetry) {
    process.env.SENTRY_ENABLED = 'false';
    delete process.env.DD_SERVICE;
    delete process.env.DD_ENV;
    delete process.env.DD_VERSION;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_SERVICE_NAME;
    return;
  }

  const sentryIntegration = telemetry.integrations?.sentry;
  if (sentryIntegration) {
    process.env.SENTRY_ENABLED = sentryIntegration.enabled ? 'true' : 'false';
    if (sentryIntegration.enabled) {
      if (sentryIntegration.dsn) process.env.SENTRY_DSN = sentryIntegration.dsn;
      if (sentryIntegration.tracesSampleRate !== undefined) {
        process.env.SENTRY_TRACES_SAMPLE_RATE = String(sentryIntegration.tracesSampleRate);
      }
      if (sentryIntegration.environment) {
        process.env.NODE_ENV = sentryIntegration.environment;
      }
    } else {
      delete process.env.SENTRY_DSN;
      delete process.env.SENTRY_TRACES_SAMPLE_RATE;
    }
  } else {
    process.env.SENTRY_ENABLED = 'false';
    delete process.env.SENTRY_DSN;
    delete process.env.SENTRY_TRACES_SAMPLE_RATE;
  }

  delete process.env.DD_SERVICE;
  delete process.env.DD_ENV;
  delete process.env.DD_VERSION;
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  delete process.env.OTEL_SERVICE_NAME;
  for (const exporter of telemetry.exporters) {
    if (exporter.type === 'datadog') {
      if (exporter.service) process.env.DD_SERVICE = exporter.service;
      if (telemetry.environment) process.env.DD_ENV = telemetry.environment;
      if (telemetry.release) process.env.DD_VERSION = telemetry.release;
      continue;
    }

    if (exporter.type === 'otel') {
      if (exporter.endpoint) process.env.OTEL_EXPORTER_OTLP_ENDPOINT = exporter.endpoint;
      if (exporter.serviceName) process.env.OTEL_SERVICE_NAME = exporter.serviceName;
    }
  }
}

/** 带 fetch 方法的 Web 标准 RSC handler 签名 */
interface RscHandlerModule {
  default?: { fetch: (request: Request) => Promise<Response> };
  fetch?: (request: Request) => Promise<Response>;
}

export async function startProductionServer(options: StartOptions): Promise<void> {
  process.env.NODE_ENV = 'production';

  const { port, host } = options;
  logger.info('[CLI]', '启动生产服务器');

  const rscDistEntry = path.resolve(process.cwd(), 'dist/rsc/index.js');
  const clientDir = path.resolve(process.cwd(), 'dist/client');

  logger.spin('加载生产构建产物...');
  try {
    await fs.access(rscDistEntry);
    await fs.access(clientDir);
  } catch {
    logger.stopSpinner('未找到生产构建产物', false);
    logger.error('[CLI]', '请先运行: pnpm build');
    process.exit(1);
  }

  const config = await loadConfig();
  config.server = config.server || { port: DEFAULT_PORT };
  if (port) config.server.port = parseInt(port, 10);
  if (host) config.server.host = host;

  // 平台运行时配置只从 ssr.config.ts runtime 读取。
  const runtime = config.runtime;
  applyTelemetryIntegrationEnv(runtime);
  const sentryIntegration = runtime?.telemetry ? runtime.telemetry.integrations?.sentry : undefined;
  if (sentryIntegration?.enabled && process.env.SENTRY_DSN) {
    logger.info(`🛰️  Sentry integration 来自 ssr.config.ts runtime.telemetry.integrations`);
  } else if (sentryIntegration?.enabled) {
    logger.warn(`🛰️  Sentry integration 已启用但缺少 SENTRY_DSN，跳过 Sentry adapter`);
  }

  const mod = (await import(/* @vite-ignore */ rscDistEntry)) as RscHandlerModule;
  const rscHandler = mod.default?.fetch || mod.fetch;
  if (!rscHandler) {
    throw new Error('dist/rsc/index.js 未导出 { fetch } 或 default.fetch，无法启动生产服务器');
  }

  const extraConnectSrc = Array.from(
    new Set(
      [runtime?.services?.api, runtime?.services?.telemetry]
        .map(safeOrigin)
        .filter((origin): origin is string => !!origin)
    )
  );

  const app: Express = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' })); // 防 JSON 炸弹
  const opsConfig = resolveOpsConfig(config, 'production');
  for (const warning of opsConfig.warnings) {
    logger.warn(`[Ops] ${warning}`);
  }
  // 安全头 —— helmet 默认 + 生产 CSP（prod 不允许 'unsafe-eval'）
  // CSP connect-src 自动加入用户配置的服务 origin（让 CSR-fallback / 业务 fetch 不被挡）
  const { createSecurityMiddleware, createCompressionMiddleware } =
    await import('@/server/middleware');
  app.use(createSecurityMiddleware(false, extraConnectSrc));
  app.use(createCompressionMiddleware());
  if (extraConnectSrc.length > 0) {
    logger.info(`🔒 CSP connect-src 加入：${extraConnectSrc.join(', ')}`);
  }

  // 建立 RequestContext (AsyncLocalStorage) —— 让 RSC 渲染期能用 getRequestContext()
  // 必须在所有读/写 context 的中间件（A/B、Trace、Logger）之前。
  //
  // 工厂 createServerRequestContext 负责三个 ID 的生成 + anonId cookie 缺失检测；
  // applyAnonCookie 在缺失时把 Set-Cookie 写到响应头（live 客户端可收到，cache 层
  // 在 captureAndStore 阶段会剥掉这一条 Set-Cookie 才入缓存，保证 cache entry
  // user-agnostic）。详见 src/context/createServerRequestContext.ts。
  const { requestContext } = await import('@/context/RequestContext');
  const { createServerRequestContext, applyAnonCookie } =
    await import('@/context/createServerRequestContext');
  app.use((req, res, next) => {
    const { data, needsAnonCookie } = createServerRequestContext(req);
    if (needsAnonCookie) applyAnonCookie(res, data.anonId);
    requestContext.run(data, () => next());
  });

  // Locale redirect —— runtime.i18n.prefixDefault=true 时，无 locale 前缀的 URL
  // 一律 302 到 /{negotiated}/path（cookie > Accept-Language > defaultLocale）。
  // 必须早于 ISR 缓存 / 静态托管 —— 否则 /books 命中缓存的 default-locale 渲染，
  // 永远拿不到 redirect 机会。
  if (runtime?.i18n?.prefixDefault) {
    const { createLocaleRedirectMiddleware } = await import('@/middlewares/LocaleRedirect');
    const { resolveI18nConfig } = await import('@/runtime/i18n');
    const middleware = createLocaleRedirectMiddleware({
      i18n: resolveI18nConfig(runtime.i18n),
    });
    if (middleware) {
      app.use(middleware);
      logger.info(`🌐 Locale redirect 已启用 (prefixDefault=true)`);
    }
  }

  // Rate limiting / trace snapshot 已从 engine 移除 —— 业界共识（Next.js / Remix /
  // Astro 都不做）：rate-limit 应该走 CDN/WAF/Gateway（Cloudflare / Kong / Vercel
  // Edge），trace 应该走 OTel + Sentry / Honeycomb / Datadog。框架不该承担这些职责。

  // A/B variant —— ssr.config.ts runtime.experiments + experimentManifest + experimentTracking
  // 优先级：manifest（admin-server 动态拉）> experiments 静态配置
  // 曝光上报：experimentTracking.endpoint 配上 → engine 异步 fire-and-forget POST
  const hasStaticExps = runtime?.experiments && Object.keys(runtime.experiments).length > 0;
  const hasManifest = !!runtime?.experimentManifest?.endpoint;
  if (hasStaticExps || hasManifest) {
    const baseOrigin = runtime?.services?.api;
    const { createABVariantMiddleware } = await import('@/middlewares/ABVariantMiddleware');
    const { resolveManifestLoader } = await import('@/experiments/ManifestLoader');
    const { resolveExposureQueue } = await import('@/experiments/ExposureQueue');

    const manifestLoader = resolveManifestLoader(
      runtime?.experimentManifest,
      runtime?.experiments ?? {},
      baseOrigin
    );
    if (manifestLoader) {
      await manifestLoader.init();
    }

    const exposureQueue = resolveExposureQueue(runtime?.experimentTracking, baseOrigin);

    app.use(
      createABVariantMiddleware({
        experiments: runtime?.experiments ?? {},
        manifestLoader,
        exposureQueue,
      })
    );

    const expKeys = manifestLoader
      ? Object.keys(manifestLoader.getCurrent())
      : Object.keys(runtime?.experiments ?? {});
    logger.info(
      `🧪 A/B testing 已启用：${expKeys.join(', ') || '(empty)'}${manifestLoader ? ' [manifest]' : ' [static]'}${exposureQueue ? ' + exposure tracking' : ''}`
    );
  }

  // ops 路由：先于 ISR 缓存 + 静态 + 动态 handler
  if (opsConfig.health.enabled) {
    app.get('/health', (_req, res) => {
      res.json({
        status: 'healthy',
        version: '2.0.0',
        mode: 'plugin-rsc-production',
        timestamp: new Date().toISOString(),
      });
    });
  }

  // SSG 路由直发：URL `/foo` 内部映射到 `/foo/index.html`（不做 301 重定向）
  // —— 让 spider 预生成的 dist/client/<path>/index.html 真正被使用，跳过 ISR 缓存
  app.use((req, _res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (req.url.includes('.')) return next(); // 已带扩展名（图片/css/js），交给 static
    if (req.url.endsWith('/')) return next(); // 已是目录形式，express.static 会处理
    const indexPath = path.join(clientDir, req.url, 'index.html');
    fs.access(indexPath)
      .then(() => {
        req.url = req.url + '/'; // 加上斜杠，express.static 自动找 index.html
        next();
      })
      .catch(() => next());
  });

  // 客户端静态资源（必须在 ISR cache 之前 —— SSG 文件由 OS 文件系统直发，
  // 不需要也不应该走内存 LRU 缓存，避免 stream pipe 与 res.write 拦截不兼容导致空 body）
  app.use(
    express.static(clientDir, {
      index: 'index.html',
      redirect: false,
      maxAge: '1h',
      fallthrough: true,
      setHeaders: (res, filePath) => {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else if (filePath.endsWith('.html')) {
          res.setHeader('Cache-Control', 'public, max-age=3600');
          res.setHeader('X-Served-By', 'ssg-static');
        }
      },
    })
  );

  // 图片优化端点（/_/img）—— sharp 是 optionalDependency，未装时端点返回 501
  const { createImageMiddleware } = await import('@/plugin/createImagePlugin');
  app.use(createImageMiddleware({ remoteAllowlist: [] }));

  // ISR 缓存：只读取 ssr.config.ts runtime.redis；环境变量需由业务配置显式注入。
  const { createAutoCacheStore } = await import('@/cache/createAutoCacheStore');
  const { RedisInvalidationBus } = await import('@/cache/RedisInvalidationBus');
  const { hasRuntimeRedisConnection, resolveRuntimeRedisConfig } =
    await import('@/config/resolveRuntimeRedis');
  const redisCfg = resolveRuntimeRedisConfig(runtime?.redis);
  const hasRedisConfig = hasRuntimeRedisConnection(runtime?.redis);
  const cache = createIsrCacheHandler(config, {
    store: createAutoCacheStore({
      redisUrl: redisCfg?.url,
      redisHost: redisCfg?.host,
      redisPort: redisCfg?.port,
      redisPassword: redisCfg?.password,
      redisKeyPrefix: redisCfg?.keyPrefix,
    }),
    invalidationBus: hasRedisConfig
      ? new RedisInvalidationBus({
          url: redisCfg?.url,
          host: redisCfg?.host,
          port: redisCfg?.port,
          password: redisCfg?.password,
          keyPrefix: redisCfg?.keyPrefix,
          channel: redisCfg?.invalidationChannel,
        })
      : undefined,
  });
  app.use(cache);

  // Prometheus 抓取端点（prom-client 文本格式）
  const { promRegistry } = await import('@/metrics/PromMetrics');
  if (opsConfig.metrics.enabled) {
    app.get('/metrics', createOpsAuthMiddleware('metrics', opsConfig), async (_req, res) => {
      try {
        res.set('content-type', promRegistry.contentType);
        res.end(await promRegistry.metrics());
      } catch (err) {
        res
          .status(500)
          .type('text/plain')
          .end(`metrics error: ${String(err)}`);
      }
    });
  }

  // SEO 端点：sitemap.xml + robots.txt（基于 SEOEngine 自动生成）
  // —— 生产必须在 ssr.config.ts 配置 runtime.site；dev 自动用 localhost。
  const { SEOEngine } = await import('@/engine/seo/SEOEngine');
  const { resolveSeoConfig } = await import('@/engine/seo/resolveSeoConfig');
  const seoCfg = resolveSeoConfig(config);
  const seo = SEOEngine.getInstance({ baseUrl: seoCfg.baseUrl });
  await seo.initialize();
  app.get('/sitemap.xml', async (_req, res) => {
    try {
      const xml = await seo.generateSitemap(extractRoutesForSitemap(config));
      res.set('content-type', 'application/xml; charset=utf-8');
      res.set('cache-control', 'public, max-age=3600');
      res.end(xml);
    } catch (err) {
      res
        .status(500)
        .type('text/plain')
        .end(`sitemap error: ${String(err)}`);
    }
  });
  app.get('/robots.txt', (_req, res) => {
    res.set('content-type', 'text/plain; charset=utf-8');
    res.set('cache-control', 'public, max-age=3600');
    res.end(seo.generateRobotsTxt());
  });

  // 根处理器：Express req → Web Request → handler → Response → Express res
  app.all(/.*/, async (req, res) => {
    try {
      const webRequest = nodeToWebRequest(req);
      const webResponse = await rscHandler(webRequest);
      await pipeWebResponse(webResponse, res);
    } catch (err) {
      logger.error('[Server]', '请求处理异常', err);
      if (!res.headersSent) {
        res.status(500).type('text/plain').send('500 Internal Server Error');
      }
    }
  });

  logger.stopSpinner('生产环境初始化完成', true);

  const serverConfig = {
    port: config.server?.port ?? DEFAULT_PORT,
    host: config.server?.host,
  };
  const result = await startServer(app, serverConfig);

  logger.success('[CLI]', '生产服务器已启动');
  logger.info('[Server]', `服务地址: ${result.url}`);
  if (opsConfig.health.enabled) {
    logger.info('[Server]', `健康检查: ${result.url}/health`);
  }
  if (opsConfig.metrics.enabled) {
    logger.info('[Server]', `Prometheus: ${result.url}/metrics`);
  }

  // 优雅关闭（同 dev：强制断开 keep-alive + 3s 超时兜底）
  let shuttingDown = false;
  const handleShutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      logger.warn('[CLI]', `收到 ${signal} 二次触发 —— 强制退出`);
      process.exit(1);
    }
    shuttingDown = true;
    logger.warn('[CLI]', `收到 ${signal}，关闭生产服务器...`);

    const forceExit = setTimeout(() => {
      logger.warn('[CLI]', '关闭超时，强制退出');
      process.exit(1);
    }, 3000);
    forceExit.unref();

    try {
      await closeServer(result.server);
    } catch (err) {
      logger.error('[CLI]', '关闭时发生异常', err);
    }
    clearTimeout(forceExit);
    process.exit(0);
  };
  process.on('SIGINT', () => void handleShutdown('SIGINT'));
  process.on('SIGTERM', () => void handleShutdown('SIGTERM'));
}

// ─── Node req ↔ Web Request/Response 适配 ───
// 导出以便单测覆盖（纯函数 + 协议适配）

export function nodeToWebRequest(req: express.Request): Request {
  const host = String(req.headers.host || 'localhost');
  const proto = (req.headers['x-forwarded-proto'] as string) || 'http';
  const url = `${proto}://${host}${req.url}`;

  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v == null) continue;
    if (Array.isArray(v)) {
      for (const vv of v) headers.append(k, vv);
    } else {
      headers.set(k, String(v));
    }
  }

  const method = req.method || 'GET';
  const init: RequestInit & { duplex?: 'half' } = { method, headers };
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = Readable.toWeb(req) as unknown as BodyInit;
    init.duplex = 'half';
  }
  return new Request(url, init);
}

export async function pipeWebResponse(response: Response, res: express.Response): Promise<void> {
  res.status(response.status);
  response.headers.forEach((v, k) => {
    if (k.toLowerCase() === 'content-length') return;
    res.setHeader(k, v);
  });

  if (!response.body) {
    res.end();
    return;
  }

  const nodeReadable = Readable.fromWeb(
    response.body as unknown as import('node:stream/web').ReadableStream
  );
  await new Promise<void>((resolve, reject) => {
    nodeReadable.on('end', resolve);
    nodeReadable.on('error', reject);
    nodeReadable.pipe(res);
  });
}
