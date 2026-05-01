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
 * If an app has not installed them yet but endpoints are configured, the bridge
 * uses the built-in HTTP fallback. Rendering, hydration and navigation must
 * never depend on observability.
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
      analytics = createFallbackAnalytics(options);
      if (
        analytics &&
        options.analytics?.webVitals &&
        typeof analytics.installWebVitals === 'function'
      ) {
        cleanups.push(analytics.installWebVitals());
      }
      if (analytics && options.analytics?.trackInitialPage !== false) {
        analytics.page();
      }
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
      errorReporter = createFallbackErrorReporter(options);
      const globalCleanup = errorReporter?.installGlobalHandlers?.({
        captureResourceErrors: options.errorReporting?.captureResourceErrors,
      });
      if (globalCleanup) cleanups.push(globalCleanup);
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

function createFallbackAnalytics(options: BrowserObservabilityOptions): AnalyticsClientLike | null {
  const analyticsOptions = options.analytics === false ? undefined : options.analytics;
  const endpoint = analyticsOptions?.endpoint;
  if (!endpoint) return null;

  const base = createFallbackBase(options, {
    endpoint,
    batchSize: analyticsOptions?.batchSize ?? 20,
    flushIntervalMs: analyticsOptions?.flushIntervalMs ?? 3000,
    sampleRate: analyticsOptions?.sampleRate ?? 1,
    key: 'novel_isr_builtin_analytics',
  });

  return {
    page(path) {
      base.enqueue({
        name: 'page_view',
        properties: {
          path: path ?? currentPath(options.includeQueryString),
          title: isBrowser() && typeof document.title === 'string' ? document.title : undefined,
          referrer:
            isBrowser() && typeof document.referrer === 'string' ? document.referrer : undefined,
        },
      });
    },
    installWebVitals() {
      return installFallbackWebVitals(base);
    },
    flush() {
      return base.flush();
    },
    shutdown() {
      base.shutdown();
    },
  };
}

function createFallbackErrorReporter(
  options: BrowserObservabilityOptions
): ErrorReporterLike | null {
  const errorOptions = options.errorReporting === false ? undefined : options.errorReporting;
  const endpoint = errorOptions?.endpoint;
  if (!endpoint) return null;

  const base = createFallbackBase(options, {
    endpoint,
    batchSize: errorOptions?.batchSize ?? 10,
    flushIntervalMs: errorOptions?.flushIntervalMs ?? 3000,
    sampleRate: errorOptions?.sampleRate ?? 1,
    key: 'novel_isr_builtin_errors',
  });

  const captureException = (error: unknown, context: Record<string, unknown> = {}) => {
    const normalized = normalizeError(error);
    base.enqueue({
      message: normalized.message,
      name: normalized.name,
      stack: normalized.stack,
      level: typeof context.level === 'string' ? context.level : 'error',
      source: typeof context.source === 'string' ? context.source : undefined,
      tags: isRecord(context.tags) ? context.tags : undefined,
      extra: isRecord(context.extra) ? context.extra : undefined,
      fingerprint: Array.isArray(context.fingerprint) ? context.fingerprint : undefined,
    });
  };

  return {
    captureException,
    installGlobalHandlers(globalOptions = {}) {
      if (!isBrowser()) return () => {};
      const captureResourceErrors = globalOptions.captureResourceErrors !== false;
      const onError = (event: ErrorEvent | Event) => {
        if (event instanceof ErrorEvent) {
          captureException(event.error ?? event.message, {
            source: event.filename,
            extra: { lineno: event.lineno, colno: event.colno },
          });
          return;
        }
        if (!captureResourceErrors) return;
        const target = event.target;
        if (target instanceof HTMLElement) {
          const url =
            target instanceof HTMLImageElement || target instanceof HTMLScriptElement
              ? target.src
              : target instanceof HTMLLinkElement
                ? target.href
                : undefined;
          captureException('Resource load failed', {
            level: 'warning',
            source: target.tagName.toLowerCase(),
            extra: { url },
          });
        }
      };
      const onRejection = (event: PromiseRejectionEvent) => {
        captureException(event.reason, { source: 'unhandledrejection' });
      };
      window.addEventListener('error', onError, true);
      window.addEventListener('unhandledrejection', onRejection);
      return () => {
        window.removeEventListener('error', onError, true);
        window.removeEventListener('unhandledrejection', onRejection);
      };
    },
    flush() {
      return base.flush();
    },
    shutdown() {
      base.shutdown();
    },
  };
}

interface FallbackBaseOptions {
  endpoint: string;
  batchSize: number;
  flushIntervalMs: number;
  sampleRate: number;
  key: string;
}

interface FallbackPayload {
  name?: string;
  message?: string;
  [key: string]: unknown;
}

