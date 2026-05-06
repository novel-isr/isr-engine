/**
 * Browser observability bridge.
 *
 * isr-engine owns the browser lifecycle points: app boot, page navigation,
 * Web Vitals, global browser errors and Server Action failures. It deliberately
 * does not import a vendor SDK or a project-specific SDK. The only integration
 * contract is HTTP endpoints resolved from ssr.config.ts runtime.telemetry.
 * Rendering, hydration and navigation must never depend on observability.
 */

import {
  __clearBrowserTelemetryHandle,
  __setBrowserTelemetryHandle,
  type TelemetryCaptureOptions,
  type TelemetryEventOptions,
  type TelemetryMeasureOptions,
  type TelemetryRuntimeHandle,
} from '../../runtime/telemetry';

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
  maxQueueSize?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  webVitals?: boolean;
  trackInitialPage?: boolean;
}

export interface BrowserErrorReportingOptions {
  endpoint?: string;
  sampleRate?: number;
  batchSize?: number;
  flushIntervalMs?: number;
  maxQueueSize?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  captureResourceErrors?: boolean;
  /**
   * 当错误来源 / 堆栈匹配下面的正则之一时，丢弃不上报。
   *
   * 默认会过滤 dev-runtime 噪声（@vite/client、react-refresh、HMR ping
   * 等），避免开发态 WebSocket 重连时刷出的 "send was called before
   * connect" 这类错误把 admin observability 通道刷爆。
   *
   * 业务可以在这里追加自己的过滤规则；传 `false` 关掉所有过滤（不推荐）。
   */
  ignoreSourcePatterns?: RegExp[] | false;
}

/** Dev-runtime 噪声 —— 由开发工具链自身产生的错误，并非业务问题。
 * Sentry 风格 inbound filter，industry-standard。 */
const DEFAULT_IGNORE_SOURCE_PATTERNS: RegExp[] = [
  /@vite\/client/,
  /@react-refresh/,
  /__vite_ping/,
  /webpack-internal:\/\//,
  /webpack-hmr/,
  // Chrome extensions
  /^chrome-extension:\/\//,
  /^moz-extension:\/\//,
  /^safari-extension:\/\//,
];

export interface BrowserObservabilityOptions {
  app: string;
  release?: string;
  environment?: string;
  user?: BrowserObservabilityUser;
  includeQueryString?: boolean;
  analytics?: false | BrowserAnalyticsOptions;
  errorReporting?: false | BrowserErrorReportingOptions;
}

export interface BrowserObservabilityHandle {
  track(name: string, properties?: Record<string, unknown>, options?: TelemetryEventOptions): void;
  capture(error: unknown, context?: TelemetryCaptureOptions): void;
  measure(name: string, value: number, options?: TelemetryMeasureOptions): void;
  page(url?: URL | string): void;
  captureActionError(error: unknown, actionId: string): void;
  setUser(user: BrowserObservabilityUser | null): void;
  flush(): Promise<void> | void;
  shutdown(): void;
}

interface AnalyticsClientLike {
  track(name: string, properties?: Record<string, unknown>, options?: TelemetryEventOptions): void;
  page(path?: string, options?: Record<string, unknown>): void;
  measure(name: string, value: number, options?: TelemetryMeasureOptions): void;
  installWebVitals?(): () => void;
  flush?(): Promise<void> | void;
  shutdown?(): void;
}

interface ErrorReporterLike {
  captureException(error: unknown, context?: TelemetryCaptureOptions): void;
  flush?(): Promise<void> | void;
  shutdown?(): void;
  installGlobalHandlers?(options?: Record<string, unknown>): () => void;
}

