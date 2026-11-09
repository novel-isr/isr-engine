import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  extractSsgRoutes,
  routeToFilePath,
  spiderSsgRoutes,
  SsgBuildFailedError,
  type FetchHandler,
} from '../spider';

/** 临时目录 fixture —— 每个 test 独立隔离 */
async function tmpdir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'spider-test-'));
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

describe('routeToFilePath', () => {
  it('"/" → "index.html"', () => {
    expect(routeToFilePath('/')).toBe('index.html');
  });
  it('"/about" → "about/index.html"', () => {
    expect(routeToFilePath('/about')).toBe('about/index.html');
  });
  it('"/books/1" → "books/1/index.html"', () => {
    expect(routeToFilePath('/books/1')).toBe('books/1/index.html');
  });
  it('preserves one trailing slash without repairing malformed paths', () => {
    expect(routeToFilePath('/about/')).toBe('about/index.html');
    expect(() => routeToFilePath('//about//')).toThrow(/Invalid HTML route/);
  });
});

it.each([null, false, undefined, '', {}])(
  'rejects an explicitly invalid inline SSG source %s',
  routes => {
    return expect(
      extractSsgRoutes({ ssg: { routes: routes as never }, routes: { '/fallback': 'ssg' } })
    ).rejects.toThrow(/ssg.routes/);
  }
);

describe('routeToFilePath —— 路径穿越防护（v2.1 安全加固）', () => {
  it('拒绝 `..` 段（Unix 路径穿越）', () => {
    expect(() => routeToFilePath('/../etc/passwd')).toThrow(/Invalid HTML route/);
    expect(() => routeToFilePath('/a/../b')).toThrow(/Invalid HTML route/);
    expect(() => routeToFilePath('/../../root')).toThrow();
  });

  it('拒绝 `.` 段（当前目录引用）', () => {
    expect(() => routeToFilePath('/a/./b')).toThrow(/Invalid HTML route/);
  });

  it('拒绝空段（连续 `/` 产生）', () => {
    expect(() => routeToFilePath('/a//b')).toThrow(/Invalid HTML route/);
  });

  it('拒绝反斜杠（Windows 路径穿越）', () => {
    expect(() => routeToFilePath('/a\\..\\b')).toThrow(/Invalid HTML route/);
  });

  it('拒绝绝对路径字符（`:` / 冒号盘符）', () => {
    expect(() => routeToFilePath('/C:/Windows/System32')).toThrow(/Invalid HTML route/);
  });

  it('拒绝 NUL 字节（常见 bypass 伎俩）', () => {
    expect(() => routeToFilePath('/a\0b')).toThrow(/Invalid HTML route/);
  });

  it('拒绝空格与 Unicode 非 URL 字符', () => {
    expect(() => routeToFilePath('/with space')).toThrow(/Invalid HTML route/);
    expect(() => routeToFilePath('/中文')).toThrow(/Invalid HTML route/);
  });

  it('接受合法的百分号编码（URL unreserved + pct-encoded）', () => {
    expect(routeToFilePath('/books/%E4%B8%AD')).toBe('books/%E4%B8%AD/index.html');
  });

  it('接受 `-` / `_` / `.` / `~` / 字母数字', () => {
    expect(routeToFilePath('/posts/hello-world_2024.v1~draft')).toBe(
      'posts/hello-world_2024.v1~draft/index.html'
    );
  });
});

describe('spiderSsgRoutes —— 配置错误在渲染前拒绝', () => {
  it('拒绝非法路径，不执行任何渲染或写入', async () => {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'spider-sec-'));
    try {
      const handler: FetchHandler = {
        fetch: vi.fn(async req => htmlResponse(`<html>${new URL(req.url).pathname}</html>`)),
      };

      await expect(
        spiderSsgRoutes({
          handler,
          routes: ['/good', '/../evil'],
          outDir,
          options: { maxRetries: 0, continueOnError: true, failBuildThreshold: 0.9 },
        })
      ).rejects.toThrow(/Invalid HTML route/);
      expect(handler.fetch).not.toHaveBeenCalled();
      expect(await fs.readdir(outDir)).toEqual([]);
    } finally {
      await fs.rm(outDir, { recursive: true, force: true });
    }
  });
});

