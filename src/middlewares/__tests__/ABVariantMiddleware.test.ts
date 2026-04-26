import { describe, it, expect } from 'vitest';
import { createABVariantMiddleware, getVariant } from '../ABVariantMiddleware';
import { requestContext } from '@/context/RequestContext';
import type { Request, Response } from 'express';

function mockReq(cookie?: string): Request {
  return { headers: { cookie } } as Request;
}

function mockRes() {
  const headers: Record<string, string[]> = {};
  return {
    appendHeader(name: string, value: string) {
      (headers[name] ??= []).push(value);
    },
    get headers() {
      return headers;
    },
  } as unknown as Response & { headers: Record<string, string[]> };
}

describe('ABVariantMiddleware', () => {
  it('首访分配 + 写 cookie + getVariant 返回值', async () => {
    const mw = createABVariantMiddleware({
      experiments: {
        hero: { variants: ['classic', 'v2'], weights: [50, 50] },
      },
    });

    let assigned: string | undefined;
    await new Promise<void>(resolve => {
      requestContext.run({ traceId: 't', requestId: 'r' }, () => {
        const req = mockReq();
        const res = mockRes();
        mw(req, res, () => {
          assigned = getVariant('hero');
          // cookie 写出去
          expect(res.headers['Set-Cookie']?.[0]).toMatch(/^ab=/);
          resolve();
        });
      });
    });

    expect(assigned).toMatch(/^(classic|v2)$/);
  });

  it('已有 cookie → sticky 不重新分配', async () => {
    const mw = createABVariantMiddleware({
      experiments: { hero: { variants: ['classic', 'v2'] } },
    });

    let v: string | undefined;
    await new Promise<void>(resolve => {
      requestContext.run({ traceId: 't', requestId: 'r' }, () => {
        const req = mockReq('ab=hero%3Dv2');
        const res = mockRes();
        mw(req, res, () => {
          v = getVariant('hero');
          // cookie 没变 → 不应再 Set-Cookie
          expect(res.headers['Set-Cookie']).toBeUndefined();
          resolve();
        });
      });
    });

    expect(v).toBe('v2');
  });

  it('cookie 里的 variant 已不在 variants 列表 → 重新分配', async () => {
    const mw = createABVariantMiddleware({
      experiments: { hero: { variants: ['v3', 'v4'] } },
    });
    let v: string | undefined;
    await new Promise<void>(resolve => {
      requestContext.run({ traceId: 't', requestId: 'r' }, () => {
        const req = mockReq('ab=hero%3Dvold'); // vold 已下线
        const res = mockRes();
        mw(req, res, () => {
          v = getVariant('hero');
          // 重新 Set-Cookie
          expect(res.headers['Set-Cookie']).toBeDefined();
          resolve();
        });
      });
    });
    expect(['v3', 'v4']).toContain(v);
  });

  it('weights 100/0 → 永远命中 v2', async () => {
    const mw = createABVariantMiddleware({
      experiments: { hero: { variants: ['v1', 'v2'], weights: [0, 100] } },
    });

    for (let i = 0; i < 20; i++) {
      let v: string | undefined;
      await new Promise<void>(resolve => {
        requestContext.run({ traceId: 't', requestId: String(i) }, () => {
          mw(mockReq(), mockRes(), () => {
            v = getVariant('hero');
            resolve();
          });
        });
      });
      expect(v).toBe('v2');
    }
  });

  it('getVariant 在中间件外 → undefined', () => {
    expect(getVariant('hero')).toBeUndefined();
  });
});
