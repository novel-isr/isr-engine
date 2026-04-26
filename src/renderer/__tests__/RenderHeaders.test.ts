/**
 * RenderHeaders —— HTTP 响应头计算 + ETag / 304 逻辑
 *
 * 零测试模块（~120 行），但涉及多处有风险的逻辑：
 *   1) Cache-Control 按 mode × cacheHit 八象限
 *   2) ETag 弱匹配与 If-None-Match 协商
 *   3) `*` 通配 ETag → 304
 *   4) 304 时 statusCode 覆写（函数形态 vs 属性形态 两种 res）
 *
 * 本 suite 把这 4 条路径全部锁进回归网。
 */
import { describe, it, expect } from 'vitest';
import {
  computeRenderCacheControl,
  setRenderResponseHeaders,
  type RenderHeadersInput,
} from '../RenderHeaders';

/** 极简 HeaderCarrier mock —— 支持函数态 + 属性态 statusCode */
function mockRes(opts?: { useStatusFn?: boolean }): {
  headers: Record<string, string>;
  statusCode: number;
  statusFnCalls: number[];
  setHeader(k: string, v: string): void;
  status?: (code: number) => void;
} {
  const headers: Record<string, string> = {};
  const statusFnCalls: number[] = [];
  const r: ReturnType<typeof mockRes> = {
    headers,
    statusCode: 200,
    statusFnCalls,
    setHeader(k: string, v: string): void {
      headers[k] = v;
    },
  };
  if (opts?.useStatusFn) {
    r.status = (code: number): void => {
      statusFnCalls.push(code);
    };
  }
  return r;
}

const baseInput: RenderHeadersInput = {
  mode: 'isr',
  strategy: 'plugin-rsc',
  renderTime: 42,
  html: '<html>ok</html>',
};

describe('computeRenderCacheControl —— 四种 mode × hit/miss 八象限', () => {
  it('ssr: 永不缓存', () => {
    expect(computeRenderCacheControl('ssr', false)).toBe('no-store, max-age=0, must-revalidate');
    expect(computeRenderCacheControl('ssr', true)).toBe('no-store, max-age=0, must-revalidate');
  });

  it('ssg: public + immutable + TTL', () => {
    expect(computeRenderCacheControl('ssg', false, { cacheTTL: 3600 })).toBe(
      'public, max-age=3600, immutable'
    );
    expect(computeRenderCacheControl('ssg', true, { cacheTTL: 86400 })).toBe(
      'public, max-age=86400, immutable'
    );
  });

  it('isr HIT: stale-while-revalidate', () => {
    expect(computeRenderCacheControl('isr', true, { cacheTTL: 600 })).toBe(
      'public, max-age=0, must-revalidate, stale-while-revalidate=600'
    );
  });

  it('isr MISS: must-revalidate 但无 SWR', () => {
    expect(computeRenderCacheControl('isr', false)).toBe('public, max-age=0, must-revalidate');
  });

  it('未知 mode: no-cache 兜底', () => {
    expect(computeRenderCacheControl('xxxx', false)).toBe('no-cache, max-age=0, must-revalidate');
    expect(computeRenderCacheControl('', true)).toBe('no-cache, max-age=0, must-revalidate');
  });

  it('cacheTTL < 1 → 被钳到 1（避免生成 max-age=0 冲突语义）', () => {
    expect(computeRenderCacheControl('ssg', false, { cacheTTL: 0 })).toBe(
      'public, max-age=1, immutable'
    );
    expect(computeRenderCacheControl('ssg', false, { cacheTTL: -10 })).toBe(
      'public, max-age=1, immutable'
    );
  });

  it('未传 cacheTTL → 默认 3600', () => {
    expect(computeRenderCacheControl('ssg', false)).toBe('public, max-age=3600, immutable');
  });
});

