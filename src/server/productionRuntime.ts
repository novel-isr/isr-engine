/** Shared production application assembly. Listening and process signals belong to callers. */
import fs from 'node:fs/promises';
import { resolveFetchHandler } from '../utils/resolveFetchHandler';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import express, { type Express } from 'express';
import { Readable } from 'node:stream';
import pkg from '../../package.json';

import { logger } from '@/logger';
import { routeToFilePath } from '@/ssg/spider';
import { createIsrCacheHandler } from '@/plugin/isrCacheMiddleware';
import { resolveOpsConfig, createOpsAuthMiddleware } from '@/server/opsConfig';
import {
  assertDistinctHtmlRouteIdentities,
  decodeHtmlPathname,
  isHtmlRoutePattern,
} from '@/utils/htmlPathname';
import type { ISRConfig, RuntimeConfig } from '@/types';
import type { RouteSetupFn } from './types';
import {
  loadStaticCspManifest,
  applyStaticScriptPolicy,
  type StaticCspIndex,
} from '@/security/staticCspManifest';

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
  delete process.env.SENTRY_ENVIRONMENT;
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
        process.env.SENTRY_ENVIRONMENT = sentryIntegration.environment;
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

export interface ProductionRuntime {
  app: Express;
  close(): Promise<void>;
}

export async function prepareProductionBuild(root = process.cwd()) {
  const rscDistEntry = path.resolve(root, 'dist/rsc/index.js');
  const clientDir = path.resolve(root, 'dist/client');
  await fs.access(rscDistEntry);
  await fs.access(clientDir);
  const staticCspIndex = await loadStaticCspManifest(path.dirname(clientDir), {
    onLegacyBuild: () =>
      logger.warn(
        '[CSP] 构建缺少 static-csp-manifest.json；已在启动期生成兼容索引，请重新构建以生成清单'
      ),
  });
  return { rscDistEntry, clientDir, staticCspIndex };
}

