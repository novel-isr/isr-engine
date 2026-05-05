import type { ISRConfig } from '@/types';

/**
 * Engine-owned config normalization.
 *
 * User config should describe product/deployment intent. Operational defaults such as
 * "use in-process ISR cache when no Redis connection is available" belong here, not in
 * each application's ssr.config.ts.
 */
export function normalizeEngineConfig(config: ISRConfig): ISRConfig {
  const legacy = config as ISRConfig & {
    cache?: unknown;
    isr?: unknown;
    seo?: unknown;
  };
  if ('cache' in legacy || 'isr' in legacy || 'seo' in legacy) {
    throw new Error('ssr.config.ts 不再支持 cache/isr/seo 顶层旧字段');
  }
  if (!isRenderMode(config.renderMode)) {
    throw new Error("ssr.config.ts 必须显式声明 renderMode: 'isr' | 'ssr' | 'ssg'");
  }
  if (!Number.isFinite(config.revalidate) || config.revalidate <= 0) {
    throw new Error('ssr.config.ts 必须显式声明正数 revalidate（秒）');
  }
  if (!isRecord(config.routes)) {
    throw new Error('ssr.config.ts 必须显式声明 routes 对象');
  }
  validateRoutes(config.routes);
  if (!isRecord(config.runtime)) {
    throw new Error('ssr.config.ts 必须显式声明 runtime 对象');
  }
  requireOwnProperties(
    config.runtime,
    ['site', 'services', 'redis', 'rateLimit', 'experiments', 'i18n', 'seo', 'telemetry'],
    'runtime'
  );
  if (!isRecord(config.runtime.services)) {
    throw new Error('ssr.config.ts 必须显式声明 runtime.services 对象');
  }
  requireOwnProperties(config.runtime.services, ['api', 'telemetry'], 'runtime.services');
  if (config.runtime.redis !== undefined) {
    requireOwnProperties(
      config.runtime.redis as unknown as Record<string, unknown>,
      ['url', 'host', 'port', 'password', 'keyPrefix', 'invalidationChannel'],
      'runtime.redis'
    );
  }
  if (config.runtime.rateLimit !== false) {
    requireOwnProperties(
      config.runtime.rateLimit as unknown as Record<string, unknown>,
      [
        'store',
        'windowMs',
        'max',
        'lruMax',
        'trustProxy',
        'sendHeaders',
        'keyPrefix',
        'skipPaths',
        'skipPathPrefixes',
        'skipExtensions',
      ],
      'runtime.rateLimit'
    );
  }
  if (!isRecord(config.server)) {
    throw new Error('ssr.config.ts 必须显式声明 server 对象');
  }
  if (!isRecord(config.ssg)) {
    throw new Error('ssr.config.ts 必须显式声明 ssg 对象');
  }

  return {
    ...config,
    renderMode: config.renderMode,
    revalidate: config.revalidate,
  };
}

function isRenderMode(value: unknown): value is ISRConfig['renderMode'] {
  return value === 'isr' || value === 'ssr' || value === 'ssg';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateRoutes(routes: Record<string, unknown>): void {
  for (const [pattern, rule] of Object.entries(routes)) {
    if (typeof rule === 'string') {
      if (!isRenderMode(rule)) {
        throw new Error(`ssr.config.ts routes.${pattern} 必须是 'isr' | 'ssr' | 'ssg'`);
      }
      continue;
    }
    if (!isRecord(rule)) {
      throw new Error(`ssr.config.ts routes.${pattern} 必须是字符串或 RouteRuleObject`);
    }
    requireOwnProperties(rule, ['mode', 'ttl', 'staleWhileRevalidate'], `routes.${pattern}`);
    if (!isRenderMode(rule.mode)) {
      throw new Error(`ssr.config.ts routes.${pattern}.mode 必须是 'isr' | 'ssr' | 'ssg'`);
    }
  }
}

function requireOwnProperties(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string
): void {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new Error(`ssr.config.ts 必须显式声明 ${label}.${key}`);
    }
  }
}
