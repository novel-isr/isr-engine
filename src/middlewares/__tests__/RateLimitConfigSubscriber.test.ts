/**
 * RateLimitConfigSubscriber —— Redis pub/sub hot-reload 行为单测
 *
 * 关键不变量：
 *   - 启动期 cmd.get('rate-limit:config:<app>') 拿快照（pod 重启后不丢配置）
 *   - 收到 'rate-limit:config:updated' 频道消息且 app 匹配 → handle.setConfig 被调
 *   - app 不匹配的消息被忽略（多 app 共用一个 Redis 时不能串台）
 *   - cleared:true 不强制复原（默认值留在 closure 里，重启 pod 才取静态默认）
 *   - 非法 JSON 不抛错 / 不调用 setConfig（订阅器要 fail-safe）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import IoRedisMock from 'ioredis-mock';

vi.mock('ioredis', () => ({ default: IoRedisMock, Redis: IoRedisMock, __esModule: true }));

import { startRateLimitConfigSubscriber } from '../RateLimitConfigSubscriber';
import type { RateLimiterHandle } from '../RateLimiter';

const wait = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

function makeFakeHandle(): RateLimiterHandle & {
  calls: Array<{ max?: number; windowMs?: number }>;
} {
  const calls: Array<{ max?: number; windowMs?: number }> = [];
  const handle = (async () => {}) as unknown as RateLimiterHandle & {
    calls: typeof calls;
  };
  handle.calls = calls;
  handle.setConfig = patch => {
    calls.push(patch);
  };
  handle.getConfig = () => ({ max: 100, windowMs: 60_000 });
  return handle;
}

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

describe('RateLimitConfigSubscriber', () => {
  it('启动时主动拉快照，调用 handle.setConfig', async () => {
    // 先把快照写到 Redis
    const direct = new IoRedisMock();
    await direct.set(
      'rate-limit:config:novel-rating',
      JSON.stringify({ app: 'novel-rating', max: 250, windowMs: 30_000 })
    );

    const handle = makeFakeHandle();
    const sub = await startRateLimitConfigSubscriber({
      appName: 'novel-rating',
      handle,
      redisUrl: 'redis://localhost:6379',
    });
    expect(sub).not.toBeNull();
    await wait(20);

    expect(handle.calls).toContainEqual({ max: 250, windowMs: 30_000 });

    await sub!.close();
    await direct.quit();
  });

  it('rate-limit:config:updated 频道收到匹配 app 的消息 → setConfig', async () => {
    const handle = makeFakeHandle();
    const sub = await startRateLimitConfigSubscriber({
      appName: 'novel-rating',
      handle,
      redisUrl: 'redis://localhost:6379',
    });
    await wait(50); // 等 subscribe 握手完成

    const publisher = new IoRedisMock();
    await publisher.publish(
      'rate-limit:config:updated',
      JSON.stringify({ app: 'novel-rating', max: 999, windowMs: 120_000 })
    );
    await wait(50);

    expect(handle.calls).toContainEqual({ max: 999, windowMs: 120_000 });

    await sub!.close();
    await publisher.quit();
  });

  it('其他 app 的消息被忽略', async () => {
    const handle = makeFakeHandle();
    const sub = await startRateLimitConfigSubscriber({
      appName: 'novel-rating',
      handle,
      redisUrl: 'redis://localhost:6379',
    });
    await wait(50);

    const publisher = new IoRedisMock();
    await publisher.publish(
      'rate-limit:config:updated',
      JSON.stringify({ app: 'some-other-app', max: 1, windowMs: 1000 })
    );
    await wait(50);

    expect(handle.calls).toHaveLength(0);

    await sub!.close();
    await publisher.quit();
  });

  it('cleared:true 不强制复原默认（仅 log，配置原样保持）', async () => {
    const handle = makeFakeHandle();
    const sub = await startRateLimitConfigSubscriber({
      appName: 'novel-rating',
      handle,
      redisUrl: 'redis://localhost:6379',
    });
    await wait(50);

    const publisher = new IoRedisMock();
    await publisher.publish(
      'rate-limit:config:updated',
      JSON.stringify({ app: 'novel-rating', cleared: true })
    );
    await wait(50);

    // setConfig 不应被 cleared 触发
    expect(handle.calls).toHaveLength(0);

    await sub!.close();
    await publisher.quit();
  });

  it('非法 JSON 不抛错、不调用 setConfig', async () => {
    const handle = makeFakeHandle();
    const sub = await startRateLimitConfigSubscriber({
      appName: 'novel-rating',
      handle,
      redisUrl: 'redis://localhost:6379',
    });
    await wait(50);

    const publisher = new IoRedisMock();
    await publisher.publish('rate-limit:config:updated', 'not-json-at-all');
    await wait(50);

    expect(handle.calls).toHaveLength(0);

    await sub!.close();
    await publisher.quit();
  });

  it('refresh() 重新拉一次快照', async () => {
    const handle = makeFakeHandle();
    const sub = await startRateLimitConfigSubscriber({
      appName: 'novel-rating',
      handle,
      redisUrl: 'redis://localhost:6379',
    });
    await wait(50);
    handle.calls.length = 0; // 清掉初始 refresh 可能产生的 call

    const publisher = new IoRedisMock();
    await publisher.set(
      'rate-limit:config:novel-rating',
      JSON.stringify({ app: 'novel-rating', max: 50, windowMs: 10_000 })
    );

    await sub!.refresh();
    expect(handle.calls).toContainEqual({ max: 50, windowMs: 10_000 });

    await sub!.close();
    await publisher.quit();
  });
});
