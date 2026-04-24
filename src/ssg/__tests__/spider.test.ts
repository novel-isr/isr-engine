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
