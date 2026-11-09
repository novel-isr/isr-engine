import { expect, it } from 'vitest';
import { createIsrCacheHandler, type IsrCacheHandler } from '../isrCacheMiddleware';

const invalidTtl = [Infinity, -Infinity, NaN, 0, -1, '60', null, Number.MAX_VALUE];
const invalidSwr = [Infinity, -Infinity, NaN, -1, '60', null, Number.MAX_VALUE];

it.each(invalidTtl)(
  'rejects invalid explicit ttl %s before acquiring cache resources',
  async ttl => {
    let handler: IsrCacheHandler | undefined;
    try {
      expect(() => {
        handler = createIsrCacheHandler({
          revalidate: 60,
          routes: { '/page': { mode: 'isr', ttl: ttl as number, staleWhileRevalidate: 0 } },
        });
      }).toThrow(/ttl|window/i);
    } finally {
      await handler?.destroy();
    }
  }
);

it.each(invalidSwr)('rejects invalid explicit stale window %s', async swr => {
  let handler: IsrCacheHandler | undefined;
  try {
    expect(() => {
      handler = createIsrCacheHandler({
        revalidate: 60,
        routes: { '/page': { mode: 'isr', ttl: 1, staleWhileRevalidate: swr as number } },
      });
    }).toThrow(/staleWhileRevalidate|window/i);
  } finally {
    await handler?.destroy();
  }
});

it.each([Infinity, NaN, 0, -1, Number.MAX_VALUE])(
  'rejects invalid revalidate %s instead of inheriting a fallback',
  async revalidate => {
    let handler: IsrCacheHandler | undefined;
    try {
      expect(() => {
        handler = createIsrCacheHandler({ revalidate });
      }).toThrow(/revalidate|window/i);
    } finally {
      await handler?.destroy();
    }
  }
);

it.each([Infinity, NaN, 0, -1])('rejects invalid defaultTtlSeconds %s', async defaultTtlSeconds => {
  let handler: IsrCacheHandler | undefined;
  try {
    expect(() => {
      handler = createIsrCacheHandler(undefined, { defaultTtlSeconds });
    }).toThrow(/defaultTtlSeconds|window/i);
  } finally {
    await handler?.destroy();
  }
});

it('accepts undefined inheritance, fractional TTL and an explicit zero stale window', async () => {
  const handler = createIsrCacheHandler({
    revalidate: 0.01,
    routes: { '/page': { mode: 'isr', ttl: undefined, staleWhileRevalidate: 0 } },
  });
  await handler.destroy();
});
