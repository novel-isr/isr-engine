/**
 * RouteManager —— 路由级渲染策略 + sitemap 元数据（priority / changefreq）
 *
 * 这是 SEO 引擎与 ISR 中间件共享的路由分类入口：
 *   - 决定每条路由走 isr / ssg / ssr
 *   - sitemap.xml 的 priority + changefreq 由这里给定
 *   - getSSGRoutes() 列表是 spider 预生成的输入
 *
 * 100% 单元测试 —— 纯函数无副作用。
 */
import { describe, it, expect } from 'vitest';
import { RouteManager } from '../RouteManager';
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
    rateLimit: false,
    traceDebug: undefined,
    experiments: {},
    i18n: undefined,
    seo: undefined,
    theme: undefined,
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

function cfg(extra: DeepPartial<ISRConfig> = {}): ISRConfig {
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
      },
    },
    ssg: {
      ...defaults.ssg,
      ...extra.ssg,
      routes: (extra.ssg?.routes as ISRConfig['ssg']['routes'] | undefined) ?? defaults.ssg.routes,
    },
  };
}

describe('RouteManager —— 构造与显式配置', () => {
  it('无路由覆盖 → 使用显式 globalMode，overrides={}', () => {
    const rm = new RouteManager(cfg());
    expect(rm.getRenderMode('/anything')).toBe('isr');
    expect(rm.hasOverride('/anything')).toBe(false);
    expect(rm.getSSGRoutes()).toEqual([]);
    expect(rm.getISRRoutes()).toEqual({});
  });

  it('显式 renderMode → 覆盖默认', () => {
    const rm = new RouteManager(cfg({ renderMode: 'ssr' }));
    expect(rm.getRenderMode('/x')).toBe('ssr');
  });

  it('overrides 优先于 globalMode', () => {
    const rm = new RouteManager(
      cfg({
        renderMode: 'ssr',
        routes: { '/about': 'ssg' },
      })
    );
    expect(rm.getRenderMode('/about')).toBe('ssg');
    expect(rm.getRenderMode('/other')).toBe('ssr');
  });
});

describe('RouteManager.getRenderMode —— 路径匹配', () => {
  it('精确匹配优先于通配', () => {
    const rm = new RouteManager(
      cfg({
        renderMode: 'isr',
        routes: {
          '/books/featured': 'ssg',
          '/books/*': 'ssr',
        },
      })
    );
    expect(rm.getRenderMode('/books/featured')).toBe('ssg');
    expect(rm.getRenderMode('/books/123')).toBe('ssr');
  });

  it('动态参数 :id 匹配', () => {
    const rm = new RouteManager(
      cfg({
        renderMode: 'isr',
        routes: { '/users/:id': 'ssr' },
      })
    );
    expect(rm.getRenderMode('/users/42')).toBe('ssr');
    expect(rm.getRenderMode('/users')).toBe('isr'); // 段数不等不匹配
  });

  it('未命中任何 override → 回 globalMode', () => {
    const rm = new RouteManager(
      cfg({
        renderMode: 'ssg',
        routes: { '/admin/*': 'ssr' },
      })
    );
    expect(rm.getRenderMode('/contact')).toBe('ssg');
  });

  it('RouteRuleObject 形式（带 ttl/swr）也能拿到 mode', () => {
    const rm = new RouteManager(
      cfg({
        renderMode: 'ssr',
        routes: {
          '/cached/*': { mode: 'isr', ttl: 60, staleWhileRevalidate: 300 },
        },
      })
    );
    expect(rm.getRenderMode('/cached/x')).toBe('isr');
  });
});

describe('RouteManager.hasOverride', () => {
  it('精确匹配 → true', () => {
    const rm = new RouteManager(cfg({ routes: { '/about': 'ssg' } }));
    expect(rm.hasOverride('/about')).toBe(true);
    expect(rm.hasOverride('/contact')).toBe(false);
  });

  it('通配符匹配 → true', () => {
    const rm = new RouteManager(cfg({ routes: { '/api/*': 'ssr' } }));
    expect(rm.hasOverride('/api/health')).toBe(true);
    expect(rm.hasOverride('/api/v1/users')).toBe(true);
    expect(rm.hasOverride('/static')).toBe(false);
  });

  it('无 overrides → 永远 false', () => {
    const rm = new RouteManager(cfg());
    expect(rm.hasOverride('/anything')).toBe(false);
  });
});

