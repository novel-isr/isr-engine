import { describe, it, expect, beforeEach } from 'vitest';
import { createRateLimiter, createMemoryRateLimitStore } from '../RateLimiter';
import type { Request, Response } from 'express';

function mockRes() {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let body: unknown = null;
  let ended = false;
  const res = {
    setHeader: (k: string, v: string) => (headers[k] = v),
    status: (s: number) => {
      statusCode = s;
      return res;
    },
    type: () => res,
    json: (b: unknown) => {
      body = b;
      ended = true;
      return res;
    },
    send: (b: unknown) => {
      body = b;
      ended = true;
      return res;
    },
  } as unknown as Response & {
    headers: Record<string, string>;
    statusCode: number;
    body: unknown;
    ended: boolean;
  };
  Object.defineProperty(res, 'headers', { get: () => headers });
  Object.defineProperty(res, 'statusCode', { get: () => statusCode });
  Object.defineProperty(res, 'body', { get: () => body });
  Object.defineProperty(res, 'ended', { get: () => ended });
  return res;
}

function mockReq(ip = '127.0.0.1', path = '/'): Request {
  return { ip, path } as Request;
}

describe('RateLimiter', () => {
  it('放行窗口内请求 + 限流超量', async () => {
    const mw = createRateLimiter({ windowMs: 10_000, max: 3 });
    const req = mockReq();
    let nextCalled = 0;
    const next = () => void nextCalled++;

    for (let i = 0; i < 3; i++) {
      const res = mockRes();
      await mw(req, res, next);
      expect(res.headers['RateLimit-Limit']).toBe('3');
    }
    expect(nextCalled).toBe(3);

    // 第 4 次应被拒
    const res4 = mockRes();
    await mw(req, res4, next);
    expect(res4.statusCode).toBe(429);
    expect(res4.body).toEqual({ error: 'Too Many Requests' });
    expect(res4.headers['Retry-After']).toBeDefined();
    expect(nextCalled).toBe(3);
  });

  it('skip 函数命中 → 直接放行不计数', async () => {
    const mw = createRateLimiter({
      windowMs: 10_000,
      max: 1,
      skip: req => req.path === '/health',
    });
    let nextCalled = 0;
    const next = () => void nextCalled++;

    for (let i = 0; i < 5; i++) {
      await mw(mockReq('1.1.1.1', '/health'), mockRes(), next);
    }
    expect(nextCalled).toBe(5);
  });

  it('keyGenerator 区分 key', async () => {
    const mw = createRateLimiter({ windowMs: 10_000, max: 1 });
    const next = () => {};

    const r1a = mockRes();
    await mw(mockReq('1.1.1.1'), r1a, next);
    expect(r1a.statusCode).toBe(200);

    const r1b = mockRes();
    await mw(mockReq('1.1.1.1'), r1b, next);
    expect(r1b.statusCode).toBe(429);

    // 不同 IP 不互相影响
    const r2a = mockRes();
    await mw(mockReq('2.2.2.2'), r2a, next);
    expect(r2a.statusCode).toBe(200);
  });

  it('memory store 自然 reset', async () => {
    const store = createMemoryRateLimitStore();
    const k = 'k';
    const a = await store.incr(k, 50);
    expect(a.count).toBe(1);
    const b = await store.incr(k, 50);
    expect(b.count).toBe(2);
    await new Promise(r => setTimeout(r, 60));
    const c = await store.incr(k, 50);
    expect(c.count).toBe(1);
  });
});