export async function installBrowserObservability(
  options: BrowserObservabilityOptions
): Promise<BrowserObservabilityHandle> {
  const cleanups: Array<() => void> = [];
  let currentUser: BrowserObservabilityUser | undefined = options.user;
  const getUser = () => currentUser;
  const analytics =
    options.analytics === false ? null : createEndpointAnalyticsClient(options, getUser);
  const errorReporter =
    options.errorReporting === false ? null : createEndpointErrorReporter(options, getUser);

  if (
    analytics &&
    options.analytics !== false &&
    options.analytics?.webVitals &&
    typeof analytics.installWebVitals === 'function'
  ) {
    cleanups.push(analytics.installWebVitals());
  }

  if (analytics && options.analytics !== false && options.analytics?.trackInitialPage !== false) {
    analytics.page();
  }

  const globalCleanup = errorReporter?.installGlobalHandlers?.({
    captureResourceErrors:
      options.errorReporting !== false ? options.errorReporting?.captureResourceErrors : undefined,
  });
  if (globalCleanup) {
    cleanups.push(globalCleanup);
  }

  const handle: BrowserObservabilityHandle & TelemetryRuntimeHandle = {
    track(name, properties, trackOptions) {
      analytics?.track(name, properties, trackOptions);
    },
    capture(error, context) {
      errorReporter?.captureException(error, context);
    },
    measure(name, value, measureOptions) {
      analytics?.measure(name, value, measureOptions);
    },
    page(url) {
      if (!analytics) return;
      analytics.page(
        typeof url === 'string'
          ? sanitizeUrl(url, options.includeQueryString)
          : url
            ? toPagePath(url, options.includeQueryString)
            : undefined
      );
    },
    captureActionError(error, actionId) {
      errorReporter?.captureException(error, {
        source: 'server-action',
        tags: { actionId },
      });
    },
    setUser(user) {
      currentUser = user ?? undefined;
    },
    flush() {
      return Promise.all([analytics?.flush?.(), errorReporter?.flush?.()]).then(() => undefined);
    },
    shutdown() {
      __clearBrowserTelemetryHandle(handle);
      for (const cleanup of cleanups.splice(0)) {
        cleanup();
      }
      analytics?.shutdown?.();
      errorReporter?.shutdown?.();
    },
  };
  __setBrowserTelemetryHandle(handle);
  return handle;
}

function toPagePath(url: URL, includeQueryString?: boolean): string {
  return includeQueryString ? `${url.pathname}${url.search}` : url.pathname;
}

