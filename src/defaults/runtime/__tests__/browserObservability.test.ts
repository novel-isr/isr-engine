import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  installBrowserObservability,
  resolveIgnorePatterns,
  shouldIgnore,
} from '../browserObservability';
import {
  capture,
  getTelemetry,
  measure,
  setTelemetryUser,
  track,
} from '../../../runtime/telemetry';

describe('installBrowserObservability', () => {
  afterEach(() => {
    getTelemetry()?.shutdown();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('uploads page views and Server Action errors through configured endpoints', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    const handle = await installBrowserObservability({
      app: 'novel-rating',
      release: '1.0.0',
      environment: 'test',
      analytics: {
        endpoint: 'https://admin.local/api/observability/analytics',
        batchSize: 1,
        webVitals: false,
      },
      errorReporting: {
        endpoint: 'https://admin.local/api/observability/errors',
        batchSize: 1,
        captureResourceErrors: false,
      },
    });

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'https://admin.local/api/observability/analytics',
        expect.objectContaining({
          method: 'POST',
          headers: { 'content-type': 'application/json' },
        })
      );
    });

    handle.captureActionError(new Error('action failed'), 'create-review');

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'https://admin.local/api/observability/errors',
        expect.objectContaining({
          method: 'POST',
          headers: { 'content-type': 'application/json' },
        })
      );
    });

    const analyticsBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(analyticsBody.events[0]).toMatchObject({
      app: 'novel-rating',
      release: '1.0.0',
      environment: 'test',
      name: 'page_view',
      properties: { path: '/' },
    });

    const errorBody = JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string);
    expect(errorBody.reports[0]).toMatchObject({
      app: 'novel-rating',
      message: 'action failed',
      source: 'server-action',
      tags: { actionId: 'create-review' },
    });
  });

  it('exposes a first-party telemetry API for business events, errors, and custom measures', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    const handle = await installBrowserObservability({
      app: 'novel-rating',
      analytics: {
        endpoint: '/analytics',
        batchSize: 1,
        webVitals: false,
        trackInitialPage: false,
      },
      errorReporting: {
        endpoint: '/errors',
        batchSize: 1,
        captureResourceErrors: false,
      },
    });

    setTelemetryUser({ id: 'u1', tenantId: 'tenant-a', segment: 'paid' });
    track('review.submit', { bookId: 'b1', score: 5 }, { tags: { feature: 'reviews' } });
    measure('search.latency', 42, {
      unit: 'ms',
      properties: { source: 'header' },
      tags: { route: '/search' },
    });
    capture(new Error('domain failed'), {
      source: 'rating-widget',
      tags: { feature: 'rating' },
      extra: { bookId: 'b1' },
    });

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    const eventBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(eventBody.events[0]).toMatchObject({
      name: 'review.submit',
      properties: { bookId: 'b1', score: 5 },
      tags: { feature: 'reviews' },
      user: { id: 'u1', tenantId: 'tenant-a', segment: 'paid' },
    });

    const metricBody = JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string);
    expect(metricBody.events[0]).toMatchObject({
      name: 'metric',
      properties: {
        metric: 'search.latency',
        value: 42,
        unit: 'ms',
        source: 'header',
      },
      tags: { route: '/search' },
    });

    const errorBody = JSON.parse(fetchMock.mock.calls[2]?.[1]?.body as string);
    expect(errorBody.reports[0]).toMatchObject({
      message: 'domain failed',
      source: 'rating-widget',
      tags: { feature: 'rating' },
      extra: { bookId: 'b1' },
      user: { id: 'u1', tenantId: 'tenant-a', segment: 'paid' },
    });

    handle.shutdown();
    expect(getTelemetry()).toBeNull();
  });

  it('buffers facade calls made before client telemetry is installed', async () => {
    installBrowserGlobals();
    const fetchMock = vi.fn(async () => new Response('{}', { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    setTelemetryUser({ id: 'early-user' });
    track('early.intent', { source: 'module-load' });

    const handle = await installBrowserObservability({
      app: 'novel-rating',
      analytics: {
        endpoint: '/analytics',
        batchSize: 1,
        webVitals: false,
        trackInitialPage: false,
      },
      errorReporting: false,
    });

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body.events[0]).toMatchObject({
      name: 'early.intent',
      properties: { source: 'module-load' },
      user: { id: 'early-user' },
    });

    handle.shutdown();
  });

  it('is a no-op when endpoints are not configured', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    const handle = await installBrowserObservability({
      app: 'novel-rating',
      analytics: {},
      errorReporting: {},
    });

    expect(() => handle.page('/books?q=secret')).not.toThrow();
    expect(() => handle.captureActionError(new Error('x'), 'a')).not.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('strips query strings by default before reporting navigation paths', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    const handle = await installBrowserObservability({
      app: 'novel-rating',
      includeQueryString: false,
      analytics: {
        endpoint: '/analytics',
        batchSize: 1,
        webVitals: false,
        trackInitialPage: false,
      },
      errorReporting: false,
    });

    handle.page(new URL('https://example.com/books?q=secret#chapter'));

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body.events[0].properties.path).toBe('/books');
  });

  it('can include query strings when explicitly enabled', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    const handle = await installBrowserObservability({
      app: 'novel-rating',
      includeQueryString: true,
      analytics: {
        endpoint: '/analytics',
        batchSize: 1,
        webVitals: false,
        trackInitialPage: false,
      },
      errorReporting: false,
    });

    handle.page(new URL('https://example.com/books?q=allowed#chapter'));

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body.events[0].properties.path).toBe('/books?q=allowed');
  });

  it('reports final Web Vitals facts including INP through the engine endpoint bridge', async () => {
    const listeners = installBrowserGlobals();
    const observers = installPerformanceObserverGlobals();
    const fetchMock = vi.fn(async () => new Response('{}', { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    const handle = await installBrowserObservability({
      app: 'novel-rating',
      analytics: {
        endpoint: '/analytics',
        batchSize: 50,
        webVitals: true,
        trackInitialPage: false,
      },
      errorReporting: false,
    });

    observers.get('largest-contentful-paint')?.([perfEntry({ startTime: 2800 })]);
    observers.get('layout-shift')?.([
      perfEntry({ value: 0.04, hadRecentInput: false }),
      perfEntry({ value: 0.08, hadRecentInput: false }),
    ]);
    observers.get('event')?.([
      perfEntry({ duration: 100, interactionId: 1 }),
      perfEntry({ duration: 260, interactionId: 2 }),
    ]);
    listeners.pagehide?.({ type: 'pagehide' } as Event);
    await handle.flush();

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'web_vital',
          properties: { name: 'TTFB', value: 123 },
        }),
        expect.objectContaining({
          name: 'web_vital',
          properties: { name: 'LCP', value: 2800 },
        }),
        expect.objectContaining({
          name: 'web_vital',
          properties: { name: 'INP', value: 260 },
        }),
        expect.objectContaining({
          name: 'web_vital',
          properties: { name: 'CLS', value: 0.12 },
        }),
      ])
    );
  });

  it('retries failed endpoint uploads with backoff without blocking the page', async () => {
    vi.useFakeTimers();
    const listeners = installBrowserGlobals();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(new Response('{}', { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    const handle = await installBrowserObservability({
      app: 'novel-rating',
      analytics: {
        endpoint: '/analytics',
        batchSize: 1,
        webVitals: false,
        trackInitialPage: false,
        retryBaseDelayMs: 100,
        retryMaxDelayMs: 100,
      },
      errorReporting: false,
    });

    handle.page('/retry');

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    await vi.advanceTimersByTimeAsync(200);

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    expect(listeners.online).toBeTypeOf('function');
    handle.shutdown();
  });
});

/**
 * inbound-filter 单测 —— 这套规则就是为了挡掉 Vite HMR 的
 * "send was called before connect" 之类的 dev-runtime 噪声，
 * 别让 admin observability 通道被刷爆。回归测试一下。
 */
describe('error inbound filters', () => {
  it('drops unhandled rejections originating from @vite/client', () => {
    const patterns = resolveIgnorePatterns(undefined);
    const viteHmrError = new Error('send was called before connect');
    viteHmrError.stack =
      'Error: send was called before connect\n' +
      '    at Object.send (http://localhost:3000/@vite/client:384:15)';
    expect(shouldIgnore(patterns, undefined, viteHmrError)).toBe(true);
  });

  it('drops error events whose filename is a dev-runtime URL', () => {
    const patterns = resolveIgnorePatterns(undefined);
    expect(shouldIgnore(patterns, 'http://localhost:3000/@vite/client', null)).toBe(true);
    expect(shouldIgnore(patterns, 'http://localhost:3000/@react-refresh', null)).toBe(true);
  });

  it('drops errors from browser extensions', () => {
    const patterns = resolveIgnorePatterns(undefined);
    expect(shouldIgnore(patterns, 'chrome-extension://abc/content.js', null)).toBe(true);
  });

  it('keeps real application errors untouched', () => {
    const patterns = resolveIgnorePatterns(undefined);
    const appError = new Error('Cannot read property foo of undefined');
    appError.stack =
      'Error: Cannot read property foo of undefined\n' +
      '    at HomePage (http://localhost:3000/src/pages/HomePage.tsx:42:7)';
    expect(shouldIgnore(patterns, 'http://localhost:3000/src/pages/HomePage.tsx', appError)).toBe(
      false
    );
  });

  it('honors ignoreSourcePatterns: false to disable filtering entirely', () => {
    const patterns = resolveIgnorePatterns(false);
    expect(patterns).toEqual([]);
    expect(shouldIgnore(patterns, 'http://localhost:3000/@vite/client', null)).toBe(false);
  });

  it('lets callers append custom patterns alongside the defaults', () => {
    const patterns = resolveIgnorePatterns([/MyVendorBundle/]);
    expect(shouldIgnore(patterns, 'http://localhost:3000/@vite/client', null)).toBe(true);
    expect(shouldIgnore(patterns, 'http://localhost:3000/MyVendorBundle.js', null)).toBe(true);
    expect(shouldIgnore(patterns, 'http://localhost:3000/src/app.ts', null)).toBe(false);
  });
});

function installBrowserGlobals(): Record<string, EventListener> {
  const listeners: Record<string, EventListener> = {};
  const storage = new Map<string, string>();

  vi.stubGlobal('window', {
    location: {
      pathname: '/',
      search: '',
      origin: 'https://example.com',
      href: 'https://example.com/',
    },
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
    addEventListener: vi.fn((type: string, listener: EventListener) => {
      listeners[type] = listener;
    }),
    removeEventListener: vi.fn(),
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  });
  vi.stubGlobal('document', {
    title: 'Novel Rating',
    referrer: '',
    visibilityState: 'visible',
    addEventListener: vi.fn((type: string, listener: EventListener) => {
      listeners[type] = listener;
    }),
    removeEventListener: vi.fn(),
  });

  return listeners;
}

function installPerformanceObserverGlobals(): Map<
  string,
  (entries: Array<PerformanceEntry & Record<string, unknown>>) => void
> {
  const observers = new Map<
    string,
    (entries: Array<PerformanceEntry & Record<string, unknown>>) => void
  >();

  class FakePerformanceObserver {
    private readonly callback: PerformanceObserverCallback;

    constructor(callback: PerformanceObserverCallback) {
      this.callback = callback;
    }

    observe(options: PerformanceObserverInit & { type?: string }): void {
      if (!options.type) return;
      observers.set(options.type, entries => {
        this.callback(
          { getEntries: () => entries } as unknown as PerformanceObserverEntryList,
          this as unknown as PerformanceObserver
        );
      });
    }

    disconnect(): void {}
  }

  vi.stubGlobal('performance', {
    getEntriesByType: (type: string) => (type === 'navigation' ? [{ responseStart: 123 }] : []),
  });
  vi.stubGlobal('PerformanceObserver', FakePerformanceObserver);

  return observers;
}

function perfEntry(values: Record<string, unknown>): PerformanceEntry & Record<string, unknown> {
  return {
    duration: 0,
    entryType: 'test',
    name: 'test',
    startTime: 0,
    toJSON: () => ({}),
    ...values,
  } as PerformanceEntry & Record<string, unknown>;
}
