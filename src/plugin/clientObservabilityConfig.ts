import fs from 'node:fs';
import path from 'node:path';

import type {
  RuntimeConfig,
  RuntimeTelemetryConfig,
  RuntimeTelemetryEndpointOptions,
  RuntimeTelemetryHttpExporterConfig,
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

  const serviceOrigin =
    runtime?.services?.telemetry ?? runtime?.services?.api ?? runtime?.api ?? '';
  const app = config.app ?? readPackageName(root) ?? 'novel-isr-app';
  const httpExporter = findHttpExporter(config);

  return {
    app,
    release: config.release ?? env.VITE_APP_VERSION ?? env.APP_VERSION ?? env.npm_package_version,
    environment: config.environment ?? env.NODE_ENV ?? env.MODE,
    includeQueryString: config.includeQueryString,
    analytics: resolveAnalyticsConfig(config, serviceOrigin, httpExporter),
    errorReporting: resolveErrorReportingConfig(config, serviceOrigin, httpExporter),
  };
}

function resolveAnalyticsConfig(
  config: RuntimeTelemetryConfig,
  serviceOrigin: string,
  httpExporter?: RuntimeTelemetryHttpExporterConfig
): BrowserObservabilityOptions['analytics'] {
  if (config.events === false) return false;
  const events = config.events ?? {};
  return {
    endpoint: resolveEndpoint(
      events,
      serviceOrigin,
      httpExporter?.endpoints?.events ?? DEFAULT_ANALYTICS_PATH
    ),
    sampleRate: events.sampleRate,
    batchSize: events.batchSize,
    flushIntervalMs: events.flushIntervalMs,
    maxQueueSize: events.maxQueueSize,
    retryBaseDelayMs: events.retryBaseDelayMs,
    retryMaxDelayMs: events.retryMaxDelayMs,
    webVitals: config.webVitals === false ? false : (config.webVitals?.enabled ?? true),
    trackInitialPage: events.trackInitialPage,
  };
}

function resolveErrorReportingConfig(
  config: RuntimeTelemetryConfig,
  serviceOrigin: string,
  httpExporter?: RuntimeTelemetryHttpExporterConfig
): BrowserObservabilityOptions['errorReporting'] {
  if (config.errors === false) return false;
  const errors = config.errors ?? {};
  return {
    endpoint: resolveEndpoint(
      errors,
      serviceOrigin,
      httpExporter?.endpoints?.errors ?? DEFAULT_ERRORS_PATH
    ),
    sampleRate: errors.sampleRate,
    batchSize: errors.batchSize,
    flushIntervalMs: errors.flushIntervalMs,
    maxQueueSize: errors.maxQueueSize,
    retryBaseDelayMs: errors.retryBaseDelayMs,
    retryMaxDelayMs: errors.retryMaxDelayMs,
    captureResourceErrors: errors.captureResourceErrors ?? true,
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

function findHttpExporter(
  config: RuntimeTelemetryConfig
): RuntimeTelemetryHttpExporterConfig | undefined {
  return config.exporters?.find(
    (exporter): exporter is RuntimeTelemetryHttpExporterConfig => exporter.type === 'http'
  );
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
