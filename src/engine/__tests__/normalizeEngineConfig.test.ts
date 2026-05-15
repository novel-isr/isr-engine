/**
 * normalizeEngineConfig —— ISREngine 启动前的配置校验
 *
 * 职责：
 *   1) fail-fast：业务配置必须显式写出核心字段
 *   2) 拒绝旧 cache/isr/seo 顶层字段，避免隐藏兼容分支继续扩散
 *   3) 返回同一个公开 ISRConfig 结构；运行时内部默认由对应模块自己处理
 */
import { describe, expect, it } from 'vitest';
import { normalizeEngineConfig } from '../ISREngine';
import type { ISRConfig } from '../../types';

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends (...args: never[]) => unknown
    ? T[K]
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

const defaults: ISRConfig = {
  renderMode: 'isr',
  revalidate: 3600,
  routes: {},
  runtime: {
    site: undefined,
    services: { api: undefined, telemetry: undefined },
    redis: undefined,
    experiments: {},
    i18n: undefined,
    seo: undefined,

    telemetry: false,
  },
  server: {
    port: 3000,
    host: '127.0.0.1',
    strictPort: true,
    ops: {
      authToken: undefined,
      tokenHeader: 'x-isr-admin-token',
      health: { enabled: true, public: true },
      metrics: { enabled: false, public: false },
      inventory: { enabled: false, public: false },
    },
  },
  ssg: {
    routes: [],
    concurrent: 3,
    requestTimeoutMs: 30_000,
    maxRetries: 3,
    retryBaseDelayMs: 200,
    failBuildThreshold: 0.05,
  },
};

function base(extra: DeepPartial<ISRConfig> = {}): ISRConfig {
  return {
    ...defaults,
    ...extra,
    routes: (extra.routes as ISRConfig['routes'] | undefined) ?? defaults.routes,
    runtime: { ...defaults.runtime, ...extra.runtime } as ISRConfig['runtime'],
    server: {
      ...defaults.server,
      ...extra.server,
      ops: {
        ...defaults.server.ops,
        ...extra.server?.ops,
        health: {
          ...defaults.server.ops.health,
          ...extra.server?.ops?.health,
        },
        metrics: {
          ...defaults.server.ops.metrics,
          ...extra.server?.ops?.metrics,
        },
        inventory: {
          ...defaults.server.ops.inventory,
          ...extra.server?.ops?.inventory,
        },
      },
    },
    ssg: {
      ...defaults.ssg,
      ...extra.ssg,
      routes: (extra.ssg?.routes as ISRConfig['ssg']['routes'] | undefined) ?? defaults.ssg.routes,
    },
  };
}

describe('normalizeEngineConfig —— 显式产品配置', () => {
  it('未传 renderMode → fail fast', () => {
    expect(() =>
      normalizeEngineConfig(
        base({
          renderMode: undefined as unknown as ISRConfig['renderMode'],
        })
      )
    ).toThrow('renderMode');
  });

  it('未传 revalidate → fail fast', () => {
    expect(() =>
      normalizeEngineConfig(
        base({
          revalidate: undefined as unknown as number,
        })
      )
    ).toThrow('revalidate');
  });

  it('非法 revalidate → fail fast', () => {
    expect(() => normalizeEngineConfig(base({ revalidate: 0 }))).toThrow('revalidate');
  });

  it('缺 routes/runtime/server/ssg → fail fast', () => {
    const config = {
      renderMode: 'isr',
      revalidate: 3600,
    } as unknown as ISRConfig;

    expect(() => normalizeEngineConfig(config)).toThrow('routes');
  });

  it('runtime 子字段也必须显式写出，避免隐藏配置面', () => {
    const config = {
      ...base(),
      runtime: { site: undefined },
    } as unknown as ISRConfig;

    expect(() => normalizeEngineConfig(config)).toThrow('runtime.services');
  });

  it('runtime.redis 启用时必须写出完整 Redis 配置面', () => {
    const config = base({
      runtime: {
        redis: {
          url: 'redis://127.0.0.1:6379/0',
        } as unknown as ISRConfig['runtime']['redis'],
      },
    });

    expect(() => normalizeEngineConfig(config)).toThrow('runtime.redis.host');
  });

  it('合法空 routes 保留，不做隐藏补齐', () => {
    const r = normalizeEngineConfig(base({ routes: {} }));
    expect(r.routes).toEqual({});
  });

  it('RouteRuleObject 必须显式写出 ttl 和 staleWhileRevalidate', () => {
    const config = {
      ...base(),
      routes: {
        '/books/*': { mode: 'isr', ttl: 60 },
      },
    } as unknown as ISRConfig;

    expect(() => normalizeEngineConfig(config)).toThrow('routes./books/*.staleWhileRevalidate');
  });
});

describe('normalizeEngineConfig —— 不破坏其他字段', () => {
  it('server / revalidate / ssg 字段原样透传', () => {
    const config = base({
      server: {
        port: 8080,
        host: '0.0.0.0',
        strictPort: true,
      },
      revalidate: 600,
      ssg: {
        routes: ['/'],
        concurrent: 5,
      },
    });
    const r = normalizeEngineConfig(config);
    expect('cache' in r).toBe(false);
    expect(r.server.port).toBe(8080);
    expect(r.server.host).toBe('0.0.0.0');
    expect(r.revalidate).toBe(600);
    expect(r.ssg.routes).toEqual(['/']);
    expect(r.ssg.concurrent).toBe(5);
  });

  it('历史遗留 cache/isr/seo 字段直接拒绝', () => {
    const config = {
      ...base(),
      cache: { strategy: 'redis', ttl: 7200 },
      isr: { revalidate: 9999 },
      seo: { enabled: false },
    } as unknown as ISRConfig;

    expect(() => normalizeEngineConfig(config)).toThrow('cache/isr/seo');
  });

  it('返回新对象，不修改合法入参', () => {
    const config = base();

    const r = normalizeEngineConfig(config);
    expect(r).not.toBe(config);
    expect(r.renderMode).toBe('isr');
    expect(r.routes).toEqual({});
    expect(config.routes).toEqual({});
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
    expect(r.runtime.site).toBe('https://novel.example.com');
  });
});

describe('normalizeEngineConfig —— 组合场景', () => {
  it('renderMode + routes 直接透传', () => {
    const r = normalizeEngineConfig(
      base({
        renderMode: 'ssg',
        routes: { '/api/*': 'ssr' },
      })
    );
    expect(r.renderMode).toBe('ssg');
    expect(r.routes).toEqual({ '/api/*': 'ssr' });
  });
});
