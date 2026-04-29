/**
 * normalizeEngineConfig —— ISREngine 启动前的配置归一化
 *
 * 职责：
 *   1) 兜底默认：缺 `renderMode` 时设 'isr'，缺 `routes` 时设 {}
 *   2) runtime.site 自动补齐 seo.baseUrl（seo.baseUrl 显式配置优先）
 *   3) 不破坏其他字段（cache/server/seo 等透传）
 */
import { describe, it, expect } from 'vitest';
import { normalizeEngineConfig } from '../ISREngine';
import type { ISRConfig } from '../../types';

/** 构造最小合法 ISRConfig —— cache 是 required 字段，所以得传 */
function base(extra: Partial<ISRConfig> = {}): ISRConfig {
  return {
    renderMode: 'isr',
    cache: { strategy: 'memory', ttl: 3600 },
    ...extra,
  };
}

describe('normalizeEngineConfig —— 兜底默认值', () => {
  it('未传 renderMode → 默认 "isr"', () => {
    const r = normalizeEngineConfig({
      renderMode: undefined as unknown as ISRConfig['renderMode'],
      cache: { strategy: 'memory', ttl: 3600 },
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
});

describe('normalizeEngineConfig —— 不破坏其他字段', () => {
  it('cache / server / seo / isr / ssg 字段原样透传', () => {
    const config: ISRConfig = {
      renderMode: 'isr',
      cache: { strategy: 'redis', ttl: 7200 },
      server: { port: 8080, host: '0.0.0.0' },
      seo: { enabled: true, baseUrl: 'https://example.com' },
      isr: { revalidate: 600 },
      ssg: { routes: ['/'], concurrent: 5 },
    };
    const r = normalizeEngineConfig(config);
    expect(r.cache).toEqual({ strategy: 'redis', ttl: 7200 });
    expect(r.server).toEqual({ port: 8080, host: '0.0.0.0' });
    expect(r.seo).toEqual({ enabled: true, baseUrl: 'https://example.com' });
    expect(r.isr).toEqual({ revalidate: 600 });
    expect(r.ssg).toEqual({ routes: ['/'], concurrent: 5 });
  });

  it('返回新对象，不修改入参（引用不等 + 入参关键字段无变异）', () => {
    const config = {
      renderMode: undefined as unknown as ISRConfig['renderMode'],
      cache: { strategy: 'memory' as const, ttl: 3600 },
    } as ISRConfig;

    const r = normalizeEngineConfig(config);
    expect(r).not.toBe(config);
    expect(r.renderMode).toBe('isr');
    expect(r.routes).toEqual({});
    expect(config.renderMode).toBeUndefined();
    expect(config.routes).toBeUndefined();
  });
});

describe('normalizeEngineConfig —— runtime 平台配置', () => {
  it('runtime.site 自动作为 seo.baseUrl', () => {
    const r = normalizeEngineConfig(
      base({
        runtime: { site: 'https://novel.example.com' },
        seo: { enabled: true },
      })
    );
    expect(r.seo?.baseUrl).toBe('https://novel.example.com');
    expect(r.runtime?.site).toBe('https://novel.example.com');
  });

  it('显式 seo.baseUrl 优先于 runtime.site', () => {
    const r = normalizeEngineConfig(
      base({
        runtime: { site: 'https://runtime.example.com' },
        seo: { enabled: true, baseUrl: 'https://seo.example.com' },
      })
    );
    expect(r.seo?.baseUrl).toBe('https://seo.example.com');
  });
});

describe('normalizeEngineConfig —— 组合场景', () => {
  it('renderMode + routes 直接透传', () => {
    const r = normalizeEngineConfig({
      renderMode: 'ssg',
      routes: { '/api/*': 'ssr' },
      cache: { strategy: 'memory', ttl: 3600 },
    });
    expect(r.renderMode).toBe('ssg');
    expect(r.routes).toEqual({ '/api/*': 'ssr' });
  });
});
