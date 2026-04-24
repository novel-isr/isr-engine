/**
 * 服务端可观测性 adapter 单元测试
 *
 * 覆盖：
 *   - Sentry：beforeRequest 开 span / onResponse 关 span / onError 上报
 *   - Datadog：tracer.startSpan 调用 / setTag http.status_code / error 标志
 *   - OTel：SERVER kind / 状态码 attribute / recordException
 */
import { describe, it, expect, vi } from 'vitest';
import { createSentryServerHooks } from '../server/sentry';
import { createDatadogServerHooks } from '../server/datadog';
import { createOtelServerHooks } from '../server/otel';

const baseline = { traceId: 't-abc', startedAt: Date.now() };

describe('createSentryServerHooks', () => {
  it('beforeRequest 开 span 并写入 ctx', () => {
    const span = { setHttpStatus: vi.fn(), setStatus: vi.fn(), end: vi.fn() };
    const Sentry = {
      startSpan: vi.fn(),
      startInactiveSpan: vi.fn(() => span),
      captureException: vi.fn(),
    };
    const hooks = createSentryServerHooks({ Sentry });
    const req = new Request('http://x.com/books/1');
    const ext = hooks.beforeRequest(req, baseline);
    expect(Sentry.startInactiveSpan).toHaveBeenCalledWith({
      op: 'http.server',
      name: '/books/1',
      tags: { traceId: 't-abc' },
    });
    expect(ext).toEqual({ __sentrySpan: span });
  });

  it('onResponse 关 span + setHttpStatus', () => {
    const span = { setHttpStatus: vi.fn(), setStatus: vi.fn(), end: vi.fn() };
    const Sentry = {
      startSpan: vi.fn(),
      startInactiveSpan: vi.fn(() => span),
      captureException: vi.fn(),
    };
    const hooks = createSentryServerHooks({ Sentry });
    const ctx = { ...baseline, __sentrySpan: span };
    hooks.onResponse(new Response('ok', { status: 200 }), ctx);
    expect(span.setHttpStatus).toHaveBeenCalledWith(200);
    expect(span.end).toHaveBeenCalled();
  });

  it('onError 上报异常 + 关 span', () => {
    const span = { setHttpStatus: vi.fn(), setStatus: vi.fn(), end: vi.fn() };
    const Sentry = {
      startSpan: vi.fn(),
      startInactiveSpan: vi.fn(() => span),
      captureException: vi.fn(),
    };
    const hooks = createSentryServerHooks({ Sentry });
    const ctx = { ...baseline, __sentrySpan: span };
    hooks.onError(new Error('boom'), new Request('http://x.com/'), ctx);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { traceId: 't-abc' } })
    );
    expect(span.end).toHaveBeenCalled();
  });
});

describe('createDatadogServerHooks', () => {
  it('startSpan 命名 + tag 注入', () => {
    const span = { setTag: vi.fn(), finish: vi.fn() };
    const tracer = { startSpan: vi.fn(() => span) };
    const hooks = createDatadogServerHooks({ tracer });
    const req = new Request('http://x.com/books/42', { method: 'POST' });
    const ext = hooks.beforeRequest(req, baseline);
    expect(tracer.startSpan).toHaveBeenCalledWith(
      'web.request',
      expect.objectContaining({
        tags: expect.objectContaining({
          'resource.name': '/books/42',
          'http.method': 'POST',
          'trace.id': 't-abc',
        }),
      })
    );
    expect(ext).toEqual({ __ddSpan: span });
  });

  it('500 状态打 error tag', () => {
    const span = { setTag: vi.fn(), finish: vi.fn() };
    const tracer = { startSpan: vi.fn(() => span) };
    const hooks = createDatadogServerHooks({ tracer });
    hooks.onResponse(new Response('', { status: 500 }), { ...baseline, __ddSpan: span });
    expect(span.setTag).toHaveBeenCalledWith('http.status_code', 500);
    expect(span.setTag).toHaveBeenCalledWith('error', true);
    expect(span.finish).toHaveBeenCalled();
  });

  it('onError 写 error.message + finish', () => {
    const span = { setTag: vi.fn(), finish: vi.fn() };
    const tracer = { startSpan: vi.fn(() => span) };
    const hooks = createDatadogServerHooks({ tracer });
    hooks.onError(new Error('explode'), new Request('http://x.com/'), {
      ...baseline,
      __ddSpan: span,
    });
    expect(span.setTag).toHaveBeenCalledWith('error', true);
    expect(span.setTag).toHaveBeenCalledWith('error.message', 'explode');
    expect(span.finish).toHaveBeenCalled();
  });
});

describe('createOtelServerHooks', () => {
  it('SERVER kind + http attributes', () => {
    const span = {
      setAttribute: vi.fn(),
      setAttributes: vi.fn(),
      setStatus: vi.fn(),
      recordException: vi.fn(),
      end: vi.fn(),
    };
    const tracer = { startSpan: vi.fn(() => span) };
    const hooks = createOtelServerHooks({ tracer });
    const req = new Request('http://x.com/api/v1', { method: 'GET' });
    hooks.beforeRequest(req, baseline);
    expect(tracer.startSpan).toHaveBeenCalledWith(
      'GET /api/v1',
      expect.objectContaining({
        kind: 2, // SERVER
        attributes: expect.objectContaining({
          'http.method': 'GET',
          'http.target': '/api/v1',
          'trace.id': 't-abc',
        }),
      })
    );
  });

  it('500 → status code ERROR=2', () => {
    const span = {
      setAttribute: vi.fn(),
      setAttributes: vi.fn(),
      setStatus: vi.fn(),
      recordException: vi.fn(),
      end: vi.fn(),
    };
    const tracer = { startSpan: vi.fn(() => span) };
    const hooks = createOtelServerHooks({ tracer });
    hooks.onResponse(new Response('', { status: 500 }), { ...baseline, __otelSpan: span });
    expect(span.setStatus).toHaveBeenCalledWith({ code: 2 });
    expect(span.end).toHaveBeenCalled();
  });

  it('onError → recordException + ERROR status', () => {
    const span = {
      setAttribute: vi.fn(),
      setAttributes: vi.fn(),
      setStatus: vi.fn(),
      recordException: vi.fn(),
      end: vi.fn(),
    };
    const tracer = { startSpan: vi.fn(() => span) };
    const hooks = createOtelServerHooks({ tracer });
    const err = new Error('kaboom');
    hooks.onError(err, new Request('http://x.com/'), { ...baseline, __otelSpan: span });
    expect(span.recordException).toHaveBeenCalledWith(err);
    expect(span.setStatus).toHaveBeenCalledWith({ code: 2, message: 'kaboom' });
    expect(span.end).toHaveBeenCalled();
  });
});
