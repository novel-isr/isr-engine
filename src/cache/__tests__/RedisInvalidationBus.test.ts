/**
 * RedisInvalidationBus —— Sorted Set 重放补偿（v2.1 修复）
 *
 * 跨 Pod ISR 失效的核心诉求：
 *   pod1 发出 `revalidateTag('books')` → Redis channel publish →
 *   pod2/pod3 订阅并清自己的 L1 缓存。
 *
 * 旧版 Pub/Sub fire-and-forget，subscriber 瞬断时消息永久丢失。
 * 修复：publish 同时 ZADD 到日志，subscriber (re)connect 时 ZRANGEBYSCORE 拉补。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import IoRedisMock from 'ioredis-mock';

vi.mock('ioredis', () => ({ default: IoRedisMock, __esModule: true }));

import { RedisInvalidationBus } from '../RedisInvalidationBus';
import type { IsrInvalidationTarget } from '../../plugin/isrCacheMiddleware';

/** 等 N ms —— 让异步 init / Pub/Sub 有时间完成握手 */
const wait = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

// 每个 test 开始前清空 ioredis-mock 的全局状态（默认各实例共享数据）
beforeEach(async () => {
  const m = new IoRedisMock();
  await m.flushall();
  await m.quit();
});

afterEach(async () => {
  const m = new IoRedisMock();
  await m.flushall();
  await m.quit();
});

