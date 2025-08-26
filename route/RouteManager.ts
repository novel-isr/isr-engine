/**
 * Smart Route Manager
 * 智能路由管理 - 根据配置自动选择最优渲染策略
 */

export class RouteManager {
  private routes: Record<string, any>;
  private defaultStrategy: string;

  constructor(config: Record<string, any>) {
    this.routes = config.routes || {};
    this.defaultStrategy = 'hybrid';
  }

  /**
   * 获取路由的渲染策略
   */
  getStrategy(path: string) {
    // 精确匹配
    if (this.routes[path]) {
      return this.routes[path];
    }

    // 通配符匹配
    for (const [pattern, config] of Object.entries(this.routes)) {
      if (this.matchPattern(path, pattern)) {
        return config;
      }
    }

    // 默认策略
    return this.routes['*'] || { strategy: this.defaultStrategy };
  }

  /**
   * 匹配路径模式
   */
  matchPattern(path: string, pattern: string) {
    if (pattern === '*') return true;

    // 简单通配符匹配
    if (pattern.endsWith('*')) {
      const prefix = pattern.slice(0, -1);
      return path.startsWith(prefix);
    }

    // 动态路由匹配 (如 /book/:id)
    if (pattern.includes(':')) {
      const patternParts = pattern.split('/');
      const pathParts = path.split('/');

      if (patternParts.length !== pathParts.length) {
        return false;
      }

      return patternParts.every((part: string, index: number) => {
        return part.startsWith(':') || part === pathParts[index];
      });
    }

    return false;
  }

  /**
   * 获取所有静态路由（用于预渲染）
   */
  getStaticRoutes() {
    return Object.entries(this.routes)
      .filter(
        ([pattern, config]) =>
          config.strategy === 'ssg' &&
          !pattern.includes('*') &&
          !pattern.includes(':')
      )
      .map(([pattern]) => pattern);
  }

  /**
   * 获取 ISR 路由配置
   */
  getISRRoutes() {
    return Object.entries(this.routes)
      .filter(([pattern, config]: [string, any]) => config.strategy === 'isr')
      .reduce((acc: Record<string, any>, [pattern, config]: [string, any]) => {
        acc[pattern] = {
          revalidate: config.revalidate || 3600,
          priority: config.priority || 0.5,
        };
        return acc;
      }, {});
  }

  /**
   * 获取缓存配置
   */
  getCacheConfig(path: string) {
    const route = this.getStrategy(path);
    return {
      ttl: route.cache || 3600,
      key: this.generateCacheKey(path, route),
    };
  }

  /**
   * 生成缓存键
   */
  generateCacheKey(path: string, route: any) {
    const base = `route:${path}`;
    const strategy = route.strategy || 'default';
    return `${base}:${strategy}`;
  }

  /**
   * 判断路由是否应该被缓存
   */
  shouldCache(path: string) {
    const route = this.getStrategy(path);
    return route.cache !== false && route.strategy !== 'server';
  }

  /**
   * 获取路由优先级（用于 sitemap）
   */
  getPriority(path: string) {
    const route = this.getStrategy(path);
    return route.priority || 0.5;
  }

  /**
   * 获取更新频率（用于 sitemap）
   */
  getChangeFreq(path: string) {
    const route = this.getStrategy(path);

    switch (route.strategy) {
      case 'ssg':
        return 'monthly';
      case 'isr':
        return 'daily';
      case 'ssr':
        return 'hourly';
      default:
        return 'weekly';
    }
  }

  /**
   * 获取所有路由统计信息
   */
  getStats() {
    const strategies: Record<string, number> = {};
    const total = Object.keys(this.routes).length;

    Object.values(this.routes).forEach((route: any) => {
      const strategy = route.strategy || 'default';
      strategies[strategy] = (strategies[strategy] || 0) + 1;
    });

    return {
      total,
      strategies,
      static: this.getStaticRoutes().length,
      isr: Object.keys(this.getISRRoutes()).length,
    };
  }
}
