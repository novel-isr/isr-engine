import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createExposureQueue, resolveExposureQueue } from '../ExposureQueue';

function makeEvent(overrides: Partial<Parameters<ReturnType<typeof createExposureQueue>['push']>[0]> = {}) {
  return {
    anonId: 'anon-1',
    userId: null,
    requestId: 'req-1',
    experiments: { hero: 'bold' },
    path: '/',
    ts: Date.now(),
    ...overrides,
  };
}

describe('ExposureQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('攒满 batchSize 立即 flush', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const q = createExposureQueue({
      endpoint: 'http://x/api',
      batchSize: 3,
      flushIntervalMs: 1000,
      fetcher,
    });
    q.push(makeEvent());
    q.push(makeEvent());
    expect(fetcher).not.toHaveBeenCalled();
    q.push(makeEvent());
    // 攒够 3 条 → 立即 flush（microtask 排队）
    await vi.runAllTimersAsync();
    expect(fetcher).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(body.events).toHaveLength(3);
    q.destroy();
  });

  it('未满 batchSize 但到 flushIntervalMs 也 flush', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const q = createExposureQueue({
      endpoint: 'http://x/api',
      batchSize: 100,
      flushIntervalMs: 200,
      fetcher,
    });
    q.push(makeEvent());
    expect(fetcher).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    expect(fetcher).toHaveBeenCalledTimes(1);
    q.destroy();
  });

  it('sampleRate=0 完全不上报', () => {
    const fetcher = vi.fn();
    const q = createExposureQueue({
      endpoint: 'http://x/api',
      sampleRate: 0,
      fetcher,
    });
    for (let i = 0; i < 50; i++) q.push(makeEvent());
    expect(q.size).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
    q.destroy();
  });

  it('队列满（maxQueueSize）丢最早事件', () => {
    const fetcher = vi.fn();
    const q = createExposureQueue({
      endpoint: 'http://x/api',
      batchSize: 100, // 不会被 batchSize 触发 flush
      flushIntervalMs: 10_000, // 不会被定时器触发 flush
      maxQueueSize: 3,
      fetcher,
    });
    q.push(makeEvent({ anonId: 'a' }));
    q.push(makeEvent({ anonId: 'b' }));
    q.push(makeEvent({ anonId: 'c' }));
    q.push(makeEvent({ anonId: 'd' })); // 推超过上限，丢 'a'
    expect(q.size).toBe(3);
    q.destroy();
  });

  it('上报失败不抛错，业务无感知', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('admin-server down'));
    const q = createExposureQueue({
      endpoint: 'http://x/api',
      batchSize: 1,
      fetcher,
    });
    expect(() => q.push(makeEvent())).not.toThrow();
    await vi.runAllTimersAsync();
    expect(fetcher).toHaveBeenCalled();
    q.destroy();
  });

  it('destroy 后 push 静默丢弃', () => {
    const fetcher = vi.fn();
    const q = createExposureQueue({ endpoint: 'http://x/api', fetcher });
    q.destroy();
    q.push(makeEvent());
    expect(q.size).toBe(0);
  });

  it('admin-server 返回 4xx/5xx 也吞，不重试', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
    const q = createExposureQueue({
      endpoint: 'http://x/api',
      batchSize: 1,
      fetcher,
    });
    q.push(makeEvent());
    await vi.runAllTimersAsync();
    expect(fetcher).toHaveBeenCalledTimes(1); // 不重试
    q.destroy();
  });
});

describe('resolveExposureQueue', () => {
  it('config 缺 endpoint → null', () => {
    expect(resolveExposureQueue(undefined, 'http://x')).toBeNull();
    expect(resolveExposureQueue({ endpoint: '', batchSize: undefined, flushIntervalMs: undefined, sampleRate: undefined, enabled: undefined }, 'http://x')).toBeNull();
  });

  it('enabled=false → null', () => {
    expect(
      resolveExposureQueue(
        { endpoint: '/api', enabled: false, batchSize: undefined, flushIntervalMs: undefined, sampleRate: undefined },
        'http://x'
      )
    ).toBeNull();
  });

  it('相对路径无 baseOrigin → null', () => {
    expect(
      resolveExposureQueue(
        { endpoint: '/api', batchSize: undefined, flushIntervalMs: undefined, sampleRate: undefined, enabled: undefined },
        undefined
      )
    ).toBeNull();
  });

  it('相对路径 + baseOrigin → 拼接成绝对 URL', () => {
    const q = resolveExposureQueue(
      { endpoint: '/api/x', batchSize: undefined, flushIntervalMs: undefined, sampleRate: undefined, enabled: undefined },
      'http://localhost:8080/'
    );
    expect(q).not.toBeNull();
    q?.destroy();
  });
});