describe('spiderSsgRoutes —— 重试退避抖动（thundering herd 防护）', () => {
  it('多次连续 5xx 的退避间隔不严格相等（有 jitter）', async () => {
    // 让 handler 连续返回 503 耗尽重试；记录每次 fetch 的 timestamp
    const timestamps: number[] = [];
    const handler: FetchHandler = {
      fetch: async () => {
        timestamps.push(Date.now());
        return new Response('svc unavail', {
          status: 503,
          headers: { 'content-type': 'text/plain' },
        });
      },
    };

    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'spider-jitter-'));
    try {
      await spiderSsgRoutes({
        handler,
        routes: ['/x'],
        outDir,
        options: {
          maxRetries: 3,
          retryBaseDelayMs: 50,
          continueOnError: true,
          failBuildThreshold: 1.0,
        },
      });

      // 4 次尝试（1 首次 + 3 重试）→ 3 个间隔
      expect(timestamps.length).toBe(4);
      const gaps = [
        timestamps[1] - timestamps[0],
        timestamps[2] - timestamps[1],
        timestamps[3] - timestamps[2],
      ];

      // full jitter 算法：gap ∈ [0, baseDelay * 2^(n-1))
      // 上界：50ms、100ms、200ms。总和必然 < 350 + 执行开销
      // 下界：理论上可以是 0 但实际总有微秒级开销，我们只断言上界 + 非严格递增
      for (const g of gaps) {
        expect(g).toBeGreaterThanOrEqual(0);
      }
      // 每个间隔都不应该超过"2 倍上界"（给执行开销留 slack）
      expect(gaps[0]).toBeLessThan(50 * 2 + 30);
      expect(gaps[1]).toBeLessThan(100 * 2 + 30);
      expect(gaps[2]).toBeLessThan(200 * 2 + 30);
    } finally {
      await fs.rm(outDir, { recursive: true, force: true });
    }
  });
});

describe('spiderSsgRoutes —— happy path', () => {
  let outDir: string;
  beforeEach(async () => {
    outDir = await tmpdir();
  });
  afterEach(async () => {
    await fs.rm(outDir, { recursive: true, force: true });
  });

  it('writes HTML for each route', async () => {
    const handler: FetchHandler = {
      fetch: vi.fn(async req => htmlResponse(`<html>${new URL(req.url).pathname}</html>`)),
    };

    const result = await spiderSsgRoutes({
      handler,
      routes: ['/', '/about'],
      outDir,
      options: { maxRetries: 0 },
    });

    expect(result.successful).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.failureRate).toBe(0);
    expect(result.routes).toHaveLength(2);
    expect(result.routes.every(r => r.attempts === 1)).toBe(true);

    const root = await fs.readFile(path.join(outDir, 'index.html'), 'utf8');
    const about = await fs.readFile(path.join(outDir, 'about', 'index.html'), 'utf8');
    expect(root).toContain('/');
    expect(about).toContain('/about');
  });

  it('respects concurrency limit', async () => {
    let inflight = 0;
    let maxInflight = 0;
    const handler: FetchHandler = {
      fetch: async req => {
        inflight++;
        maxInflight = Math.max(maxInflight, inflight);
        await new Promise(r => setTimeout(r, 10));
        inflight--;
        return htmlResponse(`page ${req.url}`);
      },
    };

    await spiderSsgRoutes({
      handler,
      routes: ['/a', '/b', '/c', '/d', '/e', '/f'],
      outDir,
      options: { concurrency: 2, maxRetries: 0 },
    });

    expect(maxInflight).toBeLessThanOrEqual(2);
  });
});

