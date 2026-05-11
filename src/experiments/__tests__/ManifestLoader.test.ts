import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createManifestLoader,
  normalizeManifestExperiments,
  resolveManifestLoader,
} from '../ManifestLoader';

const manifest = (experiments: Record<string, unknown>, version = 'v1') => ({
  version,
  updatedAt: new Date().toISOString(),
  experiments,
});

describe('normalizeManifestExperiments', () => {
  it('status=running 保留 weights', () => {
    const out = normalizeManifestExperiments({
      hero: { variants: ['a', 'b'], weights: [60, 40], status: 'running' },
    });
    expect(out.hero.weights).toEqual([60, 40]);
  });

  it('status=paused 强制 [100,0,...]', () => {
    const out = normalizeManifestExperiments({
      hero: { variants: ['a', 'b'], weights: [60, 40], status: 'paused' },
    });
    expect(out.hero.weights).toEqual([100, 0]);
  });

  it('status=killed 强制 [100,0,...]', () => {
    const out = normalizeManifestExperiments({
      hero: { variants: ['a', 'b', 'c'], status: 'killed' },
    });
    expect(out.hero.weights).toEqual([100, 0, 0]);
  });

  it('status 缺失视作 running', () => {
    const out = normalizeManifestExperiments({
      hero: { variants: ['a', 'b'], weights: [50, 50] },
    });
    expect(out.hero.weights).toEqual([50, 50]);
  });
});

describe('ManifestLoader', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('init 同步拉一次 + getCurrent 返回最新', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(manifest({ hero: { variants: ['a', 'b'], weights: [50, 50] } })), {
          status: 200,
          headers: { etag: 'v1' },
        })
      );
    const loader = createManifestLoader({ endpoint: 'http://x', fetcher });
    await loader.init();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(loader.getCurrent().hero.weights).toEqual([50, 50]);
    loader.destroy();
  });

  it('304 沿用上次快照', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(manifest({ hero: { variants: ['a', 'b'], weights: [10, 90] } })), {
          status: 200,
          headers: { etag: 'v1' },
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    const loader = createManifestLoader({
      endpoint: 'http://x',
      refreshIntervalMs: 100,
      fetcher,
    });
    await loader.init();
    expect(loader.getCurrent().hero.weights).toEqual([10, 90]);
    await vi.advanceTimersByTimeAsync(150);
    // 第二次拿到 304 → 沿用 v1
    expect(loader.getCurrent().hero.weights).toEqual([10, 90]);
    // 验证带了 If-None-Match
    const secondCall = fetcher.mock.calls[1];
    expect(secondCall[1].headers['if-none-match']).toBe('v1');
    loader.destroy();
  });

  it('拉取失败 fallbackOnError=cache 保留上次快照', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(manifest({ hero: { variants: ['a', 'b'], weights: [10, 90] } })), {
          status: 200,
        })
      )
      .mockRejectedValueOnce(new Error('net'));
    const loader = createManifestLoader({
      endpoint: 'http://x',
      refreshIntervalMs: 100,
      fallbackOnError: 'cache',
      fetcher,
    });
    await loader.init();
    await vi.advanceTimersByTimeAsync(150);
    expect(loader.getCurrent().hero.weights).toEqual([10, 90]);
    loader.destroy();
  });

  it('fallbackOnError=static 回静态配置', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('net'));
    const loader = createManifestLoader({
      endpoint: 'http://x',
      fallbackOnError: 'static',
      staticExperiments: { hero: { variants: ['a', 'b'], weights: [70, 30] } },
      fetcher,
    });
    await loader.init();
    expect(loader.getCurrent().hero.weights).toEqual([70, 30]);
    loader.destroy();
  });

  it('fallbackOnError=empty 关闭所有实验', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('net'));
    const loader = createManifestLoader({
      endpoint: 'http://x',
      fallbackOnError: 'empty',
      staticExperiments: { hero: { variants: ['a', 'b'], weights: undefined } },
      fetcher,
    });
    await loader.init();
    expect(Object.keys(loader.getCurrent())).toHaveLength(0);
    loader.destroy();
  });

  it('authHeader 注入请求头', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(manifest({})), { status: 200 })
      );
    const loader = createManifestLoader({
      endpoint: 'http://x',
      authHeader: { name: 'authorization', value: 'Bearer xyz' },
      fetcher,
    });
    await loader.init();
    expect(fetcher.mock.calls[0][1].headers.authorization).toBe('Bearer xyz');
    loader.destroy();
  });
});

describe('resolveManifestLoader', () => {
  it('config 缺 endpoint → null', () => {
    expect(resolveManifestLoader(undefined, {}, 'http://x')).toBeNull();
  });

  it('相对路径无 baseOrigin → null', () => {
    expect(
      resolveManifestLoader(
        { endpoint: '/api', refreshIntervalMs: undefined, fallbackOnError: undefined, authHeader: undefined },
        {},
        undefined
      )
    ).toBeNull();
  });

  it('相对路径 + baseOrigin → 创建实例', () => {
    const loader = resolveManifestLoader(
      { endpoint: '/api/exp', refreshIntervalMs: undefined, fallbackOnError: undefined, authHeader: undefined },
      {},
      'http://localhost:8080'
    );
    expect(loader).not.toBeNull();
    loader?.destroy();
  });
});
