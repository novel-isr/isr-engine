import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  composeAutoServerHooks,
  resolveSentryDsnFromEnv,
  type AutoServerHooks,
} from '../auto-observability';

describe('auto-observability fan-out', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('合并多个 vendor beforeRequest，并按顺序执行 onResponse/onError', async () => {
    const calls: string[] = [];
    const sentry: AutoServerHooks = {
      beforeRequest: () => ({ sentrySpan: 's1' }),
      onResponse: () => calls.push('sentry:response'),
      onError: () => calls.push('sentry:error'),
    };
    const datadog: AutoServerHooks = {
      beforeRequest: () => ({ datadogSpan: 'd1' }),
      onResponse: () => calls.push('datadog:response'),
      onError: () => calls.push('datadog:error'),
    };

    const hooks = composeAutoServerHooks([sentry, datadog]);
    const req = new Request('https://example.com/books');
    const baseline = { traceId: 'trace-1', startedAt: 1000 };

    await expect(hooks.beforeRequest?.(req, baseline)).resolves.toEqual({
      sentrySpan: 's1',
      datadogSpan: 'd1',
    });

    hooks.onResponse?.(new Response('ok'), {
      ...baseline,
      sentrySpan: 's1',
      datadogSpan: 'd1',
    });
    hooks.onError?.(new Error('boom'), req, {
      ...baseline,
      sentrySpan: 's1',
      datadogSpan: 'd1',
    });

    expect(calls).toEqual(['sentry:response', 'datadog:response', 'sentry:error', 'datadog:error']);
  });

  it('vendor hook 抛错不会阻断其它 vendor', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const goodResponse = vi.fn();
    const goodError = vi.fn();
    const hooks = composeAutoServerHooks([
      {
        beforeRequest: () => {
          throw new Error('sentry unavailable');
        },
        onResponse: () => {
          throw new Error('sentry response failed');
        },
        onError: () => {
          throw new Error('sentry error failed');
        },
      },
      {
        beforeRequest: () => ({ otelSpan: 'o1' }),
        onResponse: goodResponse,
        onError: goodError,
      },
    ]);

    const req = new Request('https://example.com/');
    const baseline = { traceId: 'trace-2', startedAt: 2000 };

    await expect(hooks.beforeRequest?.(req, baseline)).resolves.toEqual({
      otelSpan: 'o1',
    });
    hooks.onResponse?.(new Response('ok'), { ...baseline });
    hooks.onError?.(new Error('boom'), req, { ...baseline });

    expect(goodResponse).toHaveBeenCalledTimes(1);
    expect(goodError).toHaveBeenCalledTimes(1);
  });

  it('Sentry 需要显式 enabled，dsn 只是凭证来源', () => {
    expect(resolveSentryDsnFromEnv({ SENTRY_DSN: 'https://key@sentry.example/1' })).toBeUndefined();
    expect(
      resolveSentryDsnFromEnv({
        SENTRY_ENABLED: 'false',
        SENTRY_DSN: 'https://key@sentry.example/1',
      })
    ).toBeUndefined();
    expect(
      resolveSentryDsnFromEnv({
        SENTRY_ENABLED: 'true',
        SENTRY_DSN: 'https://key@sentry.example/1',
      })
    ).toBe('https://key@sentry.example/1');
  });
});
