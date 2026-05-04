import fs from 'node:fs';
import path from 'node:path';

import type {
  RuntimeConfig,
  RuntimeObservabilityConfig,
  RuntimeObservabilityEndpointOptions,
} from '../types';
import type { BrowserObservabilityOptions } from '../defaults/runtime/browserObservability';

const DEFAULT_ANALYTICS_PATH = '/api/observability/analytics';
const DEFAULT_ERRORS_PATH = '/api/observability/errors';

export interface ResolveClientObservabilityOptionsInput {
  runtime?: RuntimeConfig;
  root?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the public browser observability config from ssr.config.ts runtime.
 *
 * Only this whitelisted shape may be serialized into the client bundle. Never
 * pass the whole runtime object to the browser because it can contain Redis,
 * Sentry DSN, private service URLs, and other server-only settings.
 */
export function resolveClientObservabilityOptions({
  runtime,
  root = process.cwd(),
  env = process.env,
}: ResolveClientObservabilityOptionsInput): BrowserObservabilityOptions | false | null {
  const config = runtime?.observability;
  if (config === false) return false;
  if (!config) return null;

  const serviceOrigin =
    runtime?.services?.observability ?? runtime?.services?.api ?? runtime?.api ?? '';
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
  config: RuntimeObservabilityConfig,
  serviceOrigin: string
): BrowserObservabilityOptions['analytics'] {
  if (config.analytics === false) return false;
  const analytics = config.analytics ?? {};
  return {
    endpoint: resolveEndpoint(analytics, serviceOrigin, DEFAULT_ANALYTICS_PATH),
    sampleRate: analytics.sampleRate,
    batchSize: analytics.batchSize,
    flushIntervalMs: analytics.flushIntervalMs,
    maxQueueSize: analytics.maxQueueSize,
    retryBaseDelayMs: analytics.retryBaseDelayMs,
    retryMaxDelayMs: analytics.retryMaxDelayMs,
    webVitals: analytics.webVitals ?? true,
    trackInitialPage: analytics.trackInitialPage,
  };
}

function resolveErrorReportingConfig(
  config: RuntimeObservabilityConfig,
  serviceOrigin: string
): BrowserObservabilityOptions['errorReporting'] {
  if (config.errorReporting === false) return false;
  const errorReporting = config.errorReporting ?? {};
  return {
    endpoint: resolveEndpoint(errorReporting, serviceOrigin, DEFAULT_ERRORS_PATH),
    sampleRate: errorReporting.sampleRate,
    batchSize: errorReporting.batchSize,
    flushIntervalMs: errorReporting.flushIntervalMs,
    maxQueueSize: errorReporting.maxQueueSize,
    retryBaseDelayMs: errorReporting.retryBaseDelayMs,
    retryMaxDelayMs: errorReporting.retryMaxDelayMs,
    captureResourceErrors: errorReporting.captureResourceErrors ?? true,
  };
}

function resolveEndpoint(
  options: RuntimeObservabilityEndpointOptions,
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
