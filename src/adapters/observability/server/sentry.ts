/**
 * Sentry 服务端 hooks 预制 adapter
 *
 * 用户态最简写法：
 *   // src/entry.server.tsx
 *   import * as Sentry from '@sentry/node';
 *   import { createSentryServerHooks } from '@novel-isr/engine/adapters/observability';
 *
 *   Sentry.init({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 0.1 });
 *   export default createSentryServerHooks({ Sentry });
 *
 * 等价于：自动开/关 span（http.server）+ 注入 traceId tag + onError 上报
 *
 * 注意：本 adapter **不强依赖** @sentry/node —— 用户在自家项目里 npm install 后
 * 把 init 好的实例传进来即可。这样 engine 不锁版本，也不污染 bundle。
 */

interface SentryLike {
  startSpan<T>(
    opts: { op: string; name: string; tags?: Record<string, string> },
    cb: (span: SentrySpan) => T
  ): T;
  startInactiveSpan(opts: { op: string; name: string; tags?: Record<string, string> }): SentrySpan;
  captureException(
    err: unknown,
    hint?: { tags?: Record<string, string>; extra?: Record<string, unknown> }
  ): void;
}

interface SentrySpan {
  setStatus?(status: { code: number } | string): void;
  setHttpStatus?(code: number): void;
  setTag?(k: string, v: string): void;
  end?(): void;
  finish?(): void; // 老版兼容
}

export interface SentryServerHooksOptions {
  /** 用户在自家项目里已 init 好的 Sentry 命名空间（@sentry/node 默认 export） */
  Sentry: SentryLike;
  /** 自定义 op 名，默认 'http.server' */
  op?: string;
  /** 路由名提取器，默认从 URL pathname 提取 */
  getRouteName?: (request: Request) => string;
}

interface ServerCtx {
  traceId: string;
  startedAt: number;
  __sentrySpan?: SentrySpan;
  [k: string]: unknown;
}

export function createSentryServerHooks(opts: SentryServerHooksOptions) {
  const { Sentry } = opts;
  const op = opts.op ?? 'http.server';
  const getRouteName = opts.getRouteName ?? ((req: Request) => new URL(req.url).pathname);

  return {
    beforeRequest: (request: Request, baseline: { traceId: string; startedAt: number }) => {
      const span = Sentry.startInactiveSpan({
        op,
        name: getRouteName(request),
        tags: { traceId: baseline.traceId },
      });
      return { __sentrySpan: span };
    },
    onResponse: (response: Response, ctx: ServerCtx) => {
      const span = ctx.__sentrySpan;
      if (!span) return;
      // Sentry v8 用 setStatus({code})；v7 用 setHttpStatus；都试一下
      try {
        span.setHttpStatus?.(response.status);
        span.setStatus?.({ code: response.status });
      } catch {
        /* ignore */
      }
      try {
        span.end?.();
        span.finish?.();
      } catch {
        /* ignore */
      }
    },
    onError: (err: unknown, request: Request, ctx: ServerCtx) => {
      Sentry.captureException(err, {
        tags: { traceId: ctx.traceId },
        extra: { url: request.url },
      });
      try {
        ctx.__sentrySpan?.setStatus?.({ code: 500 });
        ctx.__sentrySpan?.end?.();
        ctx.__sentrySpan?.finish?.();
      } catch {
        /* ignore */
      }
    },
  };
}
