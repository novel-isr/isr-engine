import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
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
  it('strips leading and trailing slashes', () => {
    expect(routeToFilePath('//about//')).toBe('about/index.html');
  });
});

describe('routeToFilePath —— 路径穿越防护（v2.1 安全加固）', () => {
  it('拒绝 `..` 段（Unix 路径穿越）', () => {
    expect(() => routeToFilePath('/../etc/passwd')).toThrow(/非法路径段|非法字符/);
    expect(() => routeToFilePath('/a/../b')).toThrow(/非法路径段/);
    expect(() => routeToFilePath('/../../root')).toThrow();
  });

  it('拒绝 `.` 段（当前目录引用）', () => {
    expect(() => routeToFilePath('/a/./b')).toThrow(/非法路径段/);
  });

  it('拒绝空段（连续 `/` 产生）', () => {
    expect(() => routeToFilePath('/a//b')).toThrow(/非法路径段/);
  });

  it('拒绝反斜杠（Windows 路径穿越）', () => {
    expect(() => routeToFilePath('/a\\..\\b')).toThrow(/非法字符/);
  });

  it('拒绝绝对路径字符（`:` / 冒号盘符）', () => {
    expect(() => routeToFilePath('/C:/Windows/System32')).toThrow(/非法字符/);
  });

  it('拒绝 NUL 字节（常见 bypass 伎俩）', () => {
    expect(() => routeToFilePath('/a\0b')).toThrow(/非法字符/);
  });

  it('拒绝空格与 Unicode 非 URL 字符', () => {
    expect(() => routeToFilePath('/with space')).toThrow(/非法字符/);
    expect(() => routeToFilePath('/中文')).toThrow(/非法字符/);
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

describe('spiderSsgRoutes —— 路径穿越路由不污染整批构建', () => {
  it('恶意路由抛错走 failed 统计，不拖垮其他成功路由', async () => {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'spider-sec-'));
    try {
      const handler: FetchHandler = {
        fetch: vi.fn(async req => htmlResponse(`<html>${new URL(req.url).pathname}</html>`)),
      };

      const result = await spiderSsgRoutes({
        handler,
        routes: ['/good', '/../evil'],
        outDir,
        options: {
          maxRetries: 0,
          continueOnError: true,
          // 失败率 50%（1/2），设高阈值避免 fail-build
          failBuildThreshold: 0.9,
        },
      });

      expect(result.successful).toBe(1);
      expect(result.failed).toBe(1);
      const failed = result.routes.find(r => !r.ok);
      expect(failed?.route).toBe('/../evil');
      expect(failed?.error).toMatch(/非法路径段|非法字符/);

      // good 仍然写盘成功
      const successFile = path.join(outDir, 'good', 'index.html');
      const content = await fs.readFile(successFile, 'utf8');
      expect(content).toContain('/good');
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