export async function createProductionRuntime(
  config: ISRConfig,
  options: {
    root?: string;
    build?: Awaited<ReturnType<typeof prepareProductionBuild>>;
    setupRoutes?: RouteSetupFn;
  } = {}
): Promise<ProductionRuntime> {
  const { rscDistEntry, clientDir, staticCspIndex } =
    options.build ?? (await prepareProductionBuild(options.root));
  const ssgRoutes =
    staticCspIndex.ssgRoutes ?? (Array.isArray(config.ssg?.routes) ? config.ssg.routes : []);
  const ssgFiles = new Map(ssgRoutes.map(route => [route, routeToFilePath(route)]));
  const ssgAliases = new Map<string, string>();
  const configuredRoutes = Object.keys(config.routes ?? {});
  assertDistinctHtmlRouteIdentities(configuredRoutes, { allowPatterns: true });
  const routeNames = new Set([
    ...ssgFiles.keys(),
    ...configuredRoutes.filter(route => !isHtmlRoutePattern(route)),
  ]);
  assertDistinctHtmlRouteIdentities(routeNames);
  const declaredIdentities = new Set([...routeNames].map(route => decodeHtmlPathname(route)));
  const explicitRoutes = new Map<string, string>();
  for (const route of routeNames) {
    const target = new URL(route, 'http://localhost').pathname;
    explicitRoutes.set(decodeHtmlPathname(route), target);
    // Flight requests must retain the same explicitly configured page identity.
    if (
      (route === '/' || !route.endsWith('/')) &&
      !declaredIdentities.has(decodeHtmlPathname(route + '_.rsc'))
    ) {
      explicitRoutes.set(decodeHtmlPathname(route + '_.rsc'), target + '_.rsc');
    }
  }
  for (const [canonical, file] of ssgFiles) {
    const logical = decodeHtmlPathname(canonical);
    const target = new URL(canonical, 'http://localhost').pathname;
    const base = logical.replace(/\/$/, '') || '/';
    // URL aliases have decoded logical identities; artifact names are literal disk paths.
    for (const alias of [
      logical,
      base,
      base === '/' ? '/' : base + '/',
      base === '/' ? '/index.html' : base + '/index.html',
      '/' + file,
    ]) {
      ssgAliases.set(alias, target);
      ssgAliases.set(alias + '_.rsc', target + '_.rsc');
    }
  }
  const resolveSsgIdentity = (pathname: string): string => {
    const logical = decodeHtmlPathname(pathname);
    const known = ssgAliases.get(logical);
    return known ? (explicitRoutes.get(logical) ?? known) : pathname;
  };
  const cleanups: Array<() => void | Promise<void>> = [];
  let closed: Promise<void> | undefined;
  const close = () =>
    (closed ??= (async () => {
      const results = await Promise.allSettled(
        cleanups.reverse().map(cleanup => Promise.resolve().then(cleanup))
      );
      const errors = results.filter(
        (result): result is PromiseRejectedResult => result.status === 'rejected'
      );
      if (errors.length)
        throw new AggregateError(
          errors.map(result => result.reason),
          'Production runtime cleanup failed'
        );
    })());
  try {
    // 平台运行时配置只从 ssr.config.ts runtime 读取。
    const runtime = config.runtime;
    applyTelemetryIntegrationEnv(runtime);
    const sentryIntegration = runtime?.telemetry
      ? runtime.telemetry.integrations?.sentry
      : undefined;
    if (sentryIntegration?.enabled && process.env.SENTRY_DSN) {
      logger.info(`🛰️  Sentry integration 来自 ssr.config.ts runtime.telemetry.integrations`);
    } else if (sentryIntegration?.enabled) {
      logger.warn(`🛰️  Sentry integration 已启用但缺少 SENTRY_DSN，跳过 Sentry adapter`);
    }

    const { fetch: rscHandler } = resolveFetchHandler(
      await import(/* @vite-ignore */ pathToFileURL(rscDistEntry).href)
    );

    const extraConnectSrc = Array.from(
      new Set(
        [runtime?.services?.api, runtime?.services?.telemetry]
          .map(safeOrigin)
          .filter((origin): origin is string => !!origin)
      )
    );

    const app: Express = express();
    app.disable('x-powered-by');
    // Forwarded headers are authoritative only for explicitly trusted deployment proxies.
    app.set('trust proxy', config.server.trustProxy ?? false);
    app.use(createProductionJsonMiddleware()); // 防 JSON 炸弹
    const opsConfig = resolveOpsConfig(config, 'production');
    for (const warning of opsConfig.warnings) {
      logger.warn(`[Ops] ${warning}`);
    }
    // 安全头 —— helmet 默认 + 生产 CSP（prod 不允许 'unsafe-eval'）。
    // 顺序关键：nonce 必须在 helmet 之前生成才能塞进 CSP header 的 script-src。
    // nonce 同时透传到 req header，让下游 RSC handler 给 React 19 SSR 传 nonce 选项，
    // React 自动给所有内联 script (RSC payload / bootstrap) 打 nonce 属性。
    // CSP connect-src 自动加入用户配置的服务 origin（让 CSR-fallback / 业务 fetch 不被挡）
    const { createSecurityMiddleware, createCompressionMiddleware, createCspNonceMiddleware } =
      await import('@/server/middleware');
    app.use(createCspNonceMiddleware());
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
    const cookieDomain = runtime?.cookieDomain;
    app.use((req, res, next) => {
      const { data, needsAnonCookie } = createServerRequestContext(req);
      if (needsAnonCookie) applyAnonCookie(res, data.anonId, cookieDomain);
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
    let manifestLoader:
      | import('@/experiments/ManifestLoader').ManifestLoaderInstance
      | null
      | undefined;
    let exposureQueue:
      | import('@/experiments/ExposureQueue').ExposureQueueInstance
      | null
      | undefined;
    if (hasStaticExps || hasManifest) {
      const baseOrigin = runtime?.services?.api;
      const { createABVariantMiddleware } = await import('@/middlewares/ABVariantMiddleware');
      const { resolveManifestLoader } = await import('@/experiments/ManifestLoader');
      const { resolveExposureQueue } = await import('@/experiments/ExposureQueue');

      manifestLoader = resolveManifestLoader(
        runtime?.experimentManifest,
        runtime?.experiments ?? {},
        baseOrigin
      );
      if (manifestLoader) {
        cleanups.push(() => manifestLoader?.destroy());
        await manifestLoader.init();
      }

      exposureQueue = resolveExposureQueue(runtime?.experimentTracking, baseOrigin);
      cleanups.push(async () => {
        try {
          await exposureQueue?.flush();
        } finally {
          exposureQueue?.destroy();
        }
      });

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
      app.get('/health', createOpsAuthMiddleware('health', opsConfig), (_req, res) => {
        res.json({
          status: 'healthy',
          version: pkg.version,
          mode: 'plugin-rsc-production',
          timestamp: new Date().toISOString(),
        });
      });
    }

    options.setupRoutes?.(app);

    // Immutable SSG HTML seeds the response cache below; it must not bypass invalidation.

    // 客户端资源先于响应缓存；HTML 由下面的清单索引和 SSG 缓存管理。
    app.use(createStaticAssetMiddleware(clientDir));

    // /assets/* 404 guard —— 走到这里说明 express.static 没找到文件（fallthrough）。
    // 资产路径绝不可走 SSR fallback：浏览器 strict MIME 检查会因拿到 text/html 拒绝
    // 当 CSS/JS 用。客户端老 hash 资产请求（部署后 hash 变化）应当返真 404，让浏览器
    // 知道资源不存在而不是收到错误 MIME 的 HTML 页面。
    app.use('/assets', (_req, res) => {
      res.status(404).set('Cache-Control', 'no-store').end();
    });

    // 图片优化端点（/_/img）—— 与开发环境共享显式远程来源策略
    const { createImageMiddleware } = await import('@/plugin/createImagePlugin');
    const { resolveImageOptions } = await import('@/config/resolveImageOptions');
    app.use(createImageMiddleware(resolveImageOptions(config.runtime.images), {}, clientDir));

    // ISR 缓存：只读取 ssr.config.ts runtime.redis；环境变量需由业务配置显式注入。
    const { createAutoCacheStore } = await import('@/cache/createAutoCacheStore');
    const { RedisInvalidationBus } = await import('@/cache/RedisInvalidationBus');
    const { hasRuntimeRedisConnection, resolveRuntimeRedisConfig } =
      await import('@/config/resolveRuntimeRedis');
    const redisCfg = resolveRuntimeRedisConfig(runtime?.redis);
    const hasRedisConfig = hasRuntimeRedisConnection(runtime?.redis);
    const cacheRoutes = { ...config.routes };
    for (const route of ssgRoutes) {
      const rule = cacheRoutes[route];
      cacheRoutes[route] = typeof rule === 'object' ? { ...rule, mode: 'ssg' } : 'ssg';
    }
    const cache = createIsrCacheHandler(
      { ...config, routes: cacheRoutes },
      {
        buildId: process.env.APP_VERSION ?? staticCspIndex.buildId,
        resolveInvalidationPath: resolveSsgIdentity,
        staticSeedInfo: pathname => {
          const htmlPath = ssgFiles.get(pathname);
          if (!htmlPath) return;
          const generatedAt = staticCspIndex.generatedAt?.get(htmlPath);
          return generatedAt === undefined || generatedAt > Date.now()
            ? undefined
            : { generatedAt };
        },
        staticSeed: async (pathname, policy) => {
          const htmlPath = ssgFiles.get(pathname);
          if (!htmlPath) return;
          const hashes = staticCspIndex.scriptHashes.get(htmlPath);
          if (!hashes) return;
          const absolute = path.join(clientDir, htmlPath);
          const body = await fs.readFile(absolute);
          const generatedAt = staticCspIndex.generatedAt?.get(htmlPath);
          if (generatedAt === undefined) return;
          return {
            body,
            statusCode: 200,
            contentType: 'text/html; charset=utf-8',
            headers: {
              'content-type': 'text/html; charset=utf-8',
              'content-security-policy': applyStaticScriptPolicy(policy, hashes),
              'cache-control': 'no-cache',
              'x-served-by': 'ssg-static',
            },
            storedAt: generatedAt,
            expiresAt: 0,
            hardExpiresAt: 0,
            tags: [],
          };
        },
        store: createAutoCacheStore({
          responseNamespace: `production:${process.env.ISR_CACHE_NAMESPACE ?? 'default'}`,
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
      }
    );
    cleanups.push(() => cache.destroy());
    // Inventory 端点必须在 ISR cache 之前挂 —— 路径已在 isBypassPath 内不会被缓存,
    // 但提前挂可以避开 cache handler 的 res.once('finish') metric 记录这次 admin 请求。
    if (opsConfig.inventory.enabled) {
      const { createCacheInspectorMiddleware } =
        await import('@/plugin/createCacheInspectorMiddleware');
      app.use(createCacheInspectorMiddleware(cache, opsConfig));
      logger.info('🔍 ISR cache inventory 已启用：GET /__isr/cache/inventory');
    }

    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      let logical: string;
      try {
        logical = decodeHtmlPathname(req.path);
      } catch {
        res.status(400).end();
        return;
      }
      const known = ssgAliases.get(logical);
      if (!known) return next();
      const canonical = resolveSsgIdentity(req.path);
      if (req.path === canonical) return next();
      const queryStart = req.url.indexOf('?');
      res.redirect(308, canonical + (queryStart < 0 ? '' : req.url.slice(queryStart)));
    });
    app.use(cache);
    const staticHtml = createStaticHtmlMiddleware(clientDir, staticCspIndex);
    app.use((req, res, next) => {
      // Runtime SSG misses must reach the renderer; other indexed documents remain static.
      if (
        res.getHeader('X-Resolved-Mode') === 'ssg' ||
        (ssgAliases.has(decodeHtmlPathname(req.path)) &&
          explicitRoutes.has(decodeHtmlPathname(req.path)))
      )
        return next();
      staticHtml(req, res, next);
    });

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
    cleanups.push(() => seo.shutdown());
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
    const { renderError500Html } = await import('@/defaults/runtime/error500-template');
    const { getTraceId } = await import('@/context/RequestContext');
    app.all(
      /.*/,
      createProductionRequestHandler(rscHandler, (err, _req, res) => {
        logger.error('[Server]', '请求处理异常', err);
        if (!res.headersSent) {
          const traceId = getTraceId();
          res.status(500).type('text/html; charset=utf-8').send(renderError500Html(traceId));
        } else {
          res.destroy();
        }
      })
    );

    return { app, close };
  } catch (error) {
    await close().catch(cleanupError =>
      logger.error('[Server]', 'Production initialization cleanup failed', cleanupError)
    );
    throw error;
  }
}

// ─── Node req ↔ Web Request/Response 适配 ───
// 导出以便单测覆盖（纯函数 + 协议适配）

const rawRequestBodies = new WeakMap<object, Buffer>();

export function createProductionJsonMiddleware(): express.RequestHandler {
  return express.json({
    limit: '1mb',
    verify: (req, _res, body) => {
      rawRequestBodies.set(req, Buffer.from(body));
    },
  });
}

/** Own cancellation until the outgoing response finishes, not IncomingMessage.close. */
export function createProductionRequestHandler(
  handler: (request: Request) => Promise<Response>,
  onError: (error: unknown, req: express.Request, res: express.Response) => void
): express.RequestHandler {
  return async (req, res) => {
    const controller = new AbortController();
    const cleanup = () => {
      req.removeListener('aborted', onAborted);
      res.removeListener('close', onClose);
      res.removeListener('finish', cleanup);
    };
    const onAborted = () => {
      controller.abort(new DOMException('Client disconnected', 'AbortError'));
      cleanup();
    };
    const onClose = () => {
      if (!res.writableFinished) onAborted();
      else cleanup();
    };
    req.once('aborted', onAborted);
    res.once('close', onClose);
    res.once('finish', cleanup);
    if (req.aborted || res.destroyed) onAborted();
    try {
      if (controller.signal.aborted) return;
      const response = await handler(nodeToWebRequest(req, controller.signal));
      if (controller.signal.aborted) {
        // Upstream cleanup is cooperative: a stalled cancel hook must not retain
        // this disconnected request's handler. Observe rejection without awaiting it.
        void response.body?.cancel(controller.signal.reason).catch(() => {
          // The peer is already gone; cancellation failures cannot produce a response.
        });
        return;
      }
      await pipeWebResponse(response, res);
    } catch (error) {
      if (!controller.signal.aborted) onError(error, req, res);
    } finally {
      if (controller.signal.aborted || res.writableFinished) cleanup();
    }
  };
}

export function nodeToWebRequest(req: express.Request, signal?: AbortSignal): Request {
  const host = String(req.headers.host || 'localhost');
  // Express evaluates its configured trust proxy function and selects the first token.
  // Reject arbitrary schemes by falling back to the actual connection transport.
  const transport = (req.socket as typeof req.socket & { encrypted?: boolean })?.encrypted
    ? 'https'
    : 'http';
  const selected = req.protocol?.toLowerCase();
  const proto = selected === 'https' || selected === 'http' ? selected : transport;
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
  const init: RequestInit & { duplex?: 'half' } = { method, headers, signal };
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = (rawRequestBodies.get(req) ?? Readable.toWeb(req)) as unknown as BodyInit;
    init.duplex = 'half';
  }
  return new Request(url, init);
}

export async function pipeWebResponse(response: Response, res: express.Response): Promise<void> {
  res.status(response.status);
  response.headers.forEach((v, k) => {
    if (k.toLowerCase() === 'content-length' || k.toLowerCase() === 'set-cookie') return;
    res.setHeader(k, v);
  });

  const cookies = response.headers.getSetCookie();
  if (cookies.length) {
    const existing = res.getHeader?.('set-cookie');
    res.setHeader('set-cookie', [
      ...(existing == null ? [] : Array.isArray(existing) ? existing : [String(existing)]),
      ...cookies,
    ]);
  }

  if (!response.body) {
    res.end();
    return;
  }

  const nodeReadable = Readable.fromWeb(
    response.body as unknown as import('node:stream/web').ReadableStream
  );
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      res.removeListener?.('close', onClose);
      res.removeListener?.('error', onError);
    };
    const onClose = () => {
      nodeReadable.destroy(); // fromWeb forwards destruction to reader.cancel().
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      nodeReadable.destroy();
      cleanup();
      reject(error);
    };
    res.once('close', onClose);
    res.once('error', onError);
    nodeReadable.once('end', () => {
      cleanup();
      resolve();
    });
    nodeReadable.once('error', error => {
      cleanup();
      if (res.headersSent) res.destroy?.(error);
      reject(error);
    });
    if (res.destroyed) onClose();
    else nodeReadable.pipe(res);
  });
}

