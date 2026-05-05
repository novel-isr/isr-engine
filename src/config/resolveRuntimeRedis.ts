import type { RuntimeRedisConfig } from '@/types';

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Resolve Redis connection from runtime config only.
 *
 * A non-empty runtime.redis.url/host enables Redis; missing connection data means the
 * engine stays on memory-backed defaults. Environment variables must be wired explicitly
 * in ssr.config.ts so the config file remains the single source of truth.
 */
export function resolveRuntimeRedisConfig(
  redis?: RuntimeRedisConfig
): RuntimeRedisConfig | undefined {
  const url = nonEmpty(redis?.url);
  const host = nonEmpty(redis?.host);
  const port = redis?.port;
  const password = redis?.password;
  const keyPrefix = redis?.keyPrefix;
  const invalidationChannel = redis?.invalidationChannel;

  if (!url && !host) {
    if (keyPrefix || invalidationChannel) {
      return {
        url: undefined,
        host: undefined,
        port: undefined,
        password: undefined,
        keyPrefix,
        invalidationChannel,
      };
    }
    return undefined;
  }

  return {
    url,
    host,
    port,
    password,
    keyPrefix,
    invalidationChannel,
  };
}

export function hasRuntimeRedisConnection(redis?: RuntimeRedisConfig): boolean {
  const resolved = resolveRuntimeRedisConfig(redis);
  return Boolean(resolved?.url || resolved?.host);
}
