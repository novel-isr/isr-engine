/**
 * Edge runtime adapter 单元测试
 *
 * 覆盖：
 *   - toCloudflareWorker：调用 ctx.passThroughOnException + 委托 fetch；err → 500 包装
 *   - toVercelEdge：透传 fetch；err → 500
 *   - toDenoHandler：透传 fetch；err → 500
 *   - toBunServer：返回 { port, fetch }
 *   - 所有 adapter 都不会让原 handler 的异常向上冒（避免平台 1101）
 */
import { describe, it, expect, vi } from 'vitest';
import { toCloudflareWorker, toVercelEdge, toDenoHandler, toBunServer } from '../index';

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

  it('handler 抛错时返回 500 而非冒泡', async () => {
    const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() };
    const w = toCloudflareWorker(errHandler);
    const res = await w.fetch(new Request('https://x.com/'), {}, ctx);
    expect(res.status).toBe(500);
    expect(await res.text()).toContain('boom');
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
  });
});

describe('toDenoHandler / toBunServer', () => {
  it('toDenoHandler 透传成功响应', async () => {
    const h = toDenoHandler(okHandler);
    const res = await h(new Request('https://x.com/'));
    expect(res.status).toBe(200);
  });

  it('toDenoHandler 错误包成 500', async () => {
    const h = toDenoHandler(errHandler);
    const res = await h(new Request('https://x.com/'));
    expect(res.status).toBe(500);
  });

  it('toBunServer 返回 { port, fetch }', () => {
    const cfg = toBunServer(okHandler, { port: 9000 });
    expect(cfg.port).toBe(9000);
    expect(typeof cfg.fetch).toBe('function');
  });
});
