/**
 * TraceSnapshotWriter —— 100% 全采写入行为
 *
 * 关键不变量：
 *   - 任何请求都写入（成功 / 错误一视同仁，100% 全采）
 *   - 写入：isr:trace:<traceId> JSON + LPUSH 到 isr:trace:recent
 *   - 读 RequestContext.userId / sessionUser；referer / acceptLanguage 直读 req.headers
 *   - 没有 RequestContext.traceId → 不写入（business middleware 没初始化 ctx 时跳过）
 */
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import IoRedisMock from 'ioredis-mock';

vi.mock('ioredis', () => ({ default: IoRedisMock, Redis: IoRedisMock, __esModule: true }));

import { createTraceSnapshotWriter } from '../TraceSnapshotWriter';
import { requestContext } from '../../context/RequestContext';

const wait = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

beforeEach(async () => {
  const m = new IoRedisMock();
  await m.flushall();
  await m.quit();
});

afterEach(async () => {
  const m = new IoRedisMock();
  await m.flushall();
  await m.quit();
  vi.restoreAllMocks();
});

async function buildApp(opts: { status?: number; setCtx?: boolean } = {}) {
  const writer = await createTraceSnapshotWriter({
    redisUrl: 'redis://localhost:6379',
    appName: 'test-app',
  });
  if (!writer) throw new Error('writer null');

  const app = express();
  if (opts.setCtx !== false) {
    app.use((_req, _res, next) => {
      requestContext.run(
        {
          traceId: 'trace-test-id',
          requestId: 'req-test',
          cookies: { theme: 'dark' },
        },
        () => next()
      );
    });
  }
  app.use(writer.middleware);
  app.get('/test', (_req, res) => {
    res.status(opts.status ?? 200).send('ok');
  });
  return { app, writer };
}

async function call(app: express.Express, headers: Record<string, string> = {}) {
  return new Promise<{ status: number }>((resolve, reject) => {
    const server = app.listen(0, async () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        return reject(new Error('no addr'));
      }
      try {
        const res = await fetch(`http://127.0.0.1:${addr.port}/test`, { headers });
        await res.text();
        server.close(() => resolve({ status: res.status }));
      } catch (err) {
        server.close();
        reject(err);
      }
    });
  });
}

describe('TraceSnapshotWriter', () => {
  it('成功请求写入快照 + LPUSH 到 recent index', async () => {
    const { app, writer } = await buildApp();
    const res = await call(app);
    expect(res.status).toBe(200);
    await wait(50);

    const direct = new IoRedisMock();
    const raw = await direct.get('isr:trace:trace-test-id');
    expect(raw).toBeTruthy();
    const snap = JSON.parse(raw as string);
    expect(snap).toMatchObject({
      traceId: 'trace-test-id',
      app: 'test-app',
      method: 'GET',
      path: '/test',
      status: 200,
    });
    expect(snap.context.cookieKeys).toContain('theme');

    const recent = await direct.lrange('isr:trace:recent', 0, -1);
    expect(recent).toContain('trace-test-id');

    await direct.quit();
    await writer.close();
  });

  it('错误请求（500）也写入', async () => {
    const { app, writer } = await buildApp({ status: 500 });
    await call(app);
    await wait(50);

    const direct = new IoRedisMock();
    const raw = await direct.get('isr:trace:trace-test-id');
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw as string).status).toBe(500);

    await direct.quit();
    await writer.close();
  });

  it('referer / acceptLanguage 直读 req.headers（不依赖 ctx）', async () => {
    const { app, writer } = await buildApp();
    await call(app, {
      referer: 'https://example.com/from',
      'accept-language': 'zh-CN',
    });
    await wait(50);

    const direct = new IoRedisMock();
    const raw = await direct.get('isr:trace:trace-test-id');
    const snap = JSON.parse(raw as string);
    expect(snap.request.referer).toBe('https://example.com/from');
    expect(snap.request.acceptLanguage).toBe('zh-CN');

    await direct.quit();
    await writer.close();
  });

  it('没有 RequestContext → 跳过写入（fail-safe）', async () => {
    const { app, writer } = await buildApp({ setCtx: false });
    await call(app);
    await wait(50);

    const direct = new IoRedisMock();
    const raw = await direct.get('isr:trace:trace-test-id');
    expect(raw).toBeNull();

    await direct.quit();
    await writer.close();
  });
});