describe('spiderSsgRoutes —— retry behavior', () => {
  let outDir: string;
  beforeEach(async () => {
    outDir = await tmpdir();
  });
  afterEach(async () => {
    await fs.rm(outDir, { recursive: true, force: true });
  });

  it('retries on 5xx, succeeds on later attempt', async () => {
    let calls = 0;
    const handler: FetchHandler = {
      fetch: async () => {
        calls++;
        if (calls < 3) return new Response('bad', { status: 503 });
        return htmlResponse('<html>ok</html>');
      },
    };

    const result = await spiderSsgRoutes({
      handler,
      routes: ['/about'],
      outDir,
      options: { maxRetries: 3, retryBaseDelayMs: 1 },
    });

    expect(calls).toBe(3);
    expect(result.successful).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.routes[0].attempts).toBe(3);
  });

  it('does NOT retry on 4xx (not retryable)', async () => {
    let calls = 0;
    const handler: FetchHandler = {
      fetch: async () => {
        calls++;
        return new Response('not found', { status: 404 });
      },
    };

    const result = await spiderSsgRoutes({
      handler,
      routes: ['/missing'],
      outDir,
      options: { maxRetries: 5, retryBaseDelayMs: 1, failBuildThreshold: 1 },
    });

    expect(calls).toBe(1); // 没重试
    expect(result.routes[0].attempts).toBe(1);
    expect(result.failed).toBe(1);
  });

  it('retries on network errors (TypeError from fetch)', async () => {
    let calls = 0;
    const handler: FetchHandler = {
      fetch: async () => {
        calls++;
        if (calls < 2) {
          // 模拟 fetch 的网络层错误
          throw new TypeError('fetch failed');
        }
        return htmlResponse('<html>recovered</html>');
      },
    };

    const result = await spiderSsgRoutes({
      handler,
      routes: ['/'],
      outDir,
      options: { maxRetries: 3, retryBaseDelayMs: 1 },
    });

    expect(calls).toBe(2);
    expect(result.successful).toBe(1);
  });

  it('exhausts retries on persistent 5xx', async () => {
    let calls = 0;
    const handler: FetchHandler = {
      fetch: async () => {
        calls++;
        return new Response('down', { status: 502 });
      },
    };

    const result = await spiderSsgRoutes({
      handler,
      routes: ['/dead'],
      outDir,
      options: { maxRetries: 2, retryBaseDelayMs: 1, failBuildThreshold: 1 },
    });

    expect(calls).toBe(3); // 1 first + 2 retries
    expect(result.failed).toBe(1);
    expect(result.routes[0].attempts).toBe(3);
  });
});

describe('spiderSsgRoutes —— timeout', () => {
  let outDir: string;
  beforeEach(async () => {
    outDir = await tmpdir();
  });
  afterEach(async () => {
    await fs.rm(outDir, { recursive: true, force: true });
  });

  it('aborts hung request after requestTimeoutMs and retries', async () => {
    let calls = 0;
    const handler: FetchHandler = {
      fetch: async req => {
        calls++;
        if (calls === 1) {
          // 第一次故意 hang —— signal 触发后 reject
          return new Promise<Response>((_, reject) => {
            req.signal.addEventListener('abort', () => reject(new Error('aborted')));
          });
        }
        return htmlResponse('<html>fast</html>');
      },
    };

    const result = await spiderSsgRoutes({
      handler,
      routes: ['/'],
      outDir,
      options: { maxRetries: 1, retryBaseDelayMs: 1, requestTimeoutMs: 50 },
    });

    expect(calls).toBe(2);
    expect(result.successful).toBe(1);
    expect(result.routes[0].attempts).toBe(2);
  }, 5000);
});

