import { describe, expect, it } from 'vitest';
import type { ResponseCacheBackend } from '../../cache/ResponseCacheBackend';
import { createCoherentCacheStore } from '../coherentCacheStore';
import type { IsrCachedEntry } from '../isrCacheStore';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return { promise, resolve };
}
function fixture() {
  let closed = false;
  const lease = { incarnation: 'test', revision: '0' };
  const backend: ResponseCacheBackend = {
    maxTtlMs: 60_000,
    capture: async () => lease,
    read: async () => ({ lease }),
    commit: async () => true,
    invalidateTag: async () => undefined,
    remove: async () => undefined,
    clear: async () => undefined,
    destroy: async () => {
      closed = true;
    },
  };
  return {
    backend,
    lease,
    get closed() {
      return closed;
    },
  };
}
const response = (): IsrCachedEntry => ({
  body: Buffer.from('page'),
  statusCode: 200,
  contentType: 'text/html',
  headers: {},
  storedAt: Date.now(),
  expiresAt: Date.now() + 1000,
  hardExpiresAt: Date.now() + 2000,
  tags: ['posts'],
});

describe('coherent cache graceful shutdown', () => {
  it('waits for an in-flight commit before closing the backend', async () => {
    const f = fixture();
    const started = deferred<void>();
    const release = deferred<boolean>();
    f.backend.commit = async () => {
      started.resolve();
      return release.promise;
    };
    const store = createCoherentCacheStore({ backend: f.backend });
    const commit = store.coherence!.commit('GET:/page', response(), f.lease);
    await started.promise;
    const destroy = store.destroy();
    try {
      await Promise.resolve();
      expect(f.closed).toBe(false);
    } finally {
      release.resolve(true);
      await Promise.all([commit, destroy]);
    }
    expect(f.closed).toBe(true);
  });

  it('waits for durable invalidation before closing the backend', async () => {
    const f = fixture();
    const started = deferred<void>();
    const release = deferred<void>();
    f.backend.invalidateTag = async () => {
      started.resolve();
      await release.promise;
    };
    const store = createCoherentCacheStore({ backend: f.backend });
    const invalidation = store.invalidateByTag!('posts');
    await started.promise;
    const destroy = store.destroy();
    try {
      await Promise.resolve();
      expect(f.closed).toBe(false);
    } finally {
      release.resolve();
      await Promise.all([invalidation, destroy]);
    }
    expect(f.closed).toBe(true);
  });
});
