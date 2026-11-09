export interface CacheDurationOverrides {
  ttl?: unknown;
  staleWhileRevalidate?: unknown;
}

/** Cache deadlines must remain finite, positive (or explicitly zero for SWR) timestamps. */
export function assertCacheDuration(
  seconds: unknown,
  label: string,
  allowZero = false
): asserts seconds is number {
  if (
    typeof seconds !== 'number' ||
    !Number.isFinite(seconds) ||
    (allowZero ? seconds < 0 : seconds <= 0) ||
    seconds * 1000 > Number.MAX_SAFE_INTEGER
  )
    throw new RangeError(
      `${label} must be finite ${allowZero ? 'non-negative' : 'positive'} seconds within the safe cache window`
    );
}

/** Undefined inherits; explicit invalid values never silently substitute another policy. */
export function resolveCacheDurations(
  defaultTtl: number,
  overrides: CacheDurationOverrides = {},
  label = 'route'
): { ttlSeconds: number; swrSeconds: number } {
  assertCacheDuration(defaultTtl, 'revalidate');
  const ttl = overrides.ttl === undefined ? defaultTtl : overrides.ttl;
  const swr = overrides.staleWhileRevalidate === undefined ? ttl : overrides.staleWhileRevalidate;
  assertCacheDuration(ttl, `${label}.ttl`);
  assertCacheDuration(swr, `${label}.staleWhileRevalidate`, true);
  if ((ttl + swr) * 1000 > Number.MAX_SAFE_INTEGER - Date.now())
    throw new RangeError(`${label} cache window exceeds a safe deadline timestamp`);
  return { ttlSeconds: ttl, swrSeconds: swr };
}
