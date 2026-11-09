import { afterEach, expect, it, vi } from 'vitest';
import { createIsrCacheMiddleware } from '../isrCacheMiddleware';
import * as configLoader from '@/config/loadConfig';
import * as stores from '@/cache/createAutoCacheStore';
import { createMemoryCacheStore } from '../isrCacheStore';
import type { Plugin, ViteDevServer } from 'vite';

let plugin: Plugin;
async function closePlugin() {
  const close = plugin?.closeBundle;
  if (close) await (typeof close === 'function' ? close : close.handler).call({} as never);
}
afterEach(async () => {
  await closePlugin();
  vi.restoreAllMocks();
});

it('shares one pending setup across concurrent configure calls', async () => {
  let release!: () => void;
  const ready = new Promise<void>(resolve => {
    release = resolve;
  });
  const loader = vi.spyOn(configLoader, 'loadConfig').mockImplementation(async () => {
    await ready;
    return { renderMode: 'ssr', revalidate: 60, routes: {} } as never;
  });
  plugin = createIsrCacheMiddleware(undefined);
  const target = server();
  const first = configure(target.value);
  const second = configure(target.value);
  try {
    expect(loader).toHaveBeenCalledTimes(1);
  } finally {
    release();
    await Promise.all([first, second]);
  }
  expect(target.use).toHaveBeenCalledTimes(1);
});

it('waits for pending setup ownership before closing its resources', async () => {
  let release!: () => void;
  const ready = new Promise<void>(resolve => {
    release = resolve;
  });
  vi.spyOn(configLoader, 'loadConfig').mockImplementation(async () => {
    await ready;
    return { renderMode: 'ssr', revalidate: 60, routes: {} } as never;
  });
  const store = createMemoryCacheStore();
  const destroy = vi.spyOn(store, 'destroy');
  plugin = createIsrCacheMiddleware(undefined, { store });
  const target = server();
  const setup = configure(target.value);
  let closed = false;
  const closing = closePlugin().then(() => {
    closed = true;
  });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(closed).toBe(false);
  } finally {
    release();
    await Promise.all([setup, closing]);
  }
  expect(destroy).toHaveBeenCalledTimes(1);
  const next = vi.fn();
  target.use.mock.calls[0][0]({}, {}, next);
  expect(next).toHaveBeenCalledTimes(1);
});
function server() {
  const use = vi.fn();
  return {
    value: { config: { root: '/unused' }, middlewares: { use } } as unknown as ViteDevServer,
    use,
  };
}
function configure(value: ViteDevServer) {
  const hook = plugin.configureServer;
  if (!hook) throw new Error('Missing configure hook');
  return (typeof hook === 'function' ? hook : hook.handler).call({} as never, value);
}

it('does not mount default caching or acquire stores when configuration loading fails', async () => {
  const failure = new Error('invalid configuration');
  vi.spyOn(configLoader, 'loadConfig').mockRejectedValue(failure);
  const createStore = vi.spyOn(stores, 'createAutoCacheStore');
  plugin = createIsrCacheMiddleware(undefined);
  const target = server();
  await expect(configure(target.value)).rejects.toBe(failure);
  expect(target.use).not.toHaveBeenCalled();
  expect(createStore).not.toHaveBeenCalled();
});

it('allows setup retry after rejected configuration without treating it as mounted', async () => {
  const loader = vi
    .spyOn(configLoader, 'loadConfig')
    .mockRejectedValueOnce(new Error('first attempt'))
    .mockResolvedValue({ renderMode: 'ssr', revalidate: 60, routes: {} } as never);
  plugin = createIsrCacheMiddleware(undefined);
  const target = server();
  await expect(configure(target.value)).rejects.toThrow('first attempt');
  await configure(target.value);
  const mounts = target.use.mock.calls.length;
  expect(mounts).toBeGreaterThan(0);
  await configure(target.value);
  expect(loader).toHaveBeenCalledTimes(2);
  expect(target.use).toHaveBeenCalledTimes(mounts);
});

it('rejects invalid inline duration before creating an automatic store', async () => {
  const createStore = vi.spyOn(stores, 'createAutoCacheStore');
  plugin = createIsrCacheMiddleware({ revalidate: Infinity });
  const target = server();
  await expect(configure(target.value)).rejects.toThrow(/revalidate/);
  expect(createStore).not.toHaveBeenCalled();
  expect(target.use).not.toHaveBeenCalled();
});
