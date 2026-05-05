import type { RuntimeRedisConfig } from '@/types';

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parsePort(value: string | undefined): number | undefined {
  const normalized = nonEmpty(value);
  if (!normalized) return undefined;
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Resolve Redis connection from runtime config first, then process env.
 *
 * This keeps apps from writing `process.env.REDIS_URL ? ... : undefined` in every
 * ssr.config.ts. A non-empty URL/host enables Redis; missing connection data means the
 * engine stays on memory-backed defaults.
 */
export function resolveRuntimeRedisConfig(
  redis?: RuntimeRedisConfig,
  env: NodeJS.ProcessEnv = process.env
): RuntimeRedisConfig | undefined {
  const url = nonEmpty(redis?.url) ?? nonEmpty(env.REDIS_URL);
  const host = nonEmpty(redis?.host) ?? nonEmpty(env.REDIS_HOST);
  const port = redis?.port ?? parsePort(env.REDIS_PORT);
  const password = redis?.password ?? nonEmpty(env.REDIS_PASSWORD);
  const keyPrefix = redis?.keyPrefix;
  const invalidationChannel = redis?.invalidationChannel;

  if (!url && !host) {
    if (keyPrefix || invalidationChannel) {
      return { keyPrefix, invalidationChannel };
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

export function hasRuntimeRedisConnection(
  redis?: RuntimeRedisConfig,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const resolved = resolveRuntimeRedisConfig(redis, env);
  return Boolean(resolved?.url || resolved?.host);
}
