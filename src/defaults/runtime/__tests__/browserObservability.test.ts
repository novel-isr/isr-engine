import { describe, expect, it, vi } from 'vitest';
import {
  installBrowserObservability,
  type BrowserObservabilityModuleLoader,
} from '../browserObservability';

describe('installBrowserObservability', () => {
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
});
