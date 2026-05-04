import { afterEach, describe, expect, it, vi } from 'vitest';
import { installBrowserObservability } from '../browserObservability';

describe('installBrowserObservability', () => {
  afterEach(() => {
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
