/**
 * Browser observability bridge.
 *
 * isr-engine must not hard-code a vendor or a backend. It only owns the browser
 * lifecycle points: app boot, page navigation and Server Action failures.
 *
 * The concrete SDKs are optional peer libraries:
 *   - @novel-isr/analytics
 *   - @novel-isr/error-reporting
 *
 * If an app has not installed them yet, the bridge degrades to no-op. Rendering,
 * hydration and navigation must never depend on observability.
 */

export interface BrowserObservabilityUser {
  id?: string;
  tenantId?: string;
  segment?: string;
  traits?: Record<string, unknown>;
}

export interface BrowserAnalyticsOptions {
  endpoint?: string;
  sampleRate?: number;
  batchSize?: number;
  flushIntervalMs?: number;
  webVitals?: boolean;
  trackInitialPage?: boolean;
}

export interface BrowserErrorReportingOptions {
  endpoint?: string;
  sampleRate?: number;
  batchSize?: number;
  flushIntervalMs?: number;
  captureResourceErrors?: boolean;
}

export interface BrowserObservabilityOptions {
  app: string;
  release?: string;
  environment?: string;
  user?: BrowserObservabilityUser;
  includeQueryString?: boolean;
  analytics?: false | BrowserAnalyticsOptions;
  errorReporting?: false | BrowserErrorReportingOptions;
  /**
   * Tests can inject module loaders. Production uses dynamic import so the
   * optional SDKs are not bundled unless the app installs and configures them.
   */
  moduleLoader?: BrowserObservabilityModuleLoader;
  onSetupError?: (error: unknown, moduleName: string) => void;
}

export interface BrowserObservabilityHandle {
  page(url?: URL | string): void;
  captureActionError(error: unknown, actionId: string): void;
  shutdown(): void;
}

export type BrowserObservabilityModuleLoader = (
  moduleName: '@novel-isr/analytics' | '@novel-isr/error-reporting'
) => Promise<unknown>;

interface AnalyticsModule {
  initAnalytics(options: Record<string, unknown>): AnalyticsClientLike;
}

interface AnalyticsClientLike {
  page(path?: string, options?: Record<string, unknown>): void;
  installWebVitals?(): () => void;
  flush?(): Promise<void> | void;
  shutdown?(): void;
}

interface ErrorReportingModule {
  initErrorReporter(options: Record<string, unknown>): ErrorReporterLike;
  installGlobalErrorHandlers?(
    reporter?: ErrorReporterLike | null,
    options?: Record<string, unknown>
  ): () => void;
}

interface ErrorReporterLike {
  captureException(error: unknown, context?: Record<string, unknown>): void;
  flush?(): Promise<void> | void;
  shutdown?(): void;
  installGlobalHandlers?(options?: Record<string, unknown>): () => void;
}

export async function installBrowserObservability(
  options: BrowserObservabilityOptions
): Promise<BrowserObservabilityHandle> {
  const loader = options.moduleLoader ?? dynamicImportOptional;
  const cleanups: Array<() => void> = [];
  let analytics: AnalyticsClientLike | null = null;
  let errorReporter: ErrorReporterLike | null = null;

  if (options.analytics !== false) {
    try {
      const analyticsModule = (await loader('@novel-isr/analytics')) as Partial<AnalyticsModule>;
      if (typeof analyticsModule.initAnalytics === 'function') {
        analytics = analyticsModule.initAnalytics({
          app: options.app,
          endpoint: options.analytics?.endpoint,
          release: options.release,
          environment: options.environment,
          user: options.user,
          includeQueryString: options.includeQueryString,
          sampleRate: options.analytics?.sampleRate,
          batchSize: options.analytics?.batchSize,
          flushIntervalMs: options.analytics?.flushIntervalMs,
        });
        if (options.analytics?.webVitals && typeof analytics.installWebVitals === 'function') {
          cleanups.push(analytics.installWebVitals());
        }
        if (options.analytics?.trackInitialPage !== false) {
          analytics.page();
        }
      }
    } catch (err) {
      options.onSetupError?.(err, '@novel-isr/analytics');
    }
  }

  if (options.errorReporting !== false) {
    try {
      const errorModule = (await loader(
        '@novel-isr/error-reporting'
      )) as Partial<ErrorReportingModule>;
      if (typeof errorModule.initErrorReporter === 'function') {
        errorReporter = errorModule.initErrorReporter({
          app: options.app,
          endpoint: options.errorReporting?.endpoint,
          release: options.release,
          environment: options.environment,
          user: options.user,
          includeQueryString: options.includeQueryString,
          sampleRate: options.errorReporting?.sampleRate,
          batchSize: options.errorReporting?.batchSize,
          flushIntervalMs: options.errorReporting?.flushIntervalMs,
        });
        const globalCleanup =
          typeof errorModule.installGlobalErrorHandlers === 'function'
            ? errorModule.installGlobalErrorHandlers(errorReporter, {
                captureResourceErrors: options.errorReporting?.captureResourceErrors,
              })
            : errorReporter.installGlobalHandlers?.({
                captureResourceErrors: options.errorReporting?.captureResourceErrors,
              });
        if (globalCleanup) cleanups.push(globalCleanup);
      }
    } catch (err) {
      options.onSetupError?.(err, '@novel-isr/error-reporting');
    }
  }

  return {
    page(url) {
      if (!analytics) return;
      analytics.page(typeof url === 'string' ? url : url ? toPagePath(url) : undefined);
    },
    captureActionError(error, actionId) {
      errorReporter?.captureException(error, {
        source: 'server-action',
        tags: { actionId },
      });
    },
    shutdown() {
      for (const cleanup of cleanups.splice(0)) {
        cleanup();
      }
      analytics?.shutdown?.();
      errorReporter?.shutdown?.();
    },
  };
}

function toPagePath(url: URL): string {
  return `${url.pathname}${url.search}`;
}

async function dynamicImportOptional(moduleName: string): Promise<unknown> {
  const dynamicImport = new Function('m', 'return import(m)') as (m: string) => Promise<unknown>;
  return dynamicImport(moduleName);
}
