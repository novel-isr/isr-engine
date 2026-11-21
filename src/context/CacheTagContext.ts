import { AsyncLocalStorage } from 'node:async_hooks';

interface TagStore {
  tags: Set<string>;
  uncacheable: boolean;
}

// The Vite RSC bundle and the Node response cache share this request context.
const KEY = Symbol.for('isr-engine:cache-tag-als');
const runtime = globalThis as typeof globalThis & { [KEY]?: AsyncLocalStorage<TagStore> };

export function getCacheTagStorage(): AsyncLocalStorage<TagStore> {
  return (runtime[KEY] ??= new AsyncLocalStorage<TagStore>());
}

/** Exclude a successful but degraded render from the shared response cache. */
export function markUncacheable(): void {
  const store = getCacheTagStorage().getStore();
  if (store) store.uncacheable = true;
}
