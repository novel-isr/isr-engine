import type { CacheStrategyType, ISRConfig, ResolvedISRConfig, RouteRule } from '@/types';

const DEFAULT_CACHE_STRATEGY: CacheStrategyType = 'memory';
const DEFAULT_CACHE_TTL_SECONDS = 3600;

/**
 * Engine-owned config normalization.
 *
 * User config should describe product/deployment intent. Operational defaults such as
 * "use in-process ISR cache when no Redis connection is available" belong here, not in
 * each application's ssr.config.ts.
 */
export function normalizeEngineConfig(config: ISRConfig): ResolvedISRConfig {
  const renderMode = config.renderMode ?? 'isr';
  const routes: Record<string, RouteRule> = config.routes ?? {};
  const cache = {
    strategy: config.cache?.strategy ?? DEFAULT_CACHE_STRATEGY,
    ttl: config.cache?.ttl ?? config.isr?.revalidate ?? DEFAULT_CACHE_TTL_SECONDS,
  };

  return {
    ...config,
    renderMode,
    routes,
    cache,
  };
}