/** Static HTML can only be served from the build index validated before startup. */
export function createStaticHtmlMiddleware(
  clientDir: string,
  index: StaticCspIndex
): express.RequestHandler {
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let pathname: string;
    try {
      pathname = decodeHtmlPathname(req.path);
    } catch {
      res.status(400).end();
      return;
    }
    const relative = pathname.slice(1);
    const htmlPath =
      relative.endsWith('/') || !relative
        ? relative + 'index.html'
        : relative.toLowerCase().endsWith('.html')
          ? relative
          : relative + '/index.html';
    const hashes = index.scriptHashes.get(htmlPath);
    if (!hashes) return next();
    res.setHeader(
      'Content-Security-Policy',
      applyStaticScriptPolicy(
        String(res.getHeader('Content-Security-Policy') ?? "default-src 'self'"),
        hashes
      )
    );
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('X-Served-By', 'ssg-static');
    res.sendFile(htmlPath, { root: clientDir, maxAge: '1h', dotfiles: 'ignore' }, error => {
      if (error) next(error);
    });
  };
}

/** Asset serving must never discover HTML outside the validated build manifest. */
export function createStaticAssetMiddleware(clientDir: string): express.RequestHandler {
  const assets = express.static(clientDir, {
    index: false,
    redirect: false,
    maxAge: '1h',
    fallthrough: true,
    setHeaders: (res, filePath) => {
      if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else if (/\.(jpe?g|png|webp|avif|gif|svg|ico|woff2?)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=604800, stale-while-revalidate=86400');
      }
    },
  });
  return (req, res, next) => {
    let pathname: string;
    try {
      // Preserve origin-form leading slashes; //file.html is a path, never an authority.
      pathname = path.posix.normalize(
        decodeURIComponent(new URL(`http://localhost${req.path}`).pathname).replaceAll('\\', '/')
      );
    } catch {
      res.status(400).end();
      return;
    }
    if (['.html', '.htm'].includes(path.posix.extname(pathname).toLowerCase())) return next();
    assets(req, res, next);
  };
}
