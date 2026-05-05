/**
 * normalizeEngineConfig —— ISREngine 启动前的配置归一化
 *
 * 职责：
 *   1) fail-fast：renderMode/revalidate 必须显式声明
 *   2) 内部 cache 默认由 engine 归一化，TTL 来自 revalidate
 *   3) 不破坏其他字段（server/runtime/ssg 等透传）
 */
import { describe, it, expect } from 'vitest';
import { normalizeEngineConfig } from '../ISREngine';
import type { ISRConfig } from '../../types';

/** 构造最小合法用户配置。cache 不属于业务配置，由 engine 内部归一化。 */
function base(extra: Partial<ISRConfig> = {}): ISRConfig {
  return {
    renderMode: 'isr',
    revalidate: 3600,
    ...extra,
  };
}

describe('normalizeEngineConfig —— 显式产品配置', () => {
  it('未传 renderMode → fail fast', () => {
    expect(() =>
      normalizeEngineConfig({
        renderMode: undefined as unknown as ISRConfig['renderMode'],
        revalidate: 3600,
      })
    ).toThrow('renderMode');
  });

  it('未传 revalidate → fail fast', () => {
    expect(() =>
      normalizeEngineConfig({
        renderMode: 'isr',
        revalidate: undefined as unknown as number,
      })
    ).toThrow('revalidate');
  });

  it('非法 revalidate → fail fast', () => {
    expect(() =>
      normalizeEngineConfig({
        renderMode: 'isr',
        revalidate: 0,
      })
    ).toThrow('revalidate');
  });

  it('返回新对象，不修改入参（引用不等 + 入参关键字段无变异）', () => {
    const config = {
      renderMode: undefined as unknown as ISRConfig['renderMode'],
      revalidate: 3600,
    } as ISRConfig;

    expect(() => normalizeEngineConfig(config)).toThrow('renderMode');
    expect(config.renderMode).toBeUndefined();
    expect(config.routes).toBeUndefined();
    expect('cache' in config).toBe(false);
  });

  it('未传 routes → 默认 {}', () => {
    const r = normalizeEngineConfig(base());
    expect(r.routes).toEqual({});
  });

  it('空对象 routes 保留（不是 undefined 才兜底）', () => {
    const r = normalizeEngineConfig(base({ routes: {} }));
    expect(r.routes).toEqual({});
  });

  it('内部 cache 默认 memory，并优先使用 revalidate 作为 ttl', () => {
    const r = normalizeEngineConfig(base({ revalidate: 120 }));
    expect(r.cache).toEqual({ strategy: 'memory', ttl: 120 });
  });
});

describe('normalizeEngineConfig —— 不破坏其他字段', () => {
  it('server / revalidate / ssg 字段原样透传，cache 由 engine 归一化', () => {
    const config: ISRConfig = {
      renderMode: 'isr',
      server: { port: 8080, host: '0.0.0.0' },
      revalidate: 600,
      ssg: { routes: ['/'], concurrent: 5 },
    };
    const r = normalizeEngineConfig(config);
    expect(r.cache).toEqual({ strategy: 'memory', ttl: 600 });
    expect(r.server).toEqual({ port: 8080, host: '0.0.0.0' });
    expect(r.revalidate).toBe(600);
    expect(r.ssg).toEqual({ routes: ['/'], concurrent: 5 });
  });

  it('忽略历史遗留 cache/isr/seo 字段，TTL 只从顶层 revalidate 读取', () => {
    const config = {
      renderMode: 'isr',
      cache: { strategy: 'redis', ttl: 7200 },
      isr: { revalidate: 9999 },
      seo: { enabled: false },
      revalidate: 300,
    } as unknown as ISRConfig;

    const normalized = normalizeEngineConfig(config);
    expect(normalized.cache).toEqual({
      strategy: 'memory',
      ttl: 300,
    });
    expect('isr' in normalized).toBe(false);
    expect('seo' in normalized).toBe(false);
  });

  it('返回新对象，不修改合法入参（引用不等 + 入参关键字段无变异）', () => {
    const config = base();

    const r = normalizeEngineConfig(config);
    expect(r).not.toBe(config);
    expect(r.renderMode).toBe('isr');
    expect(r.routes).toEqual({});
    expect(config.routes).toBeUndefined();
    expect('cache' in config).toBe(false);
  });
});

describe('normalizeEngineConfig —— runtime 平台配置', () => {
  it('runtime.site 保留在 runtime，不再需要顶层 seo', () => {
    const r = normalizeEngineConfig(
      base({
        runtime: { site: 'https://novel.example.com' },
      })
    );
    expect('seo' in r).toBe(false);
    expect(r.runtime?.site).toBe('https://novel.example.com');
  });
});

describe('normalizeEngineConfig —— 组合场景', () => {
  it('renderMode + routes 直接透传', () => {
    const r = normalizeEngineConfig({
      renderMode: 'ssg',
      revalidate: 3600,
      routes: { '/api/*': 'ssr' },
    });
    expect(r.renderMode).toBe('ssg');
    expect(r.routes).toEqual({ '/api/*': 'ssr' });
  });
});
