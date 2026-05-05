/**
 * normalizeEngineConfig —— ISREngine 启动前的配置归一化
 *
 * 职责：
 *   1) 兜底默认：缺 `renderMode` 时设 'isr'，缺 `routes` 时设 {}
 *   2) 兜底默认：缺 `cache` 时设 memory + isr.revalidate/3600
 *   3) 不破坏其他字段（server/seo/runtime 等透传）
 */
import { describe, it, expect } from 'vitest';
import { normalizeEngineConfig } from '../ISREngine';
import type { ISRConfig } from '../../types';

/** 构造最小合法用户配置。cache 可省略，由 engine 归一化。 */
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

  it('未传 cache → 默认 memory，并优先使用 isr.revalidate 作为 ttl', () => {
    const r = normalizeEngineConfig(base({ isr: { revalidate: 120 } }));
    expect(r.cache).toEqual({ strategy: 'memory', ttl: 120 });
  });

  it('未传 cache 且没有 isr.revalidate → 默认 3600 秒', () => {
    const r = normalizeEngineConfig(base());
    expect(r.cache).toEqual({ strategy: 'memory', ttl: 3600 });
  });
});

describe('normalizeEngineConfig —— 不破坏其他字段', () => {
  it('cache / server / seo / isr / ssg 字段原样透传', () => {
    const config: ISRConfig = {
      renderMode: 'isr',
      cache: { strategy: 'redis', ttl: 7200 },
      server: { port: 8080, host: '0.0.0.0' },
      seo: { enabled: true },
      isr: { revalidate: 600 },
      ssg: { routes: ['/'], concurrent: 5 },
    };
    const r = normalizeEngineConfig(config);
    expect(r.cache).toEqual({ strategy: 'redis', ttl: 7200 });
    expect(r.server).toEqual({ port: 8080, host: '0.0.0.0' });
    expect(r.seo).toEqual({ enabled: true });
    expect(r.isr).toEqual({ revalidate: 600 });
    expect(r.ssg).toEqual({ routes: ['/'], concurrent: 5 });
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
    expect(config.cache).toBeUndefined();
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