describe('spiderSsgRoutes —— failBuildThreshold', () => {
  let outDir: string;
  beforeEach(async () => {
    outDir = await tmpdir();
  });
  afterEach(async () => {
    await fs.rm(outDir, { recursive: true, force: true });
  });

  it('throws SsgBuildFailedError when failure rate > threshold', async () => {
    const handler: FetchHandler = {
      fetch: async req => {
        if (new URL(req.url).pathname === '/bad') {
          return new Response('nope', { status: 404 });
        }
        return htmlResponse('<html>ok</html>');
      },
    };

    // 4 routes, 1 fails → 25% failure rate, > 5% threshold → throws
    await expect(
      spiderSsgRoutes({
        handler,
        routes: ['/a', '/b', '/c', '/bad'],
        outDir,
        options: { maxRetries: 0, failBuildThreshold: 0.05 },
      })
    ).rejects.toBeInstanceOf(SsgBuildFailedError);
  });

  it('does NOT throw when failure rate ≤ threshold', async () => {
    const handler: FetchHandler = {
      fetch: async req => {
        if (new URL(req.url).pathname === '/bad') {
          return new Response('nope', { status: 404 });
        }
        return htmlResponse('<html>ok</html>');
      },
    };

    // 100 routes, 1 fails → 1% < 5% → ok
    const routes = Array.from({ length: 99 }, (_, i) => `/p${i}`);
    routes.push('/bad');
    const result = await spiderSsgRoutes({
      handler,
      routes,
      outDir,
      options: { maxRetries: 0, failBuildThreshold: 0.05 },
    });

    expect(result.failed).toBe(1);
    expect(result.failureRate).toBeLessThan(0.05);
  });

  it('failBuildThreshold=1.0 disables the gate (legacy behavior)', async () => {
    const handler: FetchHandler = {
      fetch: async () => new Response('nope', { status: 404 }),
    };

    const result = await spiderSsgRoutes({
      handler,
      routes: ['/all-bad-1', '/all-bad-2'],
      outDir,
      options: { maxRetries: 0, failBuildThreshold: 1.0 },
    });

    expect(result.failed).toBe(2);
    expect(result.failureRate).toBe(1);
    // 即使 100% 失败也不抛 —— 用户显式说不要 gate
  });

  it('SsgBuildFailedError carries SpiderResult and threshold', async () => {
    const handler: FetchHandler = {
      fetch: async () => new Response('nope', { status: 404 }),
    };

    try {
      await spiderSsgRoutes({
        handler,
        routes: ['/a'],
        outDir,
        options: { maxRetries: 0, failBuildThreshold: 0.05 },
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SsgBuildFailedError);
      const e = err as SsgBuildFailedError;
      expect(e.threshold).toBe(0.05);
      expect(e.result.failed).toBe(1);
      expect(e.result.total).toBe(1);
      expect(e.message).toContain('100.0%');
    }
  });
});

describe('spiderSsgRoutes —— continueOnError', () => {
  let outDir: string;
  beforeEach(async () => {
    outDir = await tmpdir();
  });
  afterEach(async () => {
    await fs.rm(outDir, { recursive: true, force: true });
  });

  it('continueOnError=false stops on first failure', async () => {
    let calls = 0;
    const handler: FetchHandler = {
      fetch: async req => {
        calls++;
        if (new URL(req.url).pathname === '/b') {
          return new Response('nope', { status: 404 });
        }
        return htmlResponse('<html>ok</html>');
      },
    };

    await expect(
      spiderSsgRoutes({
        handler,
        routes: ['/a', '/b', '/c'],
        outDir,
        options: { concurrency: 1, maxRetries: 0, continueOnError: false },
      })
    ).rejects.toThrow();

    // 在 /b 抛错时 /c 还没开始（concurrency=1 串行）
    expect(calls).toBeLessThanOrEqual(2);
  });

  it('rejects non-HTML content-type without retrying (config error)', async () => {
    let calls = 0;
    const handler: FetchHandler = {
      fetch: async () => {
        calls++;
        return new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    };

    const result = await spiderSsgRoutes({
      handler,
      routes: ['/api-by-mistake'],
      outDir,
      options: { maxRetries: 5, retryBaseDelayMs: 1, failBuildThreshold: 1 },
    });

    expect(calls).toBe(1); // content-type 错误不重试
    expect(result.failed).toBe(1);
    expect(result.routes[0].error).toContain('unsupported content-type');
  });
});

describe('extractSsgRoutes —— SSG 路由来源优先级', () => {
  it('ssg.routes 数组直接返回', async () => {
    const routes = await extractSsgRoutes({ ssg: { routes: ['/a', '/b'] } });
    expect(routes).toEqual(['/a', '/b']);
  });

  it('ssg.routes 支持异步函数（动态来源，如从 CMS 拉列表）', async () => {
    const routes = await extractSsgRoutes({
      ssg: { routes: async () => ['/books/1', '/books/2'] },
    });
    expect(routes).toEqual(['/books/1', '/books/2']);
  });

  it('ssg.routes 同步函数也可用', async () => {
    const routes = await extractSsgRoutes({ ssg: { routes: () => ['/x'] } });
    expect(routes).toEqual(['/x']);
  });

  it('未配置 ssg.routes 时回退到 routes 中 mode=ssg 的条目（字符串 / 对象两种写法）', async () => {
    const routes = await extractSsgRoutes({
      routes: {
        '/about': 'ssg',
        '/pricing': { mode: 'ssg', ttl: 60 },
        '/feed': 'isr',
        '/admin': { mode: 'ssr' },
      },
    });
    expect(routes.sort()).toEqual(['/about', '/pricing']);
  });

  it('通配符路由不可预生成，回退提取时跳过', async () => {
    const routes = await extractSsgRoutes({
      routes: { '/books/*': 'ssg', '/books/:id': 'ssg', '/about': 'ssg' },
    });
    expect(routes).toEqual(['/about']);
  });

  it('ssg.routes 优先于 routes mode=ssg（两者同时存在只取前者）', async () => {
    const routes = await extractSsgRoutes({
      ssg: { routes: ['/only-this'] },
      routes: { '/about': 'ssg' },
    });
    expect(routes).toEqual(['/only-this']);
  });

  it('两个来源都为空 → 空列表', async () => {
    expect(await extractSsgRoutes({})).toEqual([]);
  });
});

describe('whole-page deadline', () => {
  it('fails when response headers arrive before a slow body', async () => {
    const outDir = await tmpdir();
    let timer: ReturnType<typeof setTimeout>;
    const handler = {
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              timer = setTimeout(() => {
                controller.enqueue(new TextEncoder().encode('late'));
                controller.close();
              }, 120);
            },
            cancel() {
              clearTimeout(timer);
            },
          }),
          { headers: { 'content-type': 'text/html' } }
        ),
    };
    const result = await spiderSsgRoutes({
      handler,
      routes: ['/slow'],
      outDir,
      options: { requestTimeoutMs: 10, maxRetries: 0, failBuildThreshold: 1 },
    });
    expect(result.failed).toBe(1);
    expect(result.routes[0].error).toMatch(/timed out/);
    await fs.rm(outDir, { recursive: true, force: true });
  });
});

