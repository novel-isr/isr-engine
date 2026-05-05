import type { CacheStrategyType, ISRConfig, ResolvedISRConfig, RouteRule } from '@/types';

const DEFAULT_CACHE_STRATEGY: CacheStrategyType = 'memory';

/**
 * Engine-owned config normalization.
 *
 * User config should describe product/deployment intent. Operational defaults such as
 * "use in-process ISR cache when no Redis connection is available" belong here, not in
 * each application's ssr.config.ts.
 */
export function normalizeEngineConfig(config: ISRConfig): ResolvedISRConfig {
  const legacy = config as ISRConfig & {
    cache?: unknown;
    isr?: unknown;
    seo?: unknown;
  };
  const publicConfig = { ...legacy };
  delete publicConfig.cache;
  delete publicConfig.isr;
  delete publicConfig.seo;
  if (!isRenderMode(config.renderMode)) {
    throw new Error("ssr.config.ts 必须显式声明 renderMode: 'isr' | 'ssr' | 'ssg'");
  }
  if (!Number.isFinite(config.revalidate) || config.revalidate <= 0) {
    throw new Error('ssr.config.ts 必须显式声明正数 revalidate（秒）');
  }

  const renderMode = config.renderMode;
  const routes: Record<string, RouteRule> = config.routes ?? {};
  const revalidate = config.revalidate;
  const cache = {
    strategy: DEFAULT_CACHE_STRATEGY,
    ttl: revalidate,
  };

  return {
    ...publicConfig,
    renderMode,
    revalidate,
    routes,
    cache,
  };
}

function isRenderMode(value: unknown): value is ISRConfig['renderMode'] {
  return value === 'isr' || value === 'ssr' || value === 'ssg';
}
