/**
 * normalizeEngineConfig —— ISREngine 启动前的配置归一化
 *
 * 职责：
 *   1) 兜底默认：缺 `renderMode` 时设 'isr'，缺 `routes` 时设 {}
 *   2) 内部 cache 默认由 engine 归一化，TTL 来自 isr.revalidate/3600
 *   3) 不破坏其他字段（server/seo/runtime 等透传）
 */
import { describe, it, expect } from 'vitest';
import { normalizeEngineConfig } from '../ISREngine';
import type { ISRConfig } from '../../types';

/** 构造最小合法用户配置。cache 不属于业务配置，由 engine 内部归一化。 */
function base(extra: Partial<ISRConfig> = {}): ISRConfig {
  return {
    renderMode: 'isr',
    ...extra,
  };
}

describe('normalizeEngineConfig —— 兜底默认值', () => {
  it('未传 renderMode → 默认 "isr"', () => {
    const r = normalizeEngineConfig({
      renderMode: undefined as unknown as ISRConfig['renderMode'],
    });
    expect(r.renderMode).toBe('isr');
  });

  it('未传 routes → 默认 {}', () => {
    const r = normalizeEngineConfig(base());
    expect(r.routes).toEqual({});
  });

  it('空对象 routes 保留（不是 undefined 才兜底）', () => {
    const r = normalizeEngineConfig(base({ routes: {} }));
    expect(r.routes).toEqual({});
  });

  it('内部 cache 默认 memory，并优先使用 isr.revalidate 作为 ttl', () => {
    const r = normalizeEngineConfig(base({ isr: { revalidate: 120 } }));
    expect(r.cache).toEqual({ strategy: 'memory', ttl: 120 });
  });

  it('没有 isr.revalidate → 内部 cache ttl 默认 3600 秒', () => {
    const r = normalizeEngineConfig(base());
    expect(r.cache).toEqual({ strategy: 'memory', ttl: 3600 });
  });
});

describe('normalizeEngineConfig —— 不破坏其他字段', () => {
  it('server / seo / isr / ssg 字段原样透传，cache 由 engine 归一化', () => {
    const config: ISRConfig = {
      renderMode: 'isr',
      server: { port: 8080, host: '0.0.0.0' },
      seo: { enabled: true },
      isr: { revalidate: 600 },
      ssg: { routes: ['/'], concurrent: 5 },
    };
    const r = normalizeEngineConfig(config);
    expect(r.cache).toEqual({ strategy: 'memory', ttl: 600 });
    expect(r.server).toEqual({ port: 8080, host: '0.0.0.0' });
    expect(r.seo).toEqual({ enabled: true });
    expect(r.isr).toEqual({ revalidate: 600 });
    expect(r.ssg).toEqual({ routes: ['/'], concurrent: 5 });
  });

  it('忽略历史遗留 cache 字段，TTL 只从 isr.revalidate 读取', () => {
    const config = {
      renderMode: 'isr',
      cache: { strategy: 'redis', ttl: 7200 },
      isr: { revalidate: 300 },
    } as unknown as ISRConfig;

    expect(normalizeEngineConfig(config).cache).toEqual({
      strategy: 'memory',
      ttl: 300,
    });
  });

  it('返回新对象，不修改入参（引用不等 + 入参关键字段无变异）', () => {
    const config = {
      renderMode: undefined as unknown as ISRConfig['renderMode'],
    } as ISRConfig;

    const r = normalizeEngineConfig(config);
    expect(r).not.toBe(config);
    expect(r.renderMode).toBe('isr');
    expect(r.routes).toEqual({});
    expect(config.renderMode).toBeUndefined();
    expect(config.routes).toBeUndefined();
    expect('cache' in config).toBe(false);
  });
});

describe('normalizeEngineConfig —— runtime 平台配置', () => {
  it('runtime.site 保留在 runtime，不再复制到顶层 seo', () => {
    const r = normalizeEngineConfig(
      base({
        runtime: { site: 'https://novel.example.com' },
        seo: { enabled: true },
      })
    );
    expect(r.seo).toEqual({ enabled: true });
    expect(r.runtime?.site).toBe('https://novel.example.com');
  });
});

describe('normalizeEngineConfig —— 组合场景', () => {
  it('renderMode + routes 直接透传', () => {
    const r = normalizeEngineConfig({
      renderMode: 'ssg',
      routes: { '/api/*': 'ssr' },
    });
    expect(r.renderMode).toBe('ssg');
    expect(r.routes).toEqual({ '/api/*': 'ssr' });
  });
});
