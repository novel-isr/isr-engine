/**
 * normalizeEngineConfig —— ISREngine 启动前的配置归一化
 *
 * 职责：
 *   1) 兼容别名：`mode` → `renderMode`, `routes` → `routeOverrides`
 *   2) 兜底默认：缺 `renderMode` 时设 'isr'，缺 `routeOverrides` 时设 {}
 *   3) 不破坏其他字段（cache/server/seo 等透传）
 *
 * 这是 engine 启动链路上唯一的"配置结构清洗"点。旧配置通过别名仍能跑起来，
 * 升级 v2 后用户不用改 ssr.config.ts。
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

describe('normalizeEngineConfig —— 别名兼容', () => {
  it('`mode` → `renderMode`（用户旧字段仍然生效）', () => {
    const config = base({
      renderMode: undefined as unknown as ISRConfig['renderMode'],
      mode: 'ssr',
    });
    const r = normalizeEngineConfig(config);
    expect(r.renderMode).toBe('ssr');
  });

  it('`renderMode` 已存在 → 不被 `mode` 覆盖（显式 > 别名）', () => {
    const r = normalizeEngineConfig(base({ renderMode: 'isr', mode: 'ssr' }));
    expect(r.renderMode).toBe('isr');
  });

  it('`routes` → `routeOverrides`（旧字段生效）', () => {
    const r = normalizeEngineConfig(
      base({
        routeOverrides: undefined,
        routes: { '/books/*': 'isr', '/about': 'ssg' },
      })
    );
    expect(r.routeOverrides).toEqual({ '/books/*': 'isr', '/about': 'ssg' });
  });

  it('`routeOverrides` 已存在 → 不被 `routes` 覆盖', () => {
    const r = normalizeEngineConfig(
      base({
        routeOverrides: { '/admin/*': 'ssr' },
        routes: { '/books/*': 'isr' },
      })
    );
    expect(r.routeOverrides).toEqual({ '/admin/*': 'ssr' });
  });
});

describe('normalizeEngineConfig —— 兜底默认值', () => {
  it('未传 renderMode 且无 mode 别名 → 默认 "isr"', () => {
    const r = normalizeEngineConfig({
      renderMode: undefined as unknown as ISRConfig['renderMode'],
      cache: { strategy: 'memory', ttl: 3600 },
    });
    expect(r.renderMode).toBe('isr');
  });

  it('未传 routeOverrides 且无 routes → 默认 {}', () => {
    const r = normalizeEngineConfig(base());
    expect(r.routeOverrides).toEqual({});
  });

  it('空对象 overrides 保留（不是 undefined 才兜底）', () => {
    const r = normalizeEngineConfig(base({ routeOverrides: {} }));
    expect(r.routeOverrides).toEqual({});
  });
});

describe('normalizeEngineConfig —— 不破坏其他字段', () => {
  it('cache / server / seo / isr / ssg 字段原样透传', () => {
    const config: ISRConfig = {
      renderMode: 'isr',
      cache: { strategy: 'redis', ttl: 7200 },
      server: { port: 8080, host: '0.0.0.0' },
      seo: { enabled: true, baseUrl: 'https://example.com' },
      isr: { revalidate: 600, backgroundRevalidation: true },
      ssg: { routes: ['/'], concurrent: 5 },
    };
    const r = normalizeEngineConfig(config);
    expect(r.cache).toEqual({ strategy: 'redis', ttl: 7200 });
    expect(r.server).toEqual({ port: 8080, host: '0.0.0.0' });
    expect(r.seo).toEqual({ enabled: true, baseUrl: 'https://example.com' });
    expect(r.isr).toEqual({ revalidate: 600, backgroundRevalidation: true });
    expect(r.ssg).toEqual({ routes: ['/'], concurrent: 5 });
  });

  it('返回新对象，不修改入参（引用不等 + 入参关键字段无变异）', () => {
    // 构造：入参无 renderMode、只有 mode 别名 + routes 别名
    const config = {
      mode: 'ssr' as const,
      routes: { '/a': 'isr' as const },
      cache: { strategy: 'memory' as const, ttl: 3600 },
    } as unknown as ISRConfig;

    const r = normalizeEngineConfig(config);
    expect(r).not.toBe(config);
    // 归一化结果有 renderMode / routeOverrides
    expect(r.renderMode).toBe('ssr');
    expect(r.routeOverrides).toEqual({ '/a': 'isr' });
    // 但原入参没有被写入这两个字段（兼容 ssr.config.ts 被多次 load 不变异）
    expect((config as ISRConfig).renderMode).toBeUndefined();
    expect((config as ISRConfig).routeOverrides).toBeUndefined();
  });
});

describe('normalizeEngineConfig —— 组合场景', () => {
  it('同时有 mode + routes 别名 → 两者都被识别', () => {
    const r = normalizeEngineConfig({
      renderMode: undefined as unknown as ISRConfig['renderMode'],
      mode: 'ssg',
      routes: { '/api/*': 'ssr' },
      cache: { strategy: 'memory', ttl: 3600 },
    });
    expect(r.renderMode).toBe('ssg');
    expect(r.routeOverrides).toEqual({ '/api/*': 'ssr' });
  });
});