function createEndpointAnalyticsClient(
  options: BrowserObservabilityOptions,
  getUser: () => BrowserObservabilityUser | undefined
): AnalyticsClientLike | null {
  const analyticsOptions = options.analytics === false ? undefined : options.analytics;
  const endpoint = analyticsOptions?.endpoint;
  if (!endpoint) return null;

  const base = createEndpointQueue(
    options,
    {
      endpoint,
      batchSize: analyticsOptions?.batchSize ?? 20,
      flushIntervalMs: analyticsOptions?.flushIntervalMs ?? 3000,
      maxQueueSize: analyticsOptions?.maxQueueSize ?? 500,
      retryBaseDelayMs: analyticsOptions?.retryBaseDelayMs ?? 1000,
      retryMaxDelayMs: analyticsOptions?.retryMaxDelayMs ?? 30000,
      sampleRate: analyticsOptions?.sampleRate ?? 1,
      key: 'novel_isr_builtin_analytics',
    },
    getUser
  );

  return {
    track(name, properties, trackOptions) {
      base.enqueue({
        name,
        properties: properties ?? {},
        tags: normalizeTags(trackOptions?.tags),
      });
    },
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
    measure(name, value, measureOptions) {
      if (!Number.isFinite(value)) return;
      base.enqueue({
        name: 'metric',
        properties: {
          metric: name,
          value,
          unit: measureOptions?.unit,
          ...(measureOptions?.properties ?? {}),
        },
        tags: normalizeTags(measureOptions?.tags),
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

function createEndpointErrorReporter(
  options: BrowserObservabilityOptions,
  getUser: () => BrowserObservabilityUser | undefined
): ErrorReporterLike | null {
  const errorOptions = options.errorReporting === false ? undefined : options.errorReporting;
  const endpoint = errorOptions?.endpoint;
  if (!endpoint) return null;

  const base = createEndpointQueue(
    options,
    {
      endpoint,
      batchSize: errorOptions?.batchSize ?? 10,
      flushIntervalMs: errorOptions?.flushIntervalMs ?? 3000,
      maxQueueSize: errorOptions?.maxQueueSize ?? 200,
      retryBaseDelayMs: errorOptions?.retryBaseDelayMs ?? 1000,
      retryMaxDelayMs: errorOptions?.retryMaxDelayMs ?? 30000,
      sampleRate: errorOptions?.sampleRate ?? 1,
      key: 'novel_isr_builtin_errors',
    },
    getUser
  );

  const captureException = (error: unknown, context: TelemetryCaptureOptions = {}) => {
    const normalized = normalizeError(error);
    base.enqueue({
      message: normalized.message,
      name: normalized.name,
      stack: normalized.stack,
      level: typeof context.level === 'string' ? context.level : 'error',
      source: typeof context.source === 'string' ? context.source : undefined,
      tags: normalizeTags(context.tags),
      extra: isRecord(context.extra) ? context.extra : undefined,
      fingerprint: Array.isArray(context.fingerprint) ? context.fingerprint : undefined,
    });
  };

  // 解析过滤规则：errorOptions.ignoreSourcePatterns
  //   - undefined / 缺省：用 DEFAULT_IGNORE_SOURCE_PATTERNS（开发噪声 + 浏览器扩展）
  //   - false：关闭过滤（不推荐）
  //   - 自定义数组：与默认合并，业务可以追加而不是替换
  const ignorePatterns = resolveIgnorePatterns(errorOptions?.ignoreSourcePatterns);

  return {
    captureException,
    installGlobalHandlers(globalOptions = {}) {
      if (!isBrowser()) return () => {};
      const captureResourceErrors = globalOptions.captureResourceErrors !== false;
      const onError = (event: ErrorEvent | Event) => {
        if (event instanceof ErrorEvent) {
          if (shouldIgnore(ignorePatterns, event.filename, event.error)) return;
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
          if (shouldIgnore(ignorePatterns, url, undefined)) return;
          captureException('Resource load failed', {
            level: 'warning',
            source: target.tagName.toLowerCase(),
            extra: { url: sanitizeUrl(url, options.includeQueryString) },
          });
        }
      };
      const onRejection = (event: PromiseRejectionEvent) => {
        if (shouldIgnore(ignorePatterns, undefined, event.reason)) return;
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
  maxQueueSize: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  sampleRate: number;
  key: string;
}

interface FallbackPayload {
  name?: string;
  message?: string;
  [key: string]: unknown;
}

function createEndpointQueue(
  options: BrowserObservabilityOptions,
  baseOptions: FallbackBaseOptions,
  getUser: () => BrowserObservabilityUser | undefined
) {
  const queue: FallbackPayload[] = [];
  const sessionId = readOrCreateBrowserId(`${baseOptions.key}_session`);
  const anonymousId = readOrCreateBrowserId(`${baseOptions.key}_anonymous`);
  let timer: number | null = null;
  let retryTimer: number | null = null;
  let consecutiveFailures = 0;
  let disposeLifecycleListeners: (() => void) | null = null;

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
      consecutiveFailures = 0;
      if (queue.length === 0) {
        clearRetryTimer();
      }
    } catch {
      queue.unshift(...payloads);
      queue.splice(baseOptions.maxQueueSize);
      consecutiveFailures += 1;
      scheduleRetry();
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
      user: getUser(),
      url: currentPath(options.includeQueryString),
      ...payload,
    });
    if (queue.length > baseOptions.maxQueueSize) {
      queue.splice(0, queue.length - baseOptions.maxQueueSize);
    }
    if (queue.length >= baseOptions.batchSize) void flush();
  };

  const shutdown = () => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    clearRetryTimer();
    disposeLifecycleListeners?.();
    disposeLifecycleListeners = null;
    void flush({ beacon: true });
  };

  const scheduleRetry = () => {
    if (!isBrowser() || retryTimer !== null || queue.length === 0) return;
    const base = Math.max(100, baseOptions.retryBaseDelayMs);
    const max = Math.max(base, baseOptions.retryMaxDelayMs);
    const backoff = Math.min(max, base * 2 ** Math.max(0, consecutiveFailures - 1));
    const jitter = Math.floor(backoff * 0.2 * Math.random());
    retryTimer = window.setTimeout(() => {
      retryTimer = null;
      void flush();
    }, backoff + jitter);
  };

  const clearRetryTimer = () => {
    if (retryTimer !== null && isBrowser()) {
      window.clearTimeout(retryTimer);
    }
    retryTimer = null;
  };

  if (isBrowser()) {
    if (baseOptions.flushIntervalMs > 0) {
      timer = window.setInterval(() => void flush(), baseOptions.flushIntervalMs);
    }
    const flushOnPageHide = () => void flush({ beacon: true });
    const onHidden = () => {
      if (document.visibilityState === 'hidden') void flush({ beacon: true });
    };
    const onOnline = () => void flush();
    window.addEventListener('pagehide', flushOnPageHide);
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onHidden);
    disposeLifecycleListeners = () => {
      window.removeEventListener('pagehide', flushOnPageHide);
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onHidden);
    };
  }

  return { enqueue, flush, shutdown };
}

function installFallbackWebVitals(base: ReturnType<typeof createEndpointQueue>): () => void {
  if (!isBrowser() || typeof PerformanceObserver === 'undefined') return () => {};
  const cleanups: Array<() => void> = [];
  let cls = 0;
  let lcp = 0;
  let inp = 0;

  const observe = (
    type: string,
    callback: (entry: PerformanceEntry & Record<string, unknown>) => void,
    options: Record<string, unknown> = {}
  ) => {
    try {
      const observer = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          callback(entry as PerformanceEntry & Record<string, unknown>);
        }
      });
      observer.observe({ type, buffered: true, ...options });
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
    lcp = entry.startTime;
  });
  observe('layout-shift', entry => {
    if (entry.hadRecentInput !== true && typeof entry.value === 'number') {
      cls += entry.value;
    }
  });
  observe(
    'event',
    entry => {
      if (
        typeof entry.duration === 'number' &&
        typeof entry.interactionId === 'number' &&
        entry.interactionId > 0
      ) {
        inp = Math.max(inp, entry.duration);
      }
    },
    { durationThreshold: 40 }
  );

  const flushFinalVitals = () => {
    if (lcp > 0) {
      base.enqueue({
        name: 'web_vital',
        properties: { name: 'LCP', value: lcp },
      });
    }
    if (inp > 0) {
      base.enqueue({
        name: 'web_vital',
        properties: { name: 'INP', value: inp },
      });
    }
    if (cls > 0) {
      base.enqueue({
        name: 'web_vital',
        properties: { name: 'CLS', value: cls },
      });
    }
  };

  const nav = performance.getEntriesByType('navigation')[0] as
    | PerformanceNavigationTiming
    | undefined;
  if (nav) {
    base.enqueue({
      name: 'web_vital',
      properties: { name: 'TTFB', value: nav.responseStart },
    });
  }

  const flushIfHidden = () => {
    if (document.visibilityState === 'hidden') flushFinalVitals();
  };
  window.addEventListener('pagehide', flushFinalVitals);
  document.addEventListener('visibilitychange', flushIfHidden);
  cleanups.push(() => {
    window.removeEventListener('pagehide', flushFinalVitals);
    document.removeEventListener('visibilitychange', flushIfHidden);
  });
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

