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

  const rule = selectRouteRule(url, overrides);
  return rule === undefined ? globalMode : ruleToMode(rule);
}

type RouteToken = { kind: 'literal'; value: string } | { kind: 'glob' } | { kind: 'parameter' };

/**
 * One grammar for public mode resolution and cache policy selection:
 * `*` spans zero or more characters (including slashes), while a segment
 * beginning with `:name` consumes one nonempty segment. Literal code points are
 * compared directly; paths retain their encoding and trailing-slash distinctions.
 */
function compileRoutePattern(pattern: string): { tokens: RouteToken[]; specificity: number[] } {
  let literalCount = 0;
  let parameterCount = 0;
  let globCount = 0;
  const tokens: RouteToken[] = [];
  const segments = pattern.split('/');
  for (const [index, segment] of segments.entries()) {
    if (index > 0) {
      tokens.push({ kind: 'literal', value: '/' });
      literalCount++;
    }
    let remaining = segment;
    if (segment.startsWith(':') && segment.length > 1 && segment[1] !== '*') {
      const globIndex = segment.indexOf('*');
      parameterCount++;
      tokens.push({ kind: 'parameter' });
      remaining = globIndex < 0 ? '' : segment.slice(globIndex);
    }
    for (const character of remaining) {
      if (character === '*') {
        globCount++;
        tokens.push({ kind: 'glob' });
      } else {
        literalCount++;
        tokens.push({ kind: 'literal', value: character });
      }
    }
  }
  return { tokens, specificity: [literalCount, -globCount, parameterCount] };
}

/**
 * Dynamic programming bounds matching to O(tokens × path code points) time and
 * O(path code points) memory. In particular, repeated globs never backtrack over
 * exponentially many partitions when a final literal fails to match.
 */
function matchesRouteTokens(url: string, tokens: RouteToken[]): boolean {
  const characters = Array.from(url);
  let previous = new Uint8Array(characters.length + 1);
  let current = new Uint8Array(characters.length + 1);
  previous[0] = 1;
  for (const token of tokens) {
    current.fill(0);
    if (token.kind === 'glob') current[0] = previous[0];
    for (let index = 1; index <= characters.length; index++) {
      if (token.kind === 'glob') {
        current[index] = previous[index] || current[index - 1];
      } else if (token.kind === 'parameter') {
        current[index] =
          characters[index - 1] !== '/' ? previous[index - 1] || current[index - 1] : 0;
      } else {
        current[index] = characters[index - 1] === token.value ? previous[index - 1] : 0;
      }
    }
    [previous, current] = [current, previous];
  }
  return previous[characters.length] === 1;
}

/** Match exact, dynamic, interior glob and combined dynamic/glob patterns. */
export function matchRoutePattern(url: string, pattern: string): boolean {
  if (url === pattern) return true;
  if (!pattern.includes('*') && !pattern.split('/').some(segment => segment.startsWith(':')))
    return false;
  return matchesRouteTokens(url, compileRoutePattern(pattern).tokens);
}

/**
 * Exact paths win. Otherwise prefer more literal characters, fewer unrestricted
 * globs, then more constrained parameters. Parameter names never affect ranking.
 * Equal specificity keeps declaration order; both consumers select the whole rule
 * so mode, TTL and SWR cannot come from different matching algorithms.
 */
export function selectRouteRule(
  url: string,
  routes: Record<string, RouteRule>
): RouteRule | undefined {
  if (Object.prototype.hasOwnProperty.call(routes, url) && routes[url] !== undefined)
    return routes[url];
  let selected: RouteRule | undefined;
  let best: number[] | undefined;
  for (const [pattern, rule] of Object.entries(routes)) {
    // Exact declarations were already checked; avoid DP work for every other literal route.
    if (!pattern.includes('*') && !pattern.split('/').some(segment => segment.startsWith(':')))
      continue;
    const { tokens, specificity } = compileRoutePattern(pattern);
    if (!matchesRouteTokens(url, tokens)) continue;
    const bestSpecificity = best;
    const difference = bestSpecificity
      ? specificity.findIndex((value, index) => value !== bestSpecificity[index])
      : -1;
    if (!best || (difference >= 0 && specificity[difference] > best[difference])) {
      selected = rule;
      best = specificity;
    }
  }
  return selected;
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
