import { afterEach, describe, expect, it, vi } from 'vitest';
import { installBrowserObservability } from '../browserObservability';

describe('installBrowserObservability', () => {
  afterEach(() => {
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
});
