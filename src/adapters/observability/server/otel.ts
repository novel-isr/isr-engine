/**
 * OpenTelemetry 服务端 hooks 预制 adapter
 *
 * 用户态：
 *   import { trace } from '@opentelemetry/api';
 *   import { createOtelServerHooks } from '@novel-isr/engine/adapters/observability';
 *   export default createOtelServerHooks({ tracer: trace.getTracer('my-app') });
 *
 * 自动：每请求开 SERVER kind span + 注入 traceId attribute + onError record exception
 *
 * 与 OTLP collector / Jaeger / Zipkin 全部兼容（OTel 标准协议）。
 */

interface OtelTracer {
  startSpan(
    name: string,
    options?: { kind?: number; attributes?: Record<string, unknown> }
  ): OtelSpan;
}

interface OtelSpan {
  setAttribute(key: string, value: unknown): void;
  setAttributes(attrs: Record<string, unknown>): void;
  setStatus(status: { code: number; message?: string }): void;
  recordException(err: unknown): void;
  end(): void;
}

const SPAN_KIND_SERVER = 2; // SpanKind.SERVER per OTel spec
const STATUS_OK = 1;
const STATUS_ERROR = 2;

export interface OtelServerHooksOptions {
  tracer: OtelTracer;
  /** 默认 'http.server' */
  spanName?: string | ((req: Request) => string);
}

interface ServerCtx {
  traceId: string;
  startedAt: number;
  __otelSpan?: OtelSpan;
  [k: string]: unknown;
}

export function createOtelServerHooks(opts: OtelServerHooksOptions) {
  const nameFn =
    typeof opts.spanName === 'function'
      ? opts.spanName
      : (req: Request) => opts.spanName ?? `${req.method} ${new URL(req.url).pathname}`;

  return {
    beforeRequest: (request: Request, baseline: { traceId: string; startedAt: number }) => {
      const span = opts.tracer.startSpan(nameFn(request) as string, {
        kind: SPAN_KIND_SERVER,
        attributes: {
          'http.method': request.method,
          'http.url': request.url,
          'http.target': new URL(request.url).pathname,
          'trace.id': baseline.traceId,
        },
      });
      return { __otelSpan: span };
    },
    onResponse: (response: Response, ctx: ServerCtx) => {
      const span = ctx.__otelSpan;
      if (!span) return;
      span.setAttribute('http.status_code', response.status);
      span.setStatus({ code: response.status >= 500 ? STATUS_ERROR : STATUS_OK });
      span.end();
    },
    onError: (err: unknown, _req: Request, ctx: ServerCtx) => {
      const span = ctx.__otelSpan;
      if (!span) return;
      span.recordException(err);
      span.setStatus({
        code: STATUS_ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      span.end();
    },
  };
}
