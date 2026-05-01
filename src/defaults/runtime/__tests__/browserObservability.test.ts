import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  installBrowserObservability,
  type BrowserObservabilityModuleLoader,
} from '../browserObservability';

describe('installBrowserObservability', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('wires analytics page tracking, Web Vitals and action errors through optional SDKs', async () => {
    const page = vi.fn();
    const installWebVitals = vi.fn(() => vi.fn());
    const captureException = vi.fn();
    const installGlobalErrorHandlers = vi.fn(() => vi.fn());

    const loader: BrowserObservabilityModuleLoader = async moduleName => {
      if (moduleName === '@novel-isr/analytics') {
        return {
          initAnalytics: vi.fn(() => ({
            page,
            installWebVitals,
            shutdown: vi.fn(),
          })),
        };
      }
      return {
        initErrorReporter: vi.fn(() => ({
          captureException,
          shutdown: vi.fn(),
        })),
        installGlobalErrorHandlers,
      };
    };

    const handle = await installBrowserObservability({
      app: 'novel-rating',
      release: '1.0.0',
      environment: 'test',
      analytics: { endpoint: '/analytics', webVitals: true },
      errorReporting: { endpoint: '/errors', captureResourceErrors: false },
      moduleLoader: loader,
    });

    expect(page).toHaveBeenCalledTimes(1);
    expect(installWebVitals).toHaveBeenCalledTimes(1);
    expect(installGlobalErrorHandlers).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ captureResourceErrors: false })
    );

    handle.page(new URL('https://example.com/books?q=secret'));
    expect(page).toHaveBeenLastCalledWith('/books?q=secret');

    const err = new Error('action failed');
    handle.captureActionError(err, 'create-review');
    expect(captureException).toHaveBeenCalledWith(
      err,
      expect.objectContaining({
        source: 'server-action',
        tags: { actionId: 'create-review' },
      })
    );
  });

  it('degrades to no-op when optional SDKs are not installed', async () => {
    const onSetupError = vi.fn();
    const handle = await installBrowserObservability({
      app: 'novel-rating',
      moduleLoader: async () => {
        throw new Error('missing module');
      },
      onSetupError,
    });

    expect(onSetupError).toHaveBeenCalledTimes(2);
    expect(() => handle.page('/')).not.toThrow();
    expect(() => handle.captureActionError(new Error('x'), 'a')).not.toThrow();
  });

  it('uses built-in HTTP fallback when optional SDKs are missing but endpoints are configured', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    const handle = await installBrowserObservability({
      app: 'novel-rating',
      analytics: { endpoint: 'https://admin.local/api/observability/analytics', batchSize: 1 },
      errorReporting: { endpoint: 'https://admin.local/api/observability/errors', batchSize: 1 },
      moduleLoader: async () => {
        throw new Error('missing module');
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
});
