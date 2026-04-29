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

describe('RouteManager —— 构造与默认值', () => {
  it('空 config → globalMode=isr, overrides={}', () => {
    const rm = new RouteManager({});
    expect(rm.getRenderMode('/anything')).toBe('isr');
    expect(rm.hasOverride('/anything')).toBe(false);
    expect(rm.getStats().overrideCount).toBe(0);
  });

  it('显式 renderMode → 覆盖默认', () => {
    const rm = new RouteManager({ renderMode: 'ssr' });
    expect(rm.getRenderMode('/x')).toBe('ssr');
  });

  it('overrides 优先于 globalMode', () => {
    const rm = new RouteManager({
      renderMode: 'ssr',
      routes: { '/about': 'ssg' },
    });
    expect(rm.getRenderMode('/about')).toBe('ssg');
    expect(rm.getRenderMode('/other')).toBe('ssr');
  });
});

describe('RouteManager.getRenderMode —— 路径匹配', () => {
  it('精确匹配优先于通配', () => {
    const rm = new RouteManager({
      renderMode: 'isr',
      routes: {
        '/books/featured': 'ssg',
        '/books/*': 'ssr',
      },
    });
    expect(rm.getRenderMode('/books/featured')).toBe('ssg');
    expect(rm.getRenderMode('/books/123')).toBe('ssr');
  });

  it('动态参数 :id 匹配', () => {
    const rm = new RouteManager({
      renderMode: 'isr',
      routes: { '/users/:id': 'ssr' },
    });
    expect(rm.getRenderMode('/users/42')).toBe('ssr');
    expect(rm.getRenderMode('/users')).toBe('isr'); // 段数不等不匹配
  });

  it('未命中任何 override → 回 globalMode', () => {
    const rm = new RouteManager({
      renderMode: 'ssg',
      routes: { '/admin/*': 'ssr' },
    });
    expect(rm.getRenderMode('/contact')).toBe('ssg');
  });

  it('RouteRuleObject 形式（带 ttl/swr）也能拿到 mode', () => {
    const rm = new RouteManager({
      renderMode: 'ssr',
      routes: {
        '/cached/*': { mode: 'isr', ttl: 60, staleWhileRevalidate: 300 },
      },
    });
    expect(rm.getRenderMode('/cached/x')).toBe('isr');
  });
});

describe('RouteManager.hasOverride', () => {
  it('精确匹配 → true', () => {
    const rm = new RouteManager({ routes: { '/about': 'ssg' } });
    expect(rm.hasOverride('/about')).toBe(true);
    expect(rm.hasOverride('/contact')).toBe(false);
  });

  it('通配符匹配 → true', () => {
    const rm = new RouteManager({ routes: { '/api/*': 'ssr' } });
    expect(rm.hasOverride('/api/health')).toBe(true);
    expect(rm.hasOverride('/api/v1/users')).toBe(true);
    expect(rm.hasOverride('/static')).toBe(false);
  });

  it('无 overrides → 永远 false', () => {
    const rm = new RouteManager({});
    expect(rm.hasOverride('/anything')).toBe(false);
  });
});

describe('RouteManager.getSSGRoutes', () => {
  it('只返回 mode=ssg 且无通配符 / 动态参数 的路由（适合预生成）', () => {
    const rm = new RouteManager({
      routes: {
        '/about': 'ssg', // ✓
        '/contact': 'ssg', // ✓
        '/blog/*': 'ssg', // ✗（通配符 spider 也无法解析）
        '/users/:id': 'ssg', // ✗（动态参数）
        '/api/*': 'ssr',
        '/dashboard': 'isr',
      },
    });
    expect(rm.getSSGRoutes().sort()).toEqual(['/about', '/contact']);
  });

  it('无 ssg 路由 → []', () => {
    const rm = new RouteManager({
      routes: { '/api/*': 'ssr', '/x': 'isr' },
    });
    expect(rm.getSSGRoutes()).toEqual([]);
  });

  it('RouteRuleObject 形态的 SSG 也识别', () => {
    const rm = new RouteManager({
      routes: {
        '/static/page': { mode: 'ssg' },
      },
    });
    expect(rm.getSSGRoutes()).toEqual(['/static/page']);
  });
});