it('cancels a never-ending body without waiting for a stuck cancel hook', async () => {
  const outDir = await tmpdir();
  const cancel = vi.fn(() => new Promise<void>(() => {}));
  const handler = {
    fetch: async () =>
      new Response(new ReadableStream({ cancel }), { headers: { 'content-type': 'text/html' } }),
  };
  const result = await spiderSsgRoutes({
    handler,
    routes: ['/endless'],
    outDir,
    options: { requestTimeoutMs: 10, maxRetries: 1, retryBaseDelayMs: 0, failBuildThreshold: 1 },
  });
  expect(result.failed).toBe(1);
  expect(result.routes[0].attempts).toBe(2);
  expect(cancel).toHaveBeenCalledTimes(2);
  await fs.rm(outDir, { recursive: true, force: true });
});

it('applies the page deadline to a real HTTP response body and closes the socket', async () => {
  const outDir = await tmpdir();
  let responseClosed!: () => void;
  const closed = new Promise<void>(resolve => {
    responseClosed = resolve;
  });
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.flushHeaders();
    res.once('close', responseClosed);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  try {
    const result = await spiderSsgRoutes({
      handler: { fetch: request => fetch(request) },
      routes: ['/stream'],
      outDir,
      options: {
        baseUrl: `http://127.0.0.1:${address.port}`,
        requestTimeoutMs: 100,
        maxRetries: 0,
        failBuildThreshold: 1,
      },
    });
    expect(result.failed).toBe(1);
    expect(result.routes[0].error).toMatch(/timed out/);
    await closed;
    await expect(fs.access(path.join(outDir, 'stream/index.html'))).rejects.toThrow();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve()))
    );
    await fs.rm(outDir, { recursive: true, force: true });
  }
});