describe('setRenderResponseHeaders —— 全量响应头注入', () => {
  it('写入所有基础头（Mode/Strategy/Time/Cache/Fallback/Route/ETag/Vary/Last-Modified）', () => {
    const res = mockRes();
    const result = setRenderResponseHeaders(res, undefined, baseInput);

    expect(res.headers['X-Render-Mode']).toBe('isr');
    expect(res.headers['X-ISR-Mode']).toBe('isr');
    expect(res.headers['X-Render-Strategy']).toBe('plugin-rsc');
    expect(res.headers['X-Render-Time']).toBe('42ms');
    expect(res.headers['X-Cache-Status']).toBe('MISS');
    expect(res.headers['X-Fallback-Used']).toBe('false');
    expect(res.headers['X-Render-Route']).toBe('*'); // 未传 route 时为 '*'
    expect(res.headers['Cache-Control']).toBe('public, max-age=0, must-revalidate');
    expect(res.headers['Vary']).toBe('Accept-Encoding, Accept, User-Agent');
    // ETag 是 W/"<40 位 sha1 hex>"
    expect(res.headers['ETag']).toMatch(/^W\/"[0-9a-f]{40}"$/);
    expect(res.headers['Last-Modified']).toBeDefined();

    expect(result.etag).toBe(res.headers['ETag']);
    expect(result.cacheControl).toBe(res.headers['Cache-Control']);
    expect(result.isNotModified).toBe(false);
  });

  it('cacheHit=true → X-Cache-Status=HIT + SWR Cache-Control', () => {
    const res = mockRes();
    setRenderResponseHeaders(res, undefined, {
      ...baseInput,
      cacheHit: true,
      cacheTTL: 120,
    });
    expect(res.headers['X-Cache-Status']).toBe('HIT');
    expect(res.headers['Cache-Control']).toBe(
      'public, max-age=0, must-revalidate, stale-while-revalidate=120'
    );
  });

  it('fallbackUsed=true → X-Fallback-Used=true', () => {
    const res = mockRes();
    setRenderResponseHeaders(res, undefined, { ...baseInput, fallbackUsed: true });
    expect(res.headers['X-Fallback-Used']).toBe('true');
  });

  it('route 传值 → X-Render-Route 用该值', () => {
    const res = mockRes();
    setRenderResponseHeaders(res, undefined, { ...baseInput, route: '/books/:id' });
    expect(res.headers['X-Render-Route']).toBe('/books/:id');
  });

  it('mode=isr + revalidateAt 传值 → 写 X-Revalidate-After', () => {
    const res = mockRes();
    setRenderResponseHeaders(res, undefined, { ...baseInput, revalidateAt: 1_700_000_000 });
    expect(res.headers['X-Revalidate-After']).toBe('1700000000');
  });

  it('mode≠isr 时 revalidateAt 不写（避免误导）', () => {
    const res = mockRes();
    setRenderResponseHeaders(res, undefined, {
      ...baseInput,
      mode: 'ssr',
      revalidateAt: 1_700_000_000,
    });
    expect(res.headers['X-Revalidate-After']).toBeUndefined();
  });

  it('ETag 种子：mode + strategy + cacheHit + length + route 组合 —— 任一变化都换 etag', () => {
    const e1 = setRenderResponseHeaders(mockRes(), undefined, baseInput).etag;
    const e2 = setRenderResponseHeaders(mockRes(), undefined, {
      ...baseInput,
      mode: 'ssg',
    }).etag;
    const e3 = setRenderResponseHeaders(mockRes(), undefined, {
      ...baseInput,
      html: '<html>different-content</html>',
    }).etag;
    const e4 = setRenderResponseHeaders(mockRes(), undefined, {
      ...baseInput,
      cacheHit: true,
    }).etag;
    const e5 = setRenderResponseHeaders(mockRes(), undefined, {
      ...baseInput,
      route: '/other',
    }).etag;

    // 5 个 etag 两两不同
    const all = new Set([e1, e2, e3, e4, e5]);
    expect(all.size).toBe(5);
  });

  it('相同输入 → 稳定 ETag（确定性）', () => {
    const e1 = setRenderResponseHeaders(mockRes(), undefined, baseInput).etag;
    const e2 = setRenderResponseHeaders(mockRes(), undefined, baseInput).etag;
    expect(e1).toBe(e2);
  });
});

describe('setRenderResponseHeaders —— 304 Not Modified 协商', () => {
  it('If-None-Match 匹配 ETag → 304 + isNotModified=true（属性态 res）', () => {
    // 先拿到 etag
    const firstRes = mockRes();
    const { etag } = setRenderResponseHeaders(firstRes, undefined, baseInput);

    const res = mockRes();
    const result = setRenderResponseHeaders(res, { 'if-none-match': etag }, baseInput);
    expect(result.isNotModified).toBe(true);
    expect(res.statusCode).toBe(304);
  });

  it('If-None-Match 匹配 → 函数态 res.status(304) 被调用', () => {
    const firstRes = mockRes();
    const { etag } = setRenderResponseHeaders(firstRes, undefined, baseInput);

    const res = mockRes({ useStatusFn: true });
    setRenderResponseHeaders(res, { 'if-none-match': etag }, baseInput);
    expect(res.statusFnCalls).toEqual([304]);
  });

  it('If-None-Match=* 通配 → 304', () => {
    const res = mockRes();
    const result = setRenderResponseHeaders(res, { 'if-none-match': '*' }, baseInput);
    expect(result.isNotModified).toBe(true);
    expect(res.statusCode).toBe(304);
  });

  it('If-None-Match 多值逗号分隔 → 匹配任一即 304', () => {
    const firstRes = mockRes();
    const { etag } = setRenderResponseHeaders(firstRes, undefined, baseInput);

    const res = mockRes();
    const result = setRenderResponseHeaders(
      res,
      { 'if-none-match': `W/"some-other-tag",  ${etag}, W/"yet-another"` },
      baseInput
    );
    expect(result.isNotModified).toBe(true);
    expect(res.statusCode).toBe(304);
  });

  it('If-None-Match 不匹配 → 不变 200', () => {
    const res = mockRes();
    const result = setRenderResponseHeaders(
      res,
      { 'if-none-match': 'W/"totally-different"' },
      baseInput
    );
    expect(result.isNotModified).toBe(false);
    expect(res.statusCode).toBe(200);
  });

  it('If-None-Match 大小写（IF-NONE-MATCH / If-None-Match）都识别', () => {
    const firstRes = mockRes();
    const { etag } = setRenderResponseHeaders(firstRes, undefined, baseInput);

    // 三种大小写逐一验证
    for (const hdrKey of ['if-none-match', 'If-None-Match', 'IF-NONE-MATCH']) {
      const res = mockRes();
      const result = setRenderResponseHeaders(res, { [hdrKey]: etag }, baseInput);
      expect(result.isNotModified).toBe(true);
    }
  });

  it('未传请求头 → 不 304', () => {
    const res = mockRes();
    const result = setRenderResponseHeaders(res, undefined, baseInput);
    expect(result.isNotModified).toBe(false);
    expect(res.statusCode).toBe(200);
  });

  it('statusCode 传入自定义值（如 201）+ 未触发 304 时保留', () => {
    const res = mockRes();
    setRenderResponseHeaders(res, undefined, { ...baseInput, statusCode: 201 });
    expect(res.statusCode).toBe(201);
  });
});
