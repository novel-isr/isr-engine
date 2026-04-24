/**
 * Datadog APM 服务端 hooks 预制 adapter
 *
 * 用户态：
 *   import tracer from 'dd-trace';
 *   import { createDatadogServerHooks } from '@novel-isr/engine/adapters/observability';
 *   tracer.init({ service: 'my-app', env: 'prod' });
 *   export default createDatadogServerHooks({ tracer });
 *
 * 自动：每请求开 web.request span + 注入 traceId tag + onError 上报
 */

interface DatadogTracer {
  startSpan(operation: string, opts?: { tags?: Record<string, unknown> }): DatadogSpan;
}

interface DatadogSpan {
  setTag(k: string, v: unknown): void;
  finish(): void;
}

export interface DatadogServerHooksOptions {
  tracer: DatadogTracer;
  /** 默认 'web.request' */
  operationName?: string;
  /** 路由名提取器，默认 URL pathname */
  getRouteName?: (request: Request) => string;
}

interface ServerCtx {
  traceId: string;
  startedAt: number;
  __ddSpan?: DatadogSpan;
  [k: string]: unknown;
}

export function createDatadogServerHooks(opts: DatadogServerHooksOptions) {
  const op = opts.operationName ?? 'web.request';
  const getRouteName = opts.getRouteName ?? ((req: Request) => new URL(req.url).pathname);

  return {
    beforeRequest: (request: Request, baseline: { traceId: string; startedAt: number }) => {
      const span = opts.tracer.startSpan(op, {
        tags: {
          'resource.name': getRouteName(request),
          'http.method': request.method,
          'http.url': request.url,
          'trace.id': baseline.traceId,
        },
      });
      return { __ddSpan: span };
    },
    onResponse: (response: Response, ctx: ServerCtx) => {
      const span = ctx.__ddSpan;
      if (!span) return;
      span.setTag('http.status_code', response.status);
      if (response.status >= 500) span.setTag('error', true);
      span.finish();
    },
    onError: (err: unknown, _req: Request, ctx: ServerCtx) => {
      const span = ctx.__ddSpan;
      if (!span) return;
      span.setTag('error', true);
      span.setTag('error.message', err instanceof Error ? err.message : String(err));
      span.setTag('error.stack', err instanceof Error ? err.stack : undefined);
      span.finish();
    },
  };
}
