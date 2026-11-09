import { LRUCache } from 'lru-cache';
import type {
  CacheRenderLease,
  ResponseCacheBackend,
  ResponseCacheSnapshot,
} from '../cache/ResponseCacheBackend';
import type { IsrCachedEntry, IsrCacheStore } from './isrCacheStore';

type SerializedEntry = Omit<IsrCachedEntry, 'body'> & { body: string };
interface LocalSnapshot extends ResponseCacheSnapshot {
  value: SerializedEntry;
  decoded: IsrCachedEntry;
}

function decode(value: unknown): IsrCachedEntry | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const entry = value as SerializedEntry;
  if (
    typeof entry.body !== 'string' ||
    !Array.isArray(entry.tags) ||
    entry.tags.some(tag => typeof tag !== 'string') ||
    !Number.isFinite(entry.hardExpiresAt) ||
    !Number.isFinite(entry.expiresAt) ||
    !Number.isFinite(entry.storedAt) ||
    typeof entry.contentType !== 'string' ||
    !Number.isInteger(entry.statusCode) ||
    !entry.headers ||
    typeof entry.headers !== 'object'
  )
    throw new Error('invalid coherent response cache entry');
  return { ...entry, body: Buffer.from(entry.body, 'base64') };
}

/** Remote validation is mandatory; pub/sub is an eviction hint, never a read authority. */
export function createCoherentCacheStore({
  backend,
  max = 1000,
  maxBytes = 64 * 1024 * 1024,
}: {
  backend: ResponseCacheBackend;
  max?: number;
  maxBytes?: number;
}): IsrCacheStore & { readonly coherence: NonNullable<IsrCacheStore['coherence']> } {
  const local = new LRUCache<string, LocalSnapshot>({
    max,
    maxSize: maxBytes,
    sizeCalculation: snapshot =>
      snapshot.decoded.body.byteLength + Buffer.byteLength(snapshot.value.body) + 1024,
  });
  const pending = new Set<Promise<unknown>>();
  let generation = 0;
  let destroyed = false;
  function track<T>(task: Promise<T>): Promise<T> {
    pending.add(task);
    void task.finally(() => pending.delete(task)).catch(() => undefined);
    return task;
  }
  function evictByTag(tag: string) {
    generation++;
    for (const [key, snapshot] of Array.from(local.entries())) {
      if (snapshot.value.tags.includes(tag) || snapshot.value.pathTag === tag) local.delete(key);
    }
  }
  async function commitValue(key: string, entry: IsrCachedEntry, lease: CacheRenderLease) {
    if (destroyed) return false;
    const value: SerializedEntry = { ...entry, body: entry.body.toString('base64') };
    const ttl = Math.floor(entry.hardExpiresAt - Date.now());
    if (ttl <= 0) return false;
    const stored = await backend.commit(
      key,
      value,
      lease,
      [...entry.tags, ...(entry.pathTag ? [entry.pathTag] : [])],
      ttl
    );
    // Do not publish an unvalidated local value after the remote CAS. A different
    // pod may already have invalidated or replaced it before this await resumes.
    local.delete(key);
    return stored;
  }
  const commit = (key: string, entry: IsrCachedEntry, lease: CacheRenderLease) =>
    track(commitValue(key, entry, lease));
  function background(task: Promise<unknown>) {
    void track(task).catch(error =>
      console.warn('[isr-cache:coherent] background operation failed', error)
    );
  }
  return {
    backend: 'hybrid',
    coherence: {
      beginRender: () => {
        if (destroyed) return Promise.reject(new Error('response cache is closed'));
        return track(backend.capture());
      },
      commit,
    },
    get: () => undefined,
    async getAsync(key) {
      if (destroyed) return undefined;
      const readGeneration = generation;
      let cached = local.get(key);
      if (cached && Date.now() >= cached.value.hardExpiresAt) {
        local.delete(key);
        cached = undefined;
      }
      const snapshot = await track(backend.read(key, cached));
      if (destroyed || readGeneration !== generation) return undefined;
      const entry =
        cached && cached.version === snapshot.version && cached.value === snapshot.value
          ? cached.decoded
          : decode(snapshot.value);
      if (!entry || Date.now() >= entry.hardExpiresAt) {
        local.delete(key);
        return undefined;
      }
      local.set(key, { ...snapshot, decoded: entry } as LocalSnapshot);
      return entry;
    },
    set(key, entry) {
      background(backend.capture().then(lease => commit(key, entry, lease)));
    },
    delete(key) {
      generation++;
      const hit = local.delete(key);
      background(backend.remove(key));
      return hit;
    },
    evictByTag,
    invalidateByTag(tag) {
      if (destroyed) return Promise.reject(new Error('response cache is closed'));
      evictByTag(tag);
      return track(backend.invalidateTag(tag).finally(() => evictByTag(tag)));
    },
    clear() {
      generation++;
      local.clear();
      background(backend.clear());
    },
    *entries() {
      for (const [key, snapshot] of local.entries()) {
        yield [key, snapshot.decoded] as [string, IsrCachedEntry];
      }
    },
    keys: () => local.keys(),
    get size() {
      return local.size;
    },
    get max() {
      return local.max;
    },
    async inspectL2(limit) {
      return backend.inspect ? backend.inspect(limit) : [];
    },
    async destroy() {
      destroyed = true;
      generation++;
      local.clear();
      await Promise.allSettled(Array.from(pending));
      await backend.destroy();
    },
  };
}