function createFallbackBase(
  options: BrowserObservabilityOptions,
  baseOptions: FallbackBaseOptions
) {
  const queue: FallbackPayload[] = [];
  const sessionId = readOrCreateBrowserId(`${baseOptions.key}_session`);
  const anonymousId = readOrCreateBrowserId(`${baseOptions.key}_anonymous`);
  let timer: number | null = null;

  const flush = async (flushOptions: { beacon?: boolean } = {}) => {
    if (queue.length === 0) return;
    const payloads = queue.splice(0);
    const isError = baseOptions.key.includes('errors');
    const body = JSON.stringify({
      app: options.app,
      sentAt: Date.now(),
      [isError ? 'reports' : 'events']: payloads,
    });
    try {
      await postJson(baseOptions.endpoint, body, flushOptions.beacon);
    } catch {
      queue.unshift(...payloads);
      queue.splice(200);
    }
  };

  const enqueue = (payload: FallbackPayload) => {
    if (baseOptions.sampleRate <= 0) return;
    if (baseOptions.sampleRate < 1 && Math.random() > baseOptions.sampleRate) return;

    queue.push({
      id: createId(baseOptions.key.includes('errors') ? 'err' : 'evt'),
      app: options.app,
      ts: Date.now(),
      release: options.release,
      environment: options.environment,
      sessionId,
      anonymousId,
      user: options.user,
      url: currentPath(options.includeQueryString),
      ...payload,
    });
    if (queue.length >= baseOptions.batchSize) void flush();
  };

  const shutdown = () => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    void flush({ beacon: true });
  };

  if (isBrowser()) {
    if (baseOptions.flushIntervalMs > 0) {
      timer = window.setInterval(() => void flush(), baseOptions.flushIntervalMs);
    }
    const onHidden = () => {
      if (document.visibilityState === 'hidden') void flush({ beacon: true });
    };
    window.addEventListener('pagehide', shutdown);
    document.addEventListener('visibilitychange', onHidden);
  }

  return { enqueue, flush, shutdown };
}

function installFallbackWebVitals(base: ReturnType<typeof createFallbackBase>): () => void {
  if (!isBrowser() || typeof PerformanceObserver === 'undefined') return () => {};
  const cleanups: Array<() => void> = [];
  let cls = 0;

  const observe = (
    type: string,
    callback: (entry: PerformanceEntry & Record<string, unknown>) => void
  ) => {
    try {
      const observer = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          callback(entry as PerformanceEntry & Record<string, unknown>);
        }
      });
      observer.observe({ type, buffered: true });
      cleanups.push(() => observer.disconnect());
    } catch {
      /* Unsupported metric. */
    }
  };

  observe('paint', entry => {
    if (entry.name === 'first-contentful-paint') {
      base.enqueue({ name: 'web_vital', properties: { name: 'FCP', value: entry.startTime } });
    }
  });
  observe('largest-contentful-paint', entry => {
    base.enqueue({ name: 'web_vital', properties: { name: 'LCP', value: entry.startTime } });
  });
  observe('layout-shift', entry => {
    if (entry.hadRecentInput !== true && typeof entry.value === 'number') {
      cls += entry.value;
    }
  });
  observe('event', entry => {
    if (typeof entry.duration === 'number') {
      base.enqueue({ name: 'web_vital', properties: { name: 'INP', value: entry.duration } });
    }
  });

  const nav = performance.getEntriesByType('navigation')[0] as
    | PerformanceNavigationTiming
    | undefined;
  if (nav) {
    base.enqueue({ name: 'web_vital', properties: { name: 'TTFB', value: nav.responseStart } });
  }

  const flushCls = () => {
    if (cls > 0) base.enqueue({ name: 'web_vital', properties: { name: 'CLS', value: cls } });
  };
  window.addEventListener('pagehide', flushCls);
  cleanups.push(() => window.removeEventListener('pagehide', flushCls));
  return () => cleanups.splice(0).forEach(cleanup => cleanup());
}

async function postJson(endpoint: string, body: string, beacon?: boolean): Promise<void> {
  if (beacon && isBrowser() && typeof navigator.sendBeacon === 'function') {
    const payload =
      typeof Blob !== 'undefined' ? new Blob([body], { type: 'application/json' }) : body;
    if (navigator.sendBeacon(endpoint, payload)) return;
  }
  if (typeof fetch !== 'function') return;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    keepalive: beacon,
  });
  if (!response.ok) {
    throw new Error(`observability upload failed: ${response.status}`);
  }
}

function currentPath(includeQueryString?: boolean): string {
  if (!isBrowser()) return '/';
  const { pathname, search } = window.location;
  return includeQueryString ? `${pathname}${search}` : pathname;
}

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function readOrCreateBrowserId(key: string): string {
  if (!isBrowser()) return createId('runtime');
  try {
    const existing = window.localStorage.getItem(key);
    if (existing) return existing;
    const next = createId('runtime');
    window.localStorage.setItem(key, next);
    return next;
  } catch {
    return createId('runtime');
  }
}

function normalizeError(error: unknown): { message: string; name?: string; stack?: string } {
  if (error instanceof Error) {
    return { message: error.message, name: error.name, stack: error.stack };
  }
  if (typeof error === 'string') return { message: error };
  try {
    return { message: JSON.stringify(error) };
  } catch {
    return { message: String(error) };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
