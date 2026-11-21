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

  it('marks each consumer of a shared degraded result and refreshes once the source recovers', async () => {
    const onDegraded = vi.fn();
    let recovered = false;
    const fetcher = vi.fn(async (_arg: string, markDegraded?: () => void) => {
      if (!recovered) {
        markDegraded?.();
        return 'snapshot';
      }
      return 'current';
    });
    const load = createCachedFetcher({ key: locale => locale, fetch: fetcher, onDegraded });

    expect(await Promise.all([load('en'), load('en')])).toEqual(['snapshot', 'snapshot']);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(onDegraded).toHaveBeenCalledTimes(2);

    recovered = true;
    expect(await load('en')).toBe('current');
    expect(await load('en')).toBe('current');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(onDegraded).toHaveBeenCalledTimes(2);
  });

  it('detaches an invalidated in-flight load without disturbing other keys', async () => {
    const pending: Array<(value: string) => void> = [];
    let frenchLoads = 0;
    const load = createCachedFetcher({
      key: (locale: string) => locale,
      fetch: async locale => {
        if (locale === 'fr') return `bonjour ${++frenchLoads}`;
        return new Promise<string>(resolve => pending.push(resolve));
      },
    });

    expect(await load('fr')).toBe('bonjour 1');
    const beforePublication = load('en');
    load.invalidate(locale => locale === 'en');
    const afterPublication = load('en');

    pending[0]('old');
    expect(await beforePublication).toBe('old');
    const follower = load('en');
    expect(pending).toHaveLength(2);
    pending[1]('new');

    expect(await afterPublication).toBe('new');
    expect(await follower).toBe('new');
    expect(await load('en')).toBe('new');
    expect(await load('fr')).toBe('bonjour 1');
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
    const onDegraded = vi.fn();
    const load = createCachedFetcher({
      key: () => 'k',
      fetch: fetcher,
      ttl: 10,
      swr: true,
      onDegraded,
    });

    expect(await load(0)).toBe(1);
    await new Promise(r => setTimeout(r, 25));
    // 过期：立即返回旧值
    expect(await load(0)).toBe(1);
    expect(onDegraded).toHaveBeenCalledOnce();
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
