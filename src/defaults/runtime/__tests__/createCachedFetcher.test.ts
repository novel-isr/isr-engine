/**
 * createCachedFetcher 单元测试
 *
 * 覆盖：
 *   - 命中缓存避免重复 fetch
 *   - 并发去重（多请求合并为一次）
 *   - TTL 过期重新拉取
 *   - SWR 模式（过期返回旧值 + 后台刷新）
 *   - fallback 在 fetch 失败时兜底
 *   - 不同 key 隔离
 */
import { describe, it, expect, vi } from 'vitest';
import { createCachedFetcher } from '../createCachedFetcher';

describe('createCachedFetcher', () => {
  it('命中缓存时不重复调用 fetch', async () => {
    const fetcher = vi.fn(async (n: number) => n * 2);
    const load = createCachedFetcher({
      key: n => `n:${n}`,
      fetch: fetcher,
      ttl: 1000,
    });

    expect(await load(5)).toBe(10);
    expect(await load(5)).toBe(10);
    expect(await load(5)).toBe(10);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('不同 key 之间互不影响', async () => {
    const fetcher = vi.fn(async (n: number) => n * 2);
    const load = createCachedFetcher({
      key: n => `n:${n}`,
      fetch: fetcher,
      ttl: 1000,
    });

    expect(await load(1)).toBe(2);
    expect(await load(2)).toBe(4);
    expect(await load(3)).toBe(6);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('并发同 key 请求合并为单次 fetch', async () => {
    let resolveFetch: (v: number) => void = (_v: number) => undefined;
    const fetcher = vi.fn(
      () =>
        new Promise<number>(r => {
          resolveFetch = r;
        })
    );
    const load = createCachedFetcher({
      key: () => 'same',
      fetch: fetcher,
      ttl: 1000,
    });

    const p1 = load(0);
    const p2 = load(0);
    const p3 = load(0);
    expect(fetcher).toHaveBeenCalledTimes(1);

    resolveFetch(42);
    expect(await p1).toBe(42);
    expect(await p2).toBe(42);
    expect(await p3).toBe(42);
  });

  it('TTL 过期后重新拉取', async () => {
    const fetcher = vi.fn(async () => Date.now());
    const load = createCachedFetcher({
      key: () => 'k',
      fetch: fetcher,
      ttl: 10,
    });

    const v1 = await load(0);
    await new Promise(r => setTimeout(r, 25));
    const v2 = await load(0);

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(v2).toBeGreaterThanOrEqual(v1);
  });

  it('SWR：过期立即返回旧值，后台异步刷新', async () => {
    let counter = 0;
    const fetcher = vi.fn(async () => ++counter);
    const load = createCachedFetcher({
      key: () => 'k',
      fetch: fetcher,
      ttl: 10,
      swr: true,
    });

    expect(await load(0)).toBe(1);
    await new Promise(r => setTimeout(r, 25));
    // 过期：立即返回旧值
    expect(await load(0)).toBe(1);
    // 等后台刷新完成
    await new Promise(r => setTimeout(r, 20));
    expect(await load(0)).toBe(2);
  });

  it('fallback 在 fetch 抛错时返回兜底值', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('boom');
    });
    const load = createCachedFetcher<number, string>({
      key: n => `n:${n}`,
      fetch: fetcher,
      fallback: () => 'fallback',
    });
    expect(await load(1)).toBe('fallback');
  });

  it('无 fallback 时 fetch 抛错向上冒泡', async () => {
    const load = createCachedFetcher({
      key: () => 'k',
      fetch: async () => {
        throw new Error('boom');
      },
    });
    await expect(load(0)).rejects.toThrow('boom');
  });
});
