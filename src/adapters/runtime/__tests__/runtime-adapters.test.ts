/**
 * Edge runtime adapter 单元测试
 *
 * 覆盖：
 *   - toCloudflareWorker：按配置向平台传播未消费请求的异常，其他异常返回受控 500
 *   - toVercelEdge：透传 fetch；err → 500
 *   - Vercel 请求头覆盖遵循平台完整请求头序列化协议
 */
import { describe, it, expect, vi } from 'vitest';
import { toCloudflareWorker, toVercelEdge, toVercelMiddleware } from '../index';

const okHandler = {
  fetch: async (req: Request) => new Response('ok ' + new URL(req.url).pathname, { status: 200 }),
};
const errHandler = {
  fetch: async () => {
    throw new Error('boom');
  },
};

describe('toCloudflareWorker', () => {
  it('正常返回 + 调用 passThroughOnException', async () => {
    const ctx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
    };
    const w = toCloudflareWorker(okHandler);
    const res = await w.fetch(new Request('https://x.com/abc'), {}, ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok /abc');
    expect(ctx.passThroughOnException).toHaveBeenCalled();
  });

  it('propagates an unconsumed request failure so the configured platform fallback can run', async () => {
    const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() };
    const w = toCloudflareWorker(errHandler);
    await expect(w.fetch(new Request('https://x.com/'), {}, ctx)).rejects.toThrow('boom');
    expect(ctx.passThroughOnException).toHaveBeenCalledTimes(1);
  });

  it('returns an opaque non-cacheable error when fallback is explicitly disabled', async () => {
    const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() };
    const w = toCloudflareWorker(errHandler, { passThroughOnException: false });
    const response = await w.fetch(new Request('https://x.com/'), {}, ctx);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('boom');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(ctx.passThroughOnException).not.toHaveBeenCalled();
  });

  it('does not ask the platform to replay a consumed request body', async () => {
    const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() };
    const w = toCloudflareWorker({
      fetch: async request => {
        await request.text();
        throw new Error('private body failure');
      },
    });
    const response = await w.fetch(
      new Request('https://x.com/', { method: 'POST', body: 'payload' }),
      {},
      ctx
    );
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('private body failure');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('returns an opaque error for a locked request body that cannot be replayed', async () => {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const request = new Request('https://x.com/', { method: 'POST', body: 'payload' });
    const w = toCloudflareWorker({
      fetch: async incoming => {
        reader = incoming.body!.getReader();
        throw new Error('locked body failure');
      },
    });
    try {
      const response = await w.fetch(
        request,
        {},
        {
          waitUntil: vi.fn(),
          passThroughOnException: vi.fn(),
        }
      );
      expect(request.bodyUsed).toBe(false);
      expect(request.body?.locked).toBe(true);
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain('locked body failure');
    } finally {
      reader?.releaseLock();
      await request.body?.cancel();
    }
  });

  it('beforeFetch 钩子被调用', async () => {
    const before = vi.fn();
    const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() };
    const env = { KV_BINDING: 'x' };
    const w = toCloudflareWorker(okHandler, { beforeFetch: before });
    await w.fetch(new Request('https://x.com/'), env, ctx);
    expect(before).toHaveBeenCalledWith(expect.any(Request), env, ctx);
  });
});

describe('toVercelEdge', () => {
  it('返回纯 fetch 函数', async () => {
    const h = toVercelEdge(okHandler);
    expect(typeof h).toBe('function');
    const res = await h(new Request('https://x.com/page'));
    expect(res.status).toBe(200);
  });

  it('错误包成 500', async () => {
    const h = toVercelEdge(errHandler);
    const res = await h(new Request('https://x.com/'));
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('boom');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('toVercelMiddleware', () => {
  it('serializes the complete merged request headers into the platform override protocol', async () => {
    const middleware = toVercelMiddleware(okHandler, {
      shouldPassthrough: () => true,
      injectRequestHeaders: () => ({ 'X-User-Id': '42', 'X-Trace': 'replacement' }),
    });
    const request = new Request('https://x.com/', {
      headers: { authorization: 'Bearer original', 'x-trace': 'old', cookie: 'session=retained' },
    });
    const response = await middleware(request);
    expect(response?.headers.get('x-middleware-next')).toBe('1');
    const override = response?.headers.get('x-middleware-override-headers');
    expect(override).not.toBeNull();
    const downstream = new Headers();
    for (const name of override!.split(',')) {
      downstream.set(name, response!.headers.get(`x-middleware-request-${name}`)!);
    }
    const forwarded: Record<string, string> = {};
    downstream.forEach((value, name) => {
      forwarded[name] = value;
    });
    expect(forwarded).toEqual({
      authorization: 'Bearer original',
      cookie: 'session=retained',
      'x-trace': 'replacement',
      'x-user-id': '42',
    });
    expect(request.headers.get('x-trace')).toBe('old');
  });

  it('keeps an ordinary passthrough free of request-header overrides', async () => {
    const middleware = toVercelMiddleware(okHandler, { shouldPassthrough: () => true });
    expect(await middleware(new Request('https://x.com/'))).toBeUndefined();
  });

  it('returns an opaque error instead of exposing middleware exceptions', async () => {
    const middleware = toVercelMiddleware(errHandler);
    const response = await middleware(new Request('https://x.com/'));
    expect(response?.status).toBe(500);
    expect(await response?.text()).not.toContain('boom');
    expect(response?.headers.get('cache-control')).toBe('no-store');
  });
});