describe('SSG artifact identity preflight', () => {
  it.each([
    ['/foo', '/foo/'],
    ...(process.platform === 'win32'
      ? [
          ['/Foo', '/foo'],
          ['/foo.', '/foo'],
        ]
      : []),
  ])('rejects colliding routes %s and %s before rendering or writing', async (a, b) => {
    const outDir = await tmpdir();
    const handler = { fetch: vi.fn(async () => htmlResponse('page')) };
    try {
      await expect(spiderSsgRoutes({ handler, routes: ['/valid', a, b], outDir })).rejects.toThrow(
        /collision.*index.html/i
      );
      expect(handler.fetch).not.toHaveBeenCalled();
      expect(await fs.readdir(outDir)).toEqual([]);
    } finally {
      await fs.rm(outDir, { recursive: true, force: true });
    }
  });
  it('deduplicates exact identities while retaining distinct artifacts', async () => {
    const outDir = await tmpdir();
    const handler = { fetch: vi.fn(async () => htmlResponse('page')) };
    try {
      const result = await spiderSsgRoutes({ handler, routes: ['/foo', '/foo', '/bar'], outDir });
      expect(result.total).toBe(2);
      expect(result.successful).toBe(2);
      expect(handler.fetch).toHaveBeenCalledTimes(2);
    } finally {
      await fs.rm(outDir, { recursive: true, force: true });
    }
  });
});

