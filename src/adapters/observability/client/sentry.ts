/**
 * Sentry 浏览器 hooks 预制 adapter
 *
 * 用户态：
 *   import * as Sentry from '@sentry/browser';
 *   import { createSentryClientHooks } from '@novel-isr/engine/adapters/observability/client';
 *
 *   defineClientEntry(createSentryClientHooks({
 *     Sentry,
 *     init: () => Sentry.init({ dsn: 'https://...', tracesSampleRate: 0.1 }),
 *     webVitals: true,        // 默认 true：自动接 web-vitals 上报
 *   }));
 *
 * 自动：beforeHydrate init + onNavigate 面包屑 + onActionError 上报 + 可选 web-vitals
 */

interface SentryBrowserLike {
  init?(opts: Record<string, unknown>): void;
  captureException(err: unknown, hint?: { tags?: Record<string, string> }): void;
  addBreadcrumb(breadcrumb: { category: string; data?: Record<string, unknown> }): void;
  metrics?: {
    distribution(name: string, value: number, opts?: Record<string, unknown>): void;
  };
}

export interface SentryClientHooksOptions {
  Sentry: SentryBrowserLike;
  /** 自定义 init 回调；不传则不自动 init（由用户控制） */
  init?: () => void;
  /** 是否自动接 web-vitals（CLS / LCP / INP / FID / TTFB），默认 false（避免增大 bundle） */
  webVitals?: boolean;
}

export function createSentryClientHooks(opts: SentryClientHooksOptions) {
  const { Sentry } = opts;
  return {
    beforeHydrate: async () => {
      try {
        opts.init?.();
      } catch (err) {
        console.warn('[sentry-adapter] init failed', err);
      }
      if (opts.webVitals) {
        try {
          // 动态 import：用户没装 web-vitals 也不会导致页面崩；
          // engine 不强依赖该包（仅 client adapter 可选用）
          type WvCb = (m: { value: number; rating?: string }) => void;
          const wv = (await import(/* @vite-ignore */ 'web-vitals' as string)) as {
            onCLS: (cb: WvCb) => void;
            onLCP: (cb: WvCb) => void;
            onINP: (cb: WvCb) => void;
            onFCP: (cb: WvCb) => void;
            onTTFB: (cb: WvCb) => void;
          };
          const report =
            (name: string) =>
            (metric: { value: number; rating?: string }): void => {
              Sentry.metrics?.distribution?.(`web_vitals.${name}`, metric.value, {
                tags: { rating: metric.rating ?? 'unknown' },
              });
            };
          wv.onCLS(report('cls'));
          wv.onLCP(report('lcp'));
          wv.onINP(report('inp'));
          wv.onFCP(report('fcp'));
          wv.onTTFB(report('ttfb'));
        } catch {
          /* web-vitals 未安装时静默 */
        }
      }
    },
    onNavigate: (url: URL) => {
      Sentry.addBreadcrumb({
        category: 'navigation',
        data: { from: location.pathname, to: url.pathname },
      });
    },
    onActionError: (err: unknown, actionId: string) => {
      Sentry.captureException(err, { tags: { actionId } });
    },
  };
}
