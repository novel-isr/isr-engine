/**
 * TraceSnapshotWriter —— 每请求快照写入 + 采样行为
 *
 * 关键不变量：
 *   - 错误请求（status >= 500）强制采样
 *   - x-debug-trace: 1 头强制采样
 *   - sampleRate=1 → 全部采样；sampleRate=0 → 不采（除上述强制条件）
 *   - 写入：trace:<traceId> JSON + LPUSH 到 trace:recent
 *   - 没有 RequestContext.traceId → 不写入
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

async function buildApp(opts: { sampleRate: number; status?: number; debugHeader?: string }) {
  const writer = await createTraceSnapshotWriter({
    redisUrl: 'redis://localhost:6379',
    appName: 'test-app',
    sampleRate: opts.sampleRate,
  });
  if (!writer) throw new Error('writer null');

  const app = express();
  app.use((req, _res, next) => {
    requestContext.run(
      {
        traceId: 'trace-test-id',
        requestId: 'req-test',
        cookies: { theme: 'dark' },
        acceptLanguage: 'zh-CN',
      },
      () => {
        // headers 兼容：测试时直接调函数
        if (opts.debugHeader) req.headers['x-debug-trace'] = opts.debugHeader;
        next();
      }
    );
  });
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
  it('sampleRate=1 → 写入快照 + LPUSH 到 recent', async () => {
    const { app, writer } = await buildApp({ sampleRate: 1 });
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

  it('sampleRate=0 + status=200 → 不写入', async () => {
    const { app, writer } = await buildApp({ sampleRate: 0 });
    await call(app);
    await wait(50);

    const direct = new IoRedisMock();
    const raw = await direct.get('isr:trace:trace-test-id');
    expect(raw).toBeNull();

    await direct.quit();
    await writer.close();
  });

  it('sampleRate=0 + status=500 → 强制写入（错误兜底）', async () => {
    const { app, writer } = await buildApp({ sampleRate: 0, status: 500 });
    await call(app);
    await wait(50);

    const direct = new IoRedisMock();
    const raw = await direct.get('isr:trace:trace-test-id');
    expect(raw).toBeTruthy();
    const snap = JSON.parse(raw as string);
    expect(snap.status).toBe(500);

    await direct.quit();
    await writer.close();
  });

  it('sampleRate=0 + x-debug-trace=1 → 强制写入（QA 排障开关）', async () => {
    const { app, writer } = await buildApp({ sampleRate: 0 });
    await call(app, { 'x-debug-trace': '1' });
    await wait(50);

    const direct = new IoRedisMock();
    const raw = await direct.get('isr:trace:trace-test-id');
    expect(raw).toBeTruthy();

    await direct.quit();
    await writer.close();
  });
});
