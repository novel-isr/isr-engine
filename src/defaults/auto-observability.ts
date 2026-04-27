/**
 * 环境变量驱动的 SDK 自动装配
 *
 * 用户态：什么都不做。设了 env 就生效，没设走默认（console.error）。
 *
 *   .env
 *     SENTRY_DSN=https://xxx@sentry.io/123       → 自动接 Sentry 服务端
 *     DD_SERVICE=my-app                          → 自动接 Datadog（要求 dd-trace 已安装）
 *     OTEL_EXPORTER_OTLP_ENDPOINT=http://...     → 自动接 OTel（要求 @opentelemetry/* 已安装）
 *
 * 设计：SDK 都是 dynamic import；用户没装就静默跳过（不阻塞启动）。
 * 三个 SDK 同时配置则按 Sentry > Datadog > OTel 优先级生效（互斥，避免重复 span）。
 */
// 不引 Logger（它的 alias 在用户 RSC 上下文不解析）；用 console.* 直出
const logger = {
  info: (...a: unknown[]) => console.log('[novel-isr:auto-obs]', ...a),
  warn: (...a: unknown[]) => console.warn('[novel-isr:auto-obs]', ...a),
};

/**
 * 用 Function 构造器隐藏 import specifier，绕过 rolldown 静态分析
 * —— 这样 SDK 不会被强制解析，用户没装时不会失败构建
 */
const dynamicImport = new Function('m', 'return import(m)') as (m: string) => Promise<unknown>;
async function tryImport(name: string): Promise<unknown> {
  return await dynamicImport(name);
}

export interface AutoServerHooks {
  beforeRequest?: (req: Request, baseline: { traceId: string; startedAt: number }) => unknown;
  onResponse?: (res: Response, ctx: Record<string, unknown>) => void;
  onError?: (err: unknown, req: Request, ctx: Record<string, unknown>) => void;
}

/**
 * 检测 env 自动选 SDK 装配
 * 调用顺序：在 entry.server 加载前后都行；推荐启动时调一次返回的 hooks 用作默认 hooks
 */
export async function createAutoServerHooks(): Promise<AutoServerHooks> {
  const sentryDsn = process.env.SENTRY_DSN;
  const ddService = process.env.DD_SERVICE;
  const otelEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

  if (sentryDsn) return await loadSentry(sentryDsn);
  if (ddService) return await loadDatadog(ddService);
  if (otelEndpoint) return await loadOtel(otelEndpoint);

  logger.info(
    '🛰️  observability: 未检测到 SENTRY_DSN/DD_SERVICE/OTEL_EXPORTER_OTLP_ENDPOINT，使用默认 console 上报'
  );
  return {};
}

/**
 * 走 npm subpath import 而不是相对路径：
 * - 本文件是 raw-shipped src/，被 consumer bundler 当源码处理
 * - 三个 hook factory 在 dist/ 里通过 `./adapters/observability` 子路径已公开 export
 * - 用 subpath 既避免相对路径依赖（src/adapters/* 不在 npm tarball 里），也复用编译产物
 */
type ObservabilityAdapters = typeof import('@novel-isr/engine/adapters/observability');

async function loadObservability(): Promise<ObservabilityAdapters> {
  return (await import('@novel-isr/engine/adapters/observability')) as ObservabilityAdapters;
}

async function loadSentry(dsn: string): Promise<AutoServerHooks> {
  try {
    const Sentry = (await tryImport('@sentry/node')) as {
      init: (opts: Record<string, unknown>) => void;
      startInactiveSpan: (opts: Record<string, unknown>) => unknown;
      captureException: (err: unknown, hint?: Record<string, unknown>) => void;
    };
    Sentry.init({
      dsn,
      tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE ?? '0.1'),
      environment: process.env.NODE_ENV ?? 'production',
    });
    const { createSentryServerHooks } = await loadObservability();
    logger.info(
      `🛰️  observability: Sentry auto-wired (DSN ${dsn.replace(/\/\/[^@]+@/, '//<key>@')})`
    );
    return createSentryServerHooks({
      Sentry: Sentry as unknown as Parameters<typeof createSentryServerHooks>[0]['Sentry'],
    }) as AutoServerHooks;
  } catch (err) {
    logger.warn('🛰️  Sentry auto-wire 失败（@sentry/node 未安装？）→ 走默认上报', err);
    return {};
  }
}

async function loadDatadog(service: string): Promise<AutoServerHooks> {
  try {
    const tracerMod = (await tryImport('dd-trace')) as {
      default: { init: (opts: Record<string, unknown>) => unknown };
    };
    const { createDatadogServerHooks } = await loadObservability();
    const tracer = tracerMod.default.init({
      service,
      env: process.env.DD_ENV ?? process.env.NODE_ENV,
      version: process.env.DD_VERSION,
    }) as Parameters<typeof createDatadogServerHooks>[0]['tracer'];
    logger.info(`🛰️  observability: Datadog auto-wired (service=${service})`);
    return createDatadogServerHooks({ tracer }) as AutoServerHooks;
  } catch (err) {
    logger.warn('🛰️  Datadog auto-wire 失败（dd-trace 未安装？）', err);
    return {};
  }
}

async function loadOtel(endpoint: string): Promise<AutoServerHooks> {
  try {
    const { createOtelServerHooks } = await loadObservability();
    const otelApi = (await tryImport('@opentelemetry/api')) as {
      trace: {
        getTracer: (name: string) => Parameters<typeof createOtelServerHooks>[0]['tracer'];
      };
    };
    const tracer = otelApi.trace.getTracer(process.env.OTEL_SERVICE_NAME ?? 'novel-isr-app');
    logger.info(`🛰️  observability: OTel auto-wired (endpoint=${endpoint})`);
    return createOtelServerHooks({ tracer }) as AutoServerHooks;
  } catch (err) {
    logger.warn('🛰️  OTel auto-wire 失败（@opentelemetry/api 未安装？）', err);
    return {};
  }
}
