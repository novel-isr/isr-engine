/**
 * Smart Route Manager
 * 智能路由管理 - 根据配置自动选择最优渲染策略
 */

import { type RenderModeType, type ISRConfig, type RouteRule } from '../types';
import { resolveRenderMode, matchRoutePattern } from '../engine/RenderMode';

/** 统一提取 RouteRule 的 mode */
function toMode(rule: RouteRule): RenderModeType {
  return typeof rule === 'string' ? rule : rule.mode;
}

export class RouteManager {
  private globalMode: RenderModeType;
  private overrides: Record<string, RouteRule>;
  private defaultRevalidate: number;

  constructor(config: Partial<ISRConfig>) {
    this.globalMode = config.renderMode || 'isr';
    this.overrides = config.routes || {};
    this.defaultRevalidate = config.revalidate ?? 3600;
  }

  getRenderMode(path: string): RenderModeType {
    return resolveRenderMode(path, this.globalMode, this.overrides);
  }

  hasOverride(path: string): boolean {
    if (this.overrides[path] !== undefined) return true;
    for (const pattern of Object.keys(this.overrides)) {
      if (matchRoutePattern(path, pattern)) return true;
    }
    return false;
  }

  getSSGRoutes(): string[] {
    return Object.entries(this.overrides)
      .filter(
        ([pattern, rule]) =>
          toMode(rule) === 'ssg' && !pattern.includes('*') && !pattern.includes(':')
      )
      .map(([pattern]) => pattern);
  }

  getISRRoutes(): Record<string, { revalidate: number; priority: number }> {
    const result: Record<string, { revalidate: number; priority: number }> = {};
    for (const [pattern, rule] of Object.entries(this.overrides)) {
      if (toMode(rule) === 'isr') {
        const ttl =
          typeof rule === 'object' && typeof rule.ttl === 'number'
            ? rule.ttl
            : this.defaultRevalidate;
        result[pattern] = { revalidate: ttl, priority: 0.5 };
      }
    }
    return result;
  }

  shouldCache(path: string): boolean {
    const mode = this.getRenderMode(path);
    return mode !== 'ssr';
  }

  getPriority(path: string): number {
    if (path === '/') return 1.0;
    const mode = this.getRenderMode(path);
    switch (mode) {
      case 'ssg':
        return 0.8;
      case 'isr':
        return 0.6;
      case 'ssr':
        return 0.4;
      default:
        return 0.5;
    }
  }

  getChangeFreq(path: string): string {
    const mode = this.getRenderMode(path);
    switch (mode) {
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

  getStats() {
    const modeCount: Record<string, number> = {};
    for (const rule of Object.values(this.overrides)) {
      const m = toMode(rule);
      modeCount[m] = (modeCount[m] || 0) + 1;
    }
    return {
      globalMode: this.globalMode,
      overrideCount: Object.keys(this.overrides).length,
      modeDistribution: modeCount,
      ssgRoutes: this.getSSGRoutes().length,
      isrRoutes: Object.keys(this.getISRRoutes()).length,
    };
  }
}
