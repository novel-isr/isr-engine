import { describe, expect, it } from 'vitest';
import type { ICacheAdapter } from '../../cache/ICacheAdapter';
import { createHybridCacheStore, type IsrCachedEntry } from '../isrCacheStore';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return { promise, resolve };
}
function entry(text: string): IsrCachedEntry {
  return {
    body: Buffer.from(text),
    headers: {},
    statusCode: 200,
    contentType: 'text/html',
    storedAt: Date.now(),
    expiresAt: Date.now() + 60000,
    hardExpiresAt: Date.now() + 120000,
    tags: ['posts'],
  };
}
function serialized(value: IsrCachedEntry) {
  return { ...value, body: value.body.toString('base64') };
}
function fixture() {
  const db = new Map<string, ReturnType<typeof serialized>>([
    ['isr:resp:key', serialized(entry('old'))],
  ]);
  const deleteGate = deferred<void>();
  const tagGate = deferred<void>();
  let gets = 0;
  const redis = {
    get: async (key: string) => {
      gets++;
      return db.get(key);
    },
    set: async (key: string, value: ReturnType<typeof serialized>) => {
      db.set(key, value);
    },
    delete: async (key: string) => {
      await deleteGate.promise;
      return db.delete(key);
    },
    invalidateByTag: async (_tag: string) => {
      await tagGate.promise;
      db.clear();
    },
    destroy: async () => {},
  };
  return {
    store: createHybridCacheStore({ redis: redis as unknown as ICacheAdapter }),
    redis,
    db,
    deleteGate,
    tagGate,
    get gets() {
      return gets;
    },
  };
}
describe('hybrid cache invalidation barriers', () => {
  it('waits for a pending delete before beginning a new L2 read', async () => {
    const f = fixture();
    f.store.delete('key');
    const read = f.store.getAsync!('key');
    await Promise.resolve();
    expect(f.gets).toBe(0);
    f.deleteGate.resolve();
    expect(await read).toBeUndefined();
    expect(f.store.get('key')).toBeUndefined();
    await f.store.destroy();
  });
  it('blocks reads throughout overlapping tag invalidations', async () => {
    const f = fixture();
    const first = f.store.invalidateByTag!('posts');
    const second = f.store.invalidateByTag!('other');
    const read = f.store.getAsync!('key');
    await Promise.resolve();
    expect(f.gets).toBe(0);
    f.tagGate.resolve();
    await Promise.all([first, second]);
    expect(await read).toBeUndefined();
    expect(f.store.get('key')).toBeUndefined();
    await f.store.destroy();
  });
  it('keeps reads blocked until the last queued invalidation finishes', async () => {
    const f = fixture();
    const firstGate = deferred<void>();
    const secondGate = deferred<void>();
    const secondStarted = deferred<void>();
    f.redis.invalidateByTag = async (tag: string) => {
      if (tag === 'first') await firstGate.promise;
      else {
        secondStarted.resolve();
        await secondGate.promise;
      }
    };
    const first = f.store.invalidateByTag!('first');
    const second = f.store.invalidateByTag!('second');
    const read = f.store.getAsync!('key');
    firstGate.resolve();
    await first;
    await secondStarted.promise;
    expect(f.gets).toBe(0);
    secondGate.resolve();
    await second;
    expect((await read)?.body.toString()).toBe('old');
    await f.store.destroy();
  });
  it('reports a failed invalidation and allows later invalidations and reads', async () => {
    const f = fixture();
    f.redis.invalidateByTag = async (tag: string) => {
      if (tag === 'bad') throw new Error('Redis unavailable');
    };
    const failed = f.store.invalidateByTag!('bad');
    const later = f.store.invalidateByTag!('good');
    await expect(failed).rejects.toThrow('Redis unavailable');
    await later;
    expect((await f.store.getAsync!('key'))?.body.toString()).toBe('old');
    await f.store.destroy();
  });
  it('serializes hard-expiry cleanup before a newer write', async () => {
    const f = fixture();
    f.db.set('isr:resp:key', serialized({ ...entry('expired'), hardExpiresAt: Date.now() - 1 }));
    expect(await f.store.getAsync!('key')).toBeUndefined();
    f.store.set('key', entry('new'));
    await Promise.resolve();
    f.deleteGate.resolve();
    await f.store.destroy();
    expect(f.db.get('isr:resp:key')?.body).toBe(Buffer.from('new').toString('base64'));
  });
  it('does not let an old read overwrite a newer local set', async () => {
    const f = fixture();
    const gate = deferred<ReturnType<typeof serialized> | undefined>();
    f.redis.get = () => gate.promise;
    const read = f.store.getAsync!('key');
    await Promise.resolve();
    f.store.set('key', entry('new'));
    gate.resolve(serialized(entry('old')));
    await read;
    expect(f.store.get('key')?.body.toString()).toBe('new');
    await f.store.destroy();
  });
  it('does not refill L1 from a read started before tag invalidation', async () => {
    const f = fixture();
    const gate = deferred<ReturnType<typeof serialized> | undefined>();
    f.redis.get = () => gate.promise;
    const read = f.store.getAsync!('key');
    await Promise.resolve();
    const invalidation = f.store.invalidateByTag!('posts');
    gate.resolve(serialized(entry('old')));
    await read;
    expect(f.store.get('key')).toBeUndefined();
    f.tagGate.resolve();
    await invalidation;
    await f.store.destroy();
  });
});
