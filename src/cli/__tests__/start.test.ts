/**
 * cli/start —— 生产服务器装配
 *
 * `startProductionServer` 涉及大量动态 import（dist/rsc/index.js, security middleware,
 * cache adapter, SEO engine, etc.），完整 e2e 测试需要太多 mock。这里聚焦三个关键的
 * 纯函数 / 适配器 helper —— 它们每条请求都跑，错一行整个生产路径就崩：
 *
 *   1. extractRoutesForSitemap —— ssr.config 路由表过滤逻辑
 *   2. nodeToWebRequest        —— Express req → Web Request 协议转换
 *   3. pipeWebResponse         —— Web Response → Express res 流式回写
 *
 * 这三个一旦出 bug，bench 测出来的 QPS 全是错的（请求/响应都失真）。
 */
import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { Request as ExpressReq, Response as ExpressRes } from 'express';
import { extractRoutesForSitemap, nodeToWebRequest, pipeWebResponse } from '../start';

describe('extractRoutesForSitemap —— 路由筛选', () => {
  it('返回静态路由 + 跳过通配符 / 动态参数 / 内部 / API', () => {
    const result = extractRoutesForSitemap({
      routeOverrides: {
        '/': 'isr',
        '/about': 'ssg',
        '/contact': 'ssg',
        '/books/*': 'isr', // 通配 → 跳过
        '/users/:id': 'ssr', // 动态 → 跳过
        '/__isr/stats': 'ssr', // 内部 → 跳过
        '/api/health': 'ssr', // API → 跳过
      },
    });
    expect(result.sort()).toEqual(['/', '/about', '/contact']);
  });

  it('routeOverrides 优先于 routes 别名', () => {
    const result = extractRoutesForSitemap({
      routeOverrides: { '/new': 'isr' },
      routes: { '/old': 'isr' },
    });
    expect(result).toEqual(['/new']);
  });

  it('无 routeOverrides 时退到 routes 别名', () => {
    const result = extractRoutesForSitemap({
      routes: { '/legacy': 'isr', '/about': 'ssg' },
    });
    expect(result.sort()).toEqual(['/about', '/legacy']);
  });

  it('两个都没传 → 空数组', () => {
    expect(extractRoutesForSitemap({})).toEqual([]);
  });

  it('只有内部 / API / 通配 路由 → 空数组', () => {
    const result = extractRoutesForSitemap({
      routeOverrides: {
        '/api/x': 'ssr',
        '/__isr/clear': 'ssr',
        '/blog/*': 'isr',
        '/users/:id': 'ssr',
      },
    });
    expect(result).toEqual([]);
  });
});

/** 构造最小 Express req mock —— 仅包含 nodeToWebRequest 用到的字段 */
function mockReq(opts: {
  url?: string;
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: Buffer | string;
}): ExpressReq {
  const headers = opts.headers ?? { host: 'example.com' };
  const method = opts.method ?? 'GET';
  // 用 Readable.from 把 body 包成 stream（仅 POST/PUT 等需要）
  const stream =
    opts.body !== undefined ? Readable.from([Buffer.from(opts.body)]) : Readable.from([]);
  return Object.assign(stream, {
    url: opts.url ?? '/',
    method,
    headers,
  }) as unknown as ExpressReq;
}

describe('nodeToWebRequest —— Express → Web Request 适配', () => {
  it('GET 请求：URL + headers 正确转换，无 body', () => {
    const req = mockReq({
      url: '/books?id=42',
      method: 'GET',
      headers: { host: 'example.com', 'user-agent': 'autocannon' },
    });
    const webReq = nodeToWebRequest(req);
    expect(webReq.url).toBe('http://example.com/books?id=42');
    expect(webReq.method).toBe('GET');
    expect(webReq.headers.get('user-agent')).toBe('autocannon');
    expect(webReq.body).toBeNull(); // GET 不应有 body
  });

  it('host 缺失 → 用 localhost 兜底', () => {
    const req = mockReq({ headers: {} });
    const webReq = nodeToWebRequest(req);
    expect(webReq.url).toBe('http://localhost/');
  });

  it('X-Forwarded-Proto=https → 用 https schema', () => {
    const req = mockReq({
      headers: { host: 'app.example.com', 'x-forwarded-proto': 'https' },
    });
    const webReq = nodeToWebRequest(req);
    expect(webReq.url.startsWith('https://')).toBe(true);
  });

  it('多值 header（如 cookie）→ append 而非覆盖', () => {
    const req = mockReq({
      headers: {
        host: 'example.com',
        cookie: ['a=1', 'b=2'],
      },
    });
    const webReq = nodeToWebRequest(req);
    // Headers 内部对 cookie 多值会用 ", " 拼接（Web Headers 规范）
    expect(webReq.headers.get('cookie')).toContain('a=1');
    expect(webReq.headers.get('cookie')).toContain('b=2');
  });

  it('null/undefined header 值跳过（不污染 Headers）', () => {
    const req = mockReq({
      headers: {
        host: 'example.com',
        'x-skip-me': undefined,
      },
    });
    const webReq = nodeToWebRequest(req);
    expect(webReq.headers.get('x-skip-me')).toBeNull();
  });

  it('POST 请求 → 设置 body + duplex:half', () => {
    const req = mockReq({
      url: '/api/x',
      method: 'POST',
      headers: { host: 'example.com', 'content-type': 'application/json' },
      body: '{"hello":"world"}',
    });
    const webReq = nodeToWebRequest(req);
    expect(webReq.method).toBe('POST');
    expect(webReq.body).not.toBeNull();
  });

  it('HEAD 请求 → 无 body（同 GET）', () => {
    const req = mockReq({ method: 'HEAD' });
    const webReq = nodeToWebRequest(req);
    expect(webReq.method).toBe('HEAD');
    expect(webReq.body).toBeNull();
  });
});