it('uses the destination filesystem case sensitivity before rendering artifacts', async () => {
  const parent = await tmpdir();
  const outDir = path.join(parent, 'not-created-yet', 'nested');
  const probe = path.join(parent, 'CaseProbe');
  await fs.writeFile(probe, 'probe', { flag: 'wx' });
  let caseSensitive = false;
  try {
    await fs.writeFile(path.join(parent, 'caseprobe'), 'other', { flag: 'wx' });
    caseSensitive = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  await fs.rm(probe);
  if (caseSensitive) await fs.rm(path.join(parent, 'caseprobe'));
  const handler = {
    fetch: vi.fn(async (request: Request) => htmlResponse(new URL(request.url).pathname)),
  };
  try {
    const build = spiderSsgRoutes({ handler, routes: ['/Foo', '/foo'], outDir });
    if (caseSensitive) {
      expect((await build).successful).toBe(2);
      expect(await fs.readFile(path.join(outDir, 'Foo/index.html'), 'utf8')).toBe('/Foo');
      expect(await fs.readFile(path.join(outDir, 'foo/index.html'), 'utf8')).toBe('/foo');
    } else {
      await expect(build).rejects.toThrow(/collision.*index.html/i);
      expect(handler.fetch).not.toHaveBeenCalled();
      await expect(fs.access(outDir)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await fs.readdir(parent)).toEqual([]);
    }
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

it('does not create or inspect the destination for an empty route list', async () => {
  const parent = await tmpdir();
  const outDir = path.join(parent, 'absent');
  const handler = { fetch: vi.fn(async () => htmlResponse('unused')) };
  try {
    expect((await spiderSsgRoutes({ handler, routes: [], outDir })).total).toBe(0);
    expect(handler.fetch).not.toHaveBeenCalled();
    expect(await fs.readdir(parent)).toEqual([]);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

it.each([true, false])(
  'honors destination probe sensitivity %s independently of the OS',
  async sensitive => {
    const outDir = await tmpdir();
    const originalStat = fs.stat;
    const stat = vi.spyOn(fs, 'stat').mockImplementation(async (...args) => {
      const filename = String(args[0]);
      if (path.basename(filename) === 'caseprobe' && filename.includes('.isr-case-probe-')) {
        if (sensitive) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
        return originalStat(path.join(path.dirname(filename), 'CaseProbe'));
      }
      return originalStat(...args);
    });
    const handler = { fetch: vi.fn(async () => htmlResponse('missing', 404)) };
    try {
      const build = spiderSsgRoutes({
        handler,
        routes: ['/Foo', '/foo'],
        outDir,
        options: { failBuildThreshold: 1 },
      });
      if (sensitive) {
        expect((await build).failed).toBe(2);
        expect(handler.fetch).toHaveBeenCalledTimes(2);
      } else {
        await expect(build).rejects.toThrow(/case-insensitive destination/);
        expect(handler.fetch).not.toHaveBeenCalled();
      }
      expect(await fs.readdir(outDir)).toEqual([]);
      expect(
        stat.mock.calls.some(([filename]) =>
          String(filename).startsWith(path.join(outDir, '.isr-case-probe-'))
        )
      ).toBe(true);
    } finally {
      stat.mockRestore();
      await fs.rm(outDir, { recursive: true, force: true });
    }
  }
);

it('removes the destination probe when sensitivity detection fails', async () => {
  const outDir = await tmpdir();
  const originalStat = fs.stat;
  const stat = vi.spyOn(fs, 'stat').mockImplementation(async (...args) => {
    if (String(args[0]).includes('.isr-case-probe-')) {
      throw Object.assign(new Error('probe I/O failure'), { code: 'EIO' });
    }
    return originalStat(...args);
  });
  const handler = { fetch: vi.fn(async () => htmlResponse('unused')) };
  try {
    await expect(spiderSsgRoutes({ handler, routes: ['/Foo', '/foo'], outDir })).rejects.toThrow(
      'probe I/O failure'
    );
    expect(handler.fetch).not.toHaveBeenCalled();
    expect(await fs.readdir(outDir)).toEqual([]);
  } finally {
    stat.mockRestore();
    await fs.rm(outDir, { recursive: true, force: true });
  }
});

it.each(['headers', 'body', 'retry'] as const)(
  'cancels fatal batch siblings waiting for %s before returning',
  async phase => {
    const outDir = await tmpdir();
    let signal: AbortSignal | undefined;
    let release!: (response: Response) => void;
    // Even an uncooperative stream cancellation must not hold the batch open.
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const calls: string[] = [];
    const handler = {
      fetch: vi.fn(async (request: Request) => {
        const route = new URL(request.url).pathname;
        calls.push(route);
        if (route === '/bad') {
          await new Promise(resolve => setTimeout(resolve, 20));
          return htmlResponse('missing', 404);
        }
        signal = request.signal;
        if (phase === 'headers')
          return new Promise<Response>(resolve => {
            release = resolve;
          });
        if (phase === 'retry') return htmlResponse('retry', 503);
        return new Response(new ReadableStream({ cancel }), {
          headers: { 'content-type': 'text/html' },
        });
      }),
    };
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.99);
    try {
      const build = spiderSsgRoutes({
        handler,
        routes: ['/slow', '/bad', '/never'],
        outDir,
        options: {
          concurrency: 2,
          continueOnError: false,
          requestTimeoutMs: 0,
          retryBaseDelayMs: 10_000,
        },
      });
      const outcome = await Promise.race([
        build.then(
          () => 'resolved',
          () => 'rejected'
        ),
        new Promise<string>(resolve => setTimeout(() => resolve('hung'), 150)),
      ]);
      expect(outcome).toBe('rejected');
      if (phase !== 'retry') expect(signal?.aborted).toBe(true);
      expect(calls).toEqual(['/slow', '/bad']);
      if (phase === 'headers') {
        release(
          new Response(new ReadableStream({ cancel }), { headers: { 'content-type': 'text/html' } })
        );
      }
      await new Promise(resolve => setTimeout(resolve, 10));
      if (phase !== 'retry') expect(cancel).toHaveBeenCalledTimes(1);
      expect(await fs.readdir(outDir)).toEqual([]);
    } finally {
      random.mockRestore();
      await fs.rm(outDir, { recursive: true, force: true });
    }
  }
);
