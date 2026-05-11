import { describe, it, expect } from 'vitest';
import { createABVariantMiddleware, getVariant } from '../ABVariantMiddleware';
import { requestContext } from '@/context/RequestContext';
import type { Request, Response } from 'express';

function mockReq(): Request {
  return { headers: {} } as Request;
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

/**
 * 在 RequestContext 里运行一次 middleware，返回 getVariant 结果 + 收集到的 Set-Cookie。
 * 新版 ABVariantMiddleware 完全不写 cookie —— Set-Cookie 数组应该永远为空。
 */
function runWithCtx(
  anonId: string,
  mw: ReturnType<typeof createABVariantMiddleware>,
  expKey: string
) {
  return new Promise<{ variant: string | undefined; setCookies: string[] }>(resolve => {
    requestContext.run({ traceId: 't', requestId: 'r', anonId }, () => {
      const res = mockRes();
      mw(mockReq(), res, () => {
        resolve({
          variant: getVariant(expKey),
          setCookies: res.headers['Set-Cookie'] ?? [],
        });
      });
    });
  });
}

describe('ABVariantMiddleware (anonId-hash)', () => {
  it('同一 anonId 同一实验 → 永远同一 variant（确定性）', async () => {
    const mw = createABVariantMiddleware({
      experiments: { hero: { variants: ['classic', 'v2'], weights: [50, 50] } },
    });
    const anonId = 'fixed-anon-id-12345';

    const runs = await Promise.all([
      runWithCtx(anonId, mw, 'hero'),
      runWithCtx(anonId, mw, 'hero'),
      runWithCtx(anonId, mw, 'hero'),
    ]);
    expect(new Set(runs.map(r => r.variant)).size).toBe(1);
    expect(['classic', 'v2']).toContain(runs[0].variant);
  });

  it('不同 anonId 在 50/50 实验上能分散到两个 variant', async () => {
    const mw = createABVariantMiddleware({
      experiments: { hero: { variants: ['classic', 'v2'], weights: [50, 50] } },
    });
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const r = await runWithCtx(`anon-${i}`, mw, 'hero');
      if (r.variant) seen.add(r.variant);
    }
    expect(seen.has('classic')).toBe(true);
    expect(seen.has('v2')).toBe(true);
  });

  it('weights 0/100 → 永远 v2，跟 anonId 无关', async () => {
    const mw = createABVariantMiddleware({
      experiments: { hero: { variants: ['v1', 'v2'], weights: [0, 100] } },
    });
    for (let i = 0; i < 20; i++) {
      const r = await runWithCtx(`a-${i}`, mw, 'hero');
      expect(r.variant).toBe('v2');
    }
  });

  it('完全不写 cookie —— ISR cache 友好的核心不变量', async () => {
    const mw = createABVariantMiddleware({
      experiments: { hero: { variants: ['a', 'b'] }, pricing: { variants: ['x', 'y'] } },
    });
    for (let i = 0; i < 10; i++) {
      const r = await runWithCtx(`anon-${i}`, mw, 'hero');
      expect(r.setCookies).toEqual([]);
    }
  });

  it('多个实验在同一 anonId 上独立分配 + 写到 ctx.experiments', async () => {
    const mw = createABVariantMiddleware({
      experiments: {
        hero: { variants: ['a', 'b'] },
        pricing: { variants: ['x', 'y'] },
      },
    });
    await new Promise<void>(resolve => {
      requestContext.run({ traceId: 't', requestId: 'r', anonId: 'anon-7' }, () => {
        mw(mockReq(), mockRes(), () => {
          const ctx = requestContext.getStore();
          expect(ctx?.experiments).toBeDefined();
          expect(['a', 'b']).toContain(ctx?.experiments?.hero);
          expect(['x', 'y']).toContain(ctx?.experiments?.pricing);
          // flags 也同步写入，向后兼容旧 getVariant 路径
          expect(ctx?.flags?.hero).toBe(ctx?.experiments?.hero);
          resolve();
        });
      });
    });
  });

  it('自定义 assigner 覆盖默认 hash', async () => {
    const mw = createABVariantMiddleware({
      experiments: { hero: { variants: ['a', 'b'] } },
      assigner: () => 'a',
    });
    for (let i = 0; i < 5; i++) {
      const r = await runWithCtx(`anon-${i}`, mw, 'hero');
      expect(r.variant).toBe('a');
    }
  });

  it('getVariant 在 RequestContext 外 → undefined', () => {
    expect(getVariant('hero')).toBeUndefined();
  });
});