/** 极简 Express res mock —— 收集 status / headers / written body */
function mockRes(): {
  res: ExpressRes;
  status: () => number | undefined;
  headers: () => Record<string, string>;
  body: () => string;
  ended: () => boolean;
} {
  let statusCode: number | undefined;
  const headers: Record<string, string> = {};
  const chunks: Buffer[] = [];
  let _ended = false;

  const res = {
    status(code: number): typeof res {
      statusCode = code;
      return res;
    },
    setHeader(k: string, v: string): typeof res {
      headers[k] = v;
      return res;
    },
    write(chunk: Buffer | string): boolean {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return true;
    },
    end(chunk?: Buffer | string): typeof res {
      if (chunk !== undefined) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      _ended = true;
      return res;
    },
    on(_event: string, _cb: () => void): typeof res {
      return res;
    },
    once(_event: string, _cb: () => void): typeof res {
      return res;
    },
    emit(): boolean {
      return true;
    },
  } as unknown as ExpressRes;

  return {
    res,
    status: () => statusCode,
    headers: () => headers,
    body: () => Buffer.concat(chunks).toString('utf8'),
    ended: () => _ended,
  };
}

describe('pipeWebResponse —— Web Response → Express res', () => {
  it('200 + headers + body 正确转写', async () => {
    const m = mockRes();
    const webResp = new Response('<html>ok</html>', {
      status: 200,
      headers: { 'content-type': 'text/html', 'x-custom': 'foo' },
    });
    await pipeWebResponse(webResp, m.res);

    expect(m.status()).toBe(200);
    expect(m.headers()['content-type']).toBe('text/html');
    expect(m.headers()['x-custom']).toBe('foo');
    expect(m.body()).toBe('<html>ok</html>');
  });

  it('content-length 头被剥离（Node 自己重新计算）', async () => {
    const m = mockRes();
    const webResp = new Response('hello', {
      status: 200,
      headers: { 'content-type': 'text/plain', 'content-length': '5' },
    });
    await pipeWebResponse(webResp, m.res);

    expect(m.headers()['content-length']).toBeUndefined();
    expect(m.headers()['Content-Length']).toBeUndefined();
    expect(m.body()).toBe('hello');
  });

  it('content-length 大小写无关都被剥离（Content-Length 也算）', async () => {
    const m = mockRes();
    // Web Headers normalizes 名字到小写，但保险起见
    const headers = new Headers();
    headers.set('Content-Length', '5');
    headers.set('content-type', 'text/plain');
    const webResp = new Response('hello', { status: 200, headers });
    await pipeWebResponse(webResp, m.res);

    expect(m.headers()['content-length']).toBeUndefined();
    expect(m.headers()['Content-Length']).toBeUndefined();
  });

  it('body=null（如 204 No Content）→ 直接 res.end()', async () => {
    const m = mockRes();
    const webResp = new Response(null, { status: 204 });
    await pipeWebResponse(webResp, m.res);

    expect(m.status()).toBe(204);
    expect(m.body()).toBe('');
    expect(m.ended()).toBe(true);
  });

  it('非 200 状态码透传（4xx / 5xx）', async () => {
    const m = mockRes();
    const webResp = new Response('not found', { status: 404 });
    await pipeWebResponse(webResp, m.res);
    expect(m.status()).toBe(404);
    expect(m.body()).toBe('not found');
  });

  it('流式 body 的多个 chunk 正确累积', async () => {
    const m = mockRes();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('part-A '));
        controller.enqueue(new TextEncoder().encode('part-B '));
        controller.enqueue(new TextEncoder().encode('part-C'));
        controller.close();
      },
    });
    const webResp = new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    });
    await pipeWebResponse(webResp, m.res);

    expect(m.body()).toBe('part-A part-B part-C');
  });
});

describe('startProductionServer —— 缺失构建产物时 fail-fast', () => {
  it('rscDistEntry / clientDir 都不存在 → process.exit(1)', async () => {
    // 这个测试只验证最早的 fail-fast 路径，不进入完整启动逻辑
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: unknown) => {
      throw new Error('__EXIT__');
    }) as never);

    try {
      // 改 cwd 到一个没有 dist 的临时目录
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const os = await import('node:os');
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'start-test-'));
      const origCwd = process.cwd();
      process.chdir(dir);

      try {
        const { startProductionServer } = await import('../start');
        await expect(startProductionServer({ port: '3000' })).rejects.toThrow('__EXIT__');
        expect(exitSpy).toHaveBeenCalledWith(1);
      } finally {
        process.chdir(origCwd);
        await fs.rm(dir, { recursive: true, force: true });
      }
    } finally {
      exitSpy.mockRestore();
    }
  });
});