function sanitizeUrl(url: string | undefined, includeQueryString?: boolean): string | undefined {
  if (!url) return undefined;
  if (includeQueryString) return url;
  try {
    const parsed = new URL(url, isBrowser() ? window.location.origin : 'http://localhost');
    return parsed.origin === 'http://localhost' && !/^https?:\/\//i.test(url)
      ? parsed.pathname
      : `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split('?')[0]?.split('#')[0];
  }
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

/** 解析 ignoreSourcePatterns 选项 —— false 关闭过滤；数组与默认合并；缺省走默认。 */
export function resolveIgnorePatterns(custom: RegExp[] | false | undefined): RegExp[] {
  if (custom === false) return [];
  if (Array.isArray(custom)) return [...DEFAULT_IGNORE_SOURCE_PATTERNS, ...custom];
  return DEFAULT_IGNORE_SOURCE_PATTERNS;
}

/** 判断错误是否来自 dev-runtime 等噪声源。
 * 命中 ignorePatterns 任一 → 丢弃。检查 source URL + error.stack 两条。 */
export function shouldIgnore(
  ignorePatterns: RegExp[],
  source: string | undefined,
  reason: unknown
): boolean {
  if (ignorePatterns.length === 0) return false;
  if (typeof source === 'string') {
    for (const re of ignorePatterns) if (re.test(source)) return true;
  }
  // reason 通常是 Error 实例；其 stack 是字符串。也可能是字符串本身。
  if (reason && typeof reason === 'object' && 'stack' in reason) {
    const stack = (reason as { stack?: unknown }).stack;
    if (typeof stack === 'string') {
      for (const re of ignorePatterns) if (re.test(stack)) return true;
    }
  }
  if (typeof reason === 'string') {
    for (const re of ignorePatterns) if (re.test(reason)) return true;
  }
  return false;
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

function normalizeTags(
  tags: TelemetryEventOptions['tags'] | undefined
): Record<string, string> | undefined {
  if (!tags) return undefined;
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags)) {
    if (value === undefined || value === null) continue;
    normalized[key] = String(value);
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}