describe('RedisInvalidationBus —— origin 过滤（防止自己发的消息被自己处理）', () => {
  it('来自自己 origin 的消息被跳过', async () => {
    const bus = new RedisInvalidationBus({ host: 'localhost', keyPrefix: 'bus1a:' });
    await wait(80);

    const received: IsrInvalidationTarget[] = [];
    bus.subscribe(t => void received.push(t));

    // 用自己的 origin 构造一条消息 —— handleMessage 应该跳过
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const myOrigin = (bus as any).origin as string;
    const selfMsg = JSON.stringify({
      origin: myOrigin,
      target: { kind: 'tag', value: 'self' },
      sentAt: Date.now(),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (bus as any).handleMessage(selfMsg);

    expect(received).toHaveLength(0);

    await bus.destroy();
  });

  it('来自其他 origin 的消息被分发给所有 listener', async () => {
    const bus = new RedisInvalidationBus({ host: 'localhost', keyPrefix: 'bus1b:' });
    await wait(80);

    const got1: IsrInvalidationTarget[] = [];
    const got2: IsrInvalidationTarget[] = [];
    bus.subscribe(t => void got1.push(t));
    bus.subscribe(t => void got2.push(t));

    const otherMsg = JSON.stringify({
      origin: 'other-pod',
      target: { kind: 'path', value: '/books' },
      sentAt: Date.now(),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (bus as any).handleMessage(otherMsg);

    expect(got1).toHaveLength(1);
    expect(got1[0]).toEqual({ kind: 'path', value: '/books' });
    expect(got2).toHaveLength(1);

    await bus.destroy();
  });

  it('格式非法的消息被静默丢弃（不抛错、不分发）', async () => {
    const bus = new RedisInvalidationBus({ host: 'localhost', keyPrefix: 'bus1c:' });
    await wait(80);

    const got: IsrInvalidationTarget[] = [];
    bus.subscribe(t => void got.push(t));

    // 各种非法 payload
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (bus as any).handleMessage('not json at all');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (bus as any).handleMessage(JSON.stringify({}));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (bus as any).handleMessage(
      JSON.stringify({ origin: 'x', target: { kind: 'bogus', value: 'v' } })
    );

    expect(got).toHaveLength(0);

    await bus.destroy();
  });
});

describe('RedisInvalidationBus —— 消息丢失补偿 (Sorted Set replay)', () => {
  it('publisher 发消息 → 日志 ZADD 可读；新 subscriber 启动后通过 replay 补到', async () => {
    // 关键：A 先发，B 后起。B 的 lastSeenSentAt 会 ≥ A 发消息的时间，
    // 所以 replay 拉不到（符合"首次启动不回放历史"设计）。
    // 这个测验证 publisher 端确实写了日志（后续 B 重连时才有数据可拉）
    const busA = new RedisInvalidationBus({
      host: 'localhost',
      keyPrefix: 'bus2:',
      replayWindowMs: 60_000,
    });
    await wait(80);

    await busA.publish({ kind: 'path', value: '/books' });
    await busA.publish({ kind: 'tag', value: 'featured' });
    await wait(50);

    // 直连 Redis 检查日志 key
    const direct = new IoRedisMock();
    const channelLogKey = 'bus2:invalidate:log';
    const count = await direct.zcard(channelLogKey);
    expect(count).toBeGreaterThanOrEqual(2);

    const raws = await direct.zrangebyscore(channelLogKey, '-inf', '+inf');
    const parsed = raws.map((r: string) => JSON.parse(r));
    const kinds = parsed.map((m: { target: IsrInvalidationTarget }) => m.target.kind);
    expect(kinds).toContain('path');
    expect(kinds).toContain('tag');

    await direct.quit();
    await busA.destroy();
  });

  it('replayWindowMs=0 → 不写日志，回到纯 Pub/Sub 行为', async () => {
    const bus = new RedisInvalidationBus({
      host: 'localhost',
      keyPrefix: 'bus3:',
      replayWindowMs: 0,
    });
    await wait(80);

    await bus.publish({ kind: 'tag', value: 'nolog' });
    await wait(50);

    const direct = new IoRedisMock();
    const count = await direct.zcard('bus3:invalidate:log');
    expect(count).toBe(0);
    await direct.quit();
    await bus.destroy();
  });

  it('日志条目超过 replayLogMaxEntries → ZREMRANGEBYRANK 自动裁剪', async () => {
    const bus = new RedisInvalidationBus({
      host: 'localhost',
      keyPrefix: 'bus4:',
      replayWindowMs: 60_000,
      replayLogMaxEntries: 3, // 设成极小值便于测
    });
    await wait(80);

    for (let i = 0; i < 10; i++) {
      await bus.publish({ kind: 'path', value: `/p${i}` });
    }
    await wait(80);

    const direct = new IoRedisMock();
    const count = await direct.zcard('bus4:invalidate:log');
    // 裁剪后应 ≤ replayLogMaxEntries
    expect(count).toBeLessThanOrEqual(3);
    await direct.quit();
    await bus.destroy();
  });

  it('显式调用私有 replayMissed —— 被 lastSeenSentAt 往前拽时回拉消息', async () => {
    // 场景：bus 已有历史日志，模拟重连后 lastSeen 回拨 → 触发 replay
    const bus = new RedisInvalidationBus({
      host: 'localhost',
      keyPrefix: 'bus5:',
      replayWindowMs: 60_000,
    });
    await wait(80);

    // 先用另一个 client 塞一批"历史消息"到日志（不走 bus.publish 以避免 origin 过滤）
    const direct = new IoRedisMock();
    const now = Date.now();
    const msg = (value: string) =>
      JSON.stringify({
        origin: 'remote-pod-id',
        target: { kind: 'tag', value },
        sentAt: now - 1000,
      });
    await direct.zadd('bus5:invalidate:log', now - 3000, msg('a'));
    await direct.zadd('bus5:invalidate:log', now - 2000, msg('b'));
    await direct.zadd('bus5:invalidate:log', now - 1000, msg('c'));

    const received: string[] = [];
    bus.subscribe(t => void received.push(t.value));

    // 手动回拨 lastSeenSentAt → 让 replay 能看到这些历史消息
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (bus as any).lastSeenSentAt = now - 5000;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (bus as any).replayMissed();

    // 三条历史都应被 listener 看到（按 sentAt 升序）
    expect(received).toEqual(['a', 'b', 'c']);

    await direct.quit();
    await bus.destroy();
  });

  it('水位线 lastSeenSentAt 只前进不回退', async () => {
    const bus = new RedisInvalidationBus({
      host: 'localhost',
      keyPrefix: 'bus6:',
      replayWindowMs: 60_000,
    });
    await wait(80);

    const now = Date.now();
    const msgLater = JSON.stringify({
      origin: 'other',
      target: { kind: 'path', value: '/later' },
      sentAt: now + 1000,
    });
    const msgEarlier = JSON.stringify({
      origin: 'other',
      target: { kind: 'path', value: '/earlier' },
      sentAt: now - 1000,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (bus as any).handleMessage(msgLater);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hw1 = (bus as any).lastSeenSentAt as number;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (bus as any).handleMessage(msgEarlier);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hw2 = (bus as any).lastSeenSentAt as number;

    expect(hw2).toBe(hw1); // 水位未回退

    await bus.destroy();
  });
});