describe('RouteManager.getSSGRoutes', () => {
  it('只返回 mode=ssg 且无通配符 / 动态参数 的路由（适合预生成）', () => {
    const rm = new RouteManager(
      cfg({
        routes: {
          '/about': 'ssg', // ✓
          '/contact': 'ssg', // ✓
          '/blog/*': 'ssg', // ✗（通配符 spider 也无法解析）
          '/users/:id': 'ssg', // ✗（动态参数）
          '/api/*': 'ssr',
          '/dashboard': 'isr',
        },
      })
    );
    expect(rm.getSSGRoutes().sort()).toEqual(['/about', '/contact']);
  });

  it('无 ssg 路由 → []', () => {
    const rm = new RouteManager(
      cfg({
        routes: { '/api/*': 'ssr', '/x': 'isr' },
      })
    );
    expect(rm.getSSGRoutes()).toEqual([]);
  });

  it('RouteRuleObject 形态的 SSG 也识别', () => {
    const rm = new RouteManager(
      cfg({
        routes: {
          '/static/page': {
            mode: 'ssg',
            ttl: undefined,
            staleWhileRevalidate: undefined,
          },
        },
      })
    );
    expect(rm.getSSGRoutes()).toEqual(['/static/page']);
  });
});

describe('RouteManager.getISRRoutes', () => {
  it('只返回 mode=isr，附 revalidate (TTL) + priority', () => {
    const rm = new RouteManager(
      cfg({
        routes: {
          '/blog/*': {
            mode: 'isr',
            ttl: 600,
            staleWhileRevalidate: undefined,
          },
          '/products/:id': {
            mode: 'isr',
            ttl: 1800,
            staleWhileRevalidate: undefined,
          },
          '/static': 'ssg',
          '/checkout': 'ssr',
        },
      })
    );
    const isrRoutes = rm.getISRRoutes();
    expect(Object.keys(isrRoutes).sort()).toEqual(['/blog/*', '/products/:id']);
    expect(isrRoutes['/blog/*']).toEqual({ revalidate: 600, priority: 0.5 });
    expect(isrRoutes['/products/:id']).toEqual({ revalidate: 1800, priority: 0.5 });
  });

  it('字符串 shorthand "isr" → 使用显式顶层 revalidate', () => {
    const rm = new RouteManager(
      cfg({
        routes: { '/blog': 'isr' },
      })
    );
    expect(rm.getISRRoutes()['/blog']).toEqual({ revalidate: 3600, priority: 0.5 });
  });

  it('字符串 shorthand "isr" → 使用顶层 revalidate', () => {
    const rm = new RouteManager(
      cfg({
        revalidate: 120,
        routes: { '/blog': 'isr' },
      })
    );
    expect(rm.getISRRoutes()['/blog']).toEqual({ revalidate: 120, priority: 0.5 });
  });

  it('mode=isr 且显式 ttl=undefined → 使用顶层 revalidate', () => {
    const rm = new RouteManager(
      cfg({
        routes: {
          '/x': {
            mode: 'isr',
            ttl: undefined,
            staleWhileRevalidate: undefined,
          },
        },
      })
    );
    expect(rm.getISRRoutes()['/x'].revalidate).toBe(3600);
  });
});

describe('RouteManager.shouldCache', () => {
  it('isr / ssg → true', () => {
    const rm = new RouteManager(
      cfg({
        routes: { '/cached': 'isr', '/static': 'ssg' },
      })
    );
    expect(rm.shouldCache('/cached')).toBe(true);
    expect(rm.shouldCache('/static')).toBe(true);
  });

  it('ssr → false', () => {
    const rm = new RouteManager(cfg({ routes: { '/login': 'ssr' } }));
    expect(rm.shouldCache('/login')).toBe(false);
  });

  it('未命中 + globalMode=ssr → false', () => {
    const rm = new RouteManager(cfg({ renderMode: 'ssr' }));
    expect(rm.shouldCache('/anywhere')).toBe(false);
  });
});

describe('RouteManager.getPriority —— sitemap.xml 用', () => {
  it('"/" 强制 priority=1.0（首页最高）', () => {
    const rm = new RouteManager(cfg({ renderMode: 'isr' }));
    expect(rm.getPriority('/')).toBe(1.0);
  });

  it('SSG → 0.8（最稳定，可信赖）', () => {
    const rm = new RouteManager(cfg({ routes: { '/about': 'ssg' } }));
    expect(rm.getPriority('/about')).toBe(0.8);
  });

  it('ISR → 0.6', () => {
    const rm = new RouteManager(cfg({ routes: { '/blog': 'isr' } }));
    expect(rm.getPriority('/blog')).toBe(0.6);
  });

  it('SSR → 0.4（最低，频繁变化）', () => {
    const rm = new RouteManager(cfg({ routes: { '/realtime': 'ssr' } }));
    expect(rm.getPriority('/realtime')).toBe(0.4);
  });
});

describe('RouteManager.getChangeFreq —— sitemap changefreq 字段', () => {
  it('SSG → monthly / ISR → daily / SSR → hourly', () => {
    const rm = new RouteManager(
      cfg({
        routes: {
          '/static': 'ssg',
          '/blog': 'isr',
          '/live': 'ssr',
        },
      })
    );
    expect(rm.getChangeFreq('/static')).toBe('monthly');
    expect(rm.getChangeFreq('/blog')).toBe('daily');
    expect(rm.getChangeFreq('/live')).toBe('hourly');
  });
});
