import { expect, it } from 'vitest';
import type { ViteDevServer } from 'vite';
import { createMemoryCacheStore } from '../isrCacheStore';
import { createIsrCacheMiddleware } from '../isrCacheMiddleware';

it('releases registered cache resources when the Vite server closes', async () => {
  const store = createMemoryCacheStore();
  let destroyed = 0;
  const plugin = createIsrCacheMiddleware(
    { renderMode: 'isr', revalidate: 60 },
    {
      store: {
        ...store,
        destroy: async () => {
          destroyed++;
          await store.destroy();
        },
      },
    }
  );
  const server = {
    middlewares: { use: () => undefined },
    config: { root: process.cwd() },
  } as unknown as ViteDevServer;
  const configure = plugin.configureServer as (server: ViteDevServer) => Promise<void>;
  await configure(server);
  try {
    expect(typeof plugin.closeBundle).toBe('function');
    await (plugin.closeBundle as () => Promise<void>)();
    expect(destroyed).toBe(1);
    await (plugin.closeBundle as () => Promise<void>)();
    expect(destroyed).toBe(1);
  } finally {
    if (!destroyed) await store.destroy();
  }
});
