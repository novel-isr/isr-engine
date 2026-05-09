import fs from 'node:fs';
import path from 'node:path';

import type {
  RuntimeConfig,
  RuntimeTelemetryConfig,
  RuntimeTelemetryEndpointOptions,
} from '../types';
import type { BrowserObservabilityOptions } from '../defaults/runtime/browserObservability';

const DEFAULT_ANALYTICS_PATH = '/api/observability/analytics';
const DEFAULT_ERRORS_PATH = '/api/observability/errors';

// SDK 内部参数 —— 不是业务决策，跟 Sentry/Datadog SDK 同档默认值。
// 业务侧不需要在 ssr.config.ts 写这些；engine 在序列化客户端配置时统一注入。
const ANALYTICS_BATCH_SIZE = 20;
const ERRORS_BATCH_SIZE = 10;
const FLUSH_INTERVAL_MS = 3_000;
const ANALYTICS_MAX_QUEUE = 500;
const ERRORS_MAX_QUEUE = 200;
const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 30_000;

export interface ResolveClientObservabilityOptionsInput {
  runtime?: RuntimeConfig;
  root?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the public browser telemetry config from ssr.config.ts runtime.
 *
 * Only this whitelisted shape may be serialized into the client bundle. Never
 * pass the whole runtime object to the browser because it can contain Redis,
 * Sentry DSN, private service URLs, and other server-only integration settings.
 */
export function resolveClientObservabilityOptions({
  runtime,
  root = process.cwd(),
  env = process.env,
}: ResolveClientObservabilityOptionsInput): BrowserObservabilityOptions | false | null {
  const config = runtime?.telemetry;
  if (config === false) return false;
  if (!config) return null;

  const serviceOrigin = runtime?.services?.telemetry ?? runtime?.services?.api ?? '';
  const app = config.app ?? readPackageName(root) ?? 'novel-isr-app';

  return {
    app,
    release: config.release ?? env.VITE_APP_VERSION ?? env.APP_VERSION ?? env.npm_package_version,
    environment: config.environment ?? env.NODE_ENV ?? env.MODE,
    includeQueryString: config.includeQueryString,
    analytics: resolveAnalyticsConfig(config, serviceOrigin),
    errorReporting: resolveErrorReportingConfig(config, serviceOrigin),
  };
}

function resolveAnalyticsConfig(
  config: RuntimeTelemetryConfig,
  serviceOrigin: string
): BrowserObservabilityOptions['analytics'] {
  if (config.events === false) return false;
  const events = config.events;
  return {
    endpoint: resolveEndpoint(events, serviceOrigin, DEFAULT_ANALYTICS_PATH),
    sampleRate: events.sampleRate,
    batchSize: ANALYTICS_BATCH_SIZE,
    flushIntervalMs: FLUSH_INTERVAL_MS,
    maxQueueSize: ANALYTICS_MAX_QUEUE,
    retryBaseDelayMs: RETRY_BASE_DELAY_MS,
    retryMaxDelayMs: RETRY_MAX_DELAY_MS,
    webVitals: config.webVitals === false ? false : (config.webVitals?.enabled ?? true),
    trackInitialPage: events.trackInitialPage,
  };
}

function resolveErrorReportingConfig(
  config: RuntimeTelemetryConfig,
  serviceOrigin: string
): BrowserObservabilityOptions['errorReporting'] {
  if (config.errors === false) return false;
  const errors = config.errors;
  return {
    endpoint: resolveEndpoint(errors, serviceOrigin, DEFAULT_ERRORS_PATH),
    sampleRate: errors.sampleRate,
    batchSize: ERRORS_BATCH_SIZE,
    flushIntervalMs: FLUSH_INTERVAL_MS,
    maxQueueSize: ERRORS_MAX_QUEUE,
    retryBaseDelayMs: RETRY_BASE_DELAY_MS,
    retryMaxDelayMs: RETRY_MAX_DELAY_MS,
    captureResourceErrors: errors.captureResourceErrors,
  };
}

function resolveEndpoint(
  options: RuntimeTelemetryEndpointOptions,
  serviceOrigin: string,
  defaultPath: string
): string {
  return joinEndpoint(serviceOrigin, options.endpoint ?? defaultPath);
}

function joinEndpoint(origin: string, endpoint: string): string {
  if (/^https?:\/\//i.test(endpoint)) return endpoint;
  if (!origin) return endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  return `${origin.replace(/\/+$/, '')}/${endpoint.replace(/^\/+/, '')}`;
}

function readPackageName(root: string): string | undefined {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(root, 'package.json'), 'utf8')) as {
      name?: unknown;
    };
    return typeof pkg.name === 'string' && pkg.name.trim() ? pkg.name : undefined;
  } catch {
    return undefined;
  }
}
