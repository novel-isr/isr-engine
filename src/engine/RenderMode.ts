import {
  FallbackChain,
  type RenderModeType,
  type InternalStrategyType,
  type RouteRule,
} from '../types';

/**
 * 渲染模式工具函数 —— 根据全局模式和路由覆盖配置，返回渲染模式 / 降级链
 *
 * 支持的 overrides 形态（每条值均可）：
 *   - 'isr' | 'ssg' | 'ssr'                   字符串 shorthand
 *   - { mode: 'isr', ttl: 60, staleWhileRevalidate: 300 }  完整对象
 */

/** 将 RouteRule 统一抽取出 mode 字段 */
function ruleToMode(rule: RouteRule): RenderModeType {
  return typeof rule === 'string' ? rule : rule.mode;
}

/**
 * 获取指定渲染模式的降级链
 */
export function getFallbackChain(mode: RenderModeType): InternalStrategyType[] {
  return FallbackChain[mode] || FallbackChain.isr;
}

/**
 * 根据路由和覆盖配置，获取实际的渲染模式
 */
export function resolveRenderMode(
  url: string,
  globalMode: RenderModeType,
  overrides?: Record<string, RouteRule>
): RenderModeType {
  if (!overrides) return globalMode;

  // 1. 精确匹配
  if (overrides[url] !== undefined) {
    return ruleToMode(overrides[url]);
  }

  // 2. 通配符/动态路由匹配
  for (const [pattern, rule] of Object.entries(overrides)) {
    if (matchRoutePattern(url, pattern)) {
      return ruleToMode(rule);
    }
  }

  return globalMode;
}

/**
 * 匹配路由模式 —— 支持精确匹配、通配符 *、动态路由 :id
 */
export function matchRoutePattern(url: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (pattern === url) return true;

  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -1);
    return url.startsWith(prefix);
  }

  if (pattern.includes(':')) {
    const patternParts = pattern.split('/');
    const urlParts = url.split('/');
    if (patternParts.length !== urlParts.length) return false;
    return patternParts.every((part, index) => {
      return part.startsWith(':') || part === urlParts[index];
    });
  }

  return false;
}

/**
 * 获取路由的完整降级链
 */
export function getRouteFallbackChain(
  url: string,
  globalMode: RenderModeType,
  overrides?: Record<string, RouteRule>
): InternalStrategyType[] {
  const mode = resolveRenderMode(url, globalMode, overrides);
  return getFallbackChain(mode);
}