describe('RouteManager.getISRRoutes', () => {
  it('只返回 mode=isr，附 revalidate (TTL) + priority', () => {
    const rm = new RouteManager({
      routes: {
        '/blog/*': { mode: 'isr', ttl: 600 },
        '/products/:id': { mode: 'isr', ttl: 1800 },
        '/static': 'ssg',
        '/checkout': 'ssr',
      },
    });
    const isrRoutes = rm.getISRRoutes();
    expect(Object.keys(isrRoutes).sort()).toEqual(['/blog/*', '/products/:id']);
    expect(isrRoutes['/blog/*']).toEqual({ revalidate: 600, priority: 0.5 });
    expect(isrRoutes['/products/:id']).toEqual({ revalidate: 1800, priority: 0.5 });
  });

  it('字符串 shorthand "isr" → 默认 ttl=3600', () => {
    const rm = new RouteManager({
      routes: { '/blog': 'isr' },
    });
    expect(rm.getISRRoutes()['/blog']).toEqual({ revalidate: 3600, priority: 0.5 });
  });

  it('mode=isr 但 ttl 非 number → 默认 3600', () => {
    const rm = new RouteManager({
      routes: {
        '/x': { mode: 'isr' }, // 没传 ttl
      },
    });
    expect(rm.getISRRoutes()['/x'].revalidate).toBe(3600);
  });
});

describe('RouteManager.shouldCache', () => {
  it('isr / ssg → true', () => {
    const rm = new RouteManager({
      routes: { '/cached': 'isr', '/static': 'ssg' },
    });
    expect(rm.shouldCache('/cached')).toBe(true);
    expect(rm.shouldCache('/static')).toBe(true);
  });

  it('ssr → false', () => {
    const rm = new RouteManager({ routes: { '/login': 'ssr' } });
    expect(rm.shouldCache('/login')).toBe(false);
  });

  it('未命中 + globalMode=ssr → false', () => {
    const rm = new RouteManager({ renderMode: 'ssr' });
    expect(rm.shouldCache('/anywhere')).toBe(false);
  });
});

describe('RouteManager.getPriority —— sitemap.xml 用', () => {
  it('"/" 强制 priority=1.0（首页最高）', () => {
    const rm = new RouteManager({ renderMode: 'isr' });
    expect(rm.getPriority('/')).toBe(1.0);
  });

  it('SSG → 0.8（最稳定，可信赖）', () => {
    const rm = new RouteManager({ routes: { '/about': 'ssg' } });
    expect(rm.getPriority('/about')).toBe(0.8);
  });

  it('ISR → 0.6', () => {
    const rm = new RouteManager({ routes: { '/blog': 'isr' } });
    expect(rm.getPriority('/blog')).toBe(0.6);
  });

  it('SSR → 0.4（最低，频繁变化）', () => {
    const rm = new RouteManager({ routes: { '/realtime': 'ssr' } });
    expect(rm.getPriority('/realtime')).toBe(0.4);
  });
});

describe('RouteManager.getChangeFreq —— sitemap changefreq 字段', () => {
  it('SSG → monthly / ISR → daily / SSR → hourly', () => {
    const rm = new RouteManager({
      routes: {
        '/static': 'ssg',
        '/blog': 'isr',
        '/live': 'ssr',
      },
    });
    expect(rm.getChangeFreq('/static')).toBe('monthly');
    expect(rm.getChangeFreq('/blog')).toBe('daily');
    expect(rm.getChangeFreq('/live')).toBe('hourly');
  });
});

describe('RouteManager.getStats —— 监控用', () => {
  it('返回完整统计：globalMode + 各模式数量', () => {
    const rm = new RouteManager({
      renderMode: 'isr',
      routes: {
        '/about': 'ssg',
        '/contact': 'ssg',
        '/api/*': 'ssr',
        '/blog/*': 'isr',
      },
    });
    const stats = rm.getStats();
    expect(stats.globalMode).toBe('isr');
    expect(stats.overrideCount).toBe(4);
    expect(stats.modeDistribution).toEqual({ ssg: 2, ssr: 1, isr: 1 });
    expect(stats.ssgRoutes).toBe(2);
    expect(stats.isrRoutes).toBe(1);
  });

  it('空 overrides → modeDistribution={}', () => {
    const stats = new RouteManager({}).getStats();
    expect(stats.modeDistribution).toEqual({});
    expect(stats.overrideCount).toBe(0);
  });
});
