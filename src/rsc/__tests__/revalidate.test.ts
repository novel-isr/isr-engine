import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Counter } from 'prom-client';
import {
  registerInvalidator,
  revalidatePath,
  revalidateTag,
  RevalidationError,
  type RevalidateInvalidator,
} from '../revalidate';
import { invalidatorFailuresTotal, invalidatorRunsTotal } from '../../metrics/PromMetrics';

// 注意：registerInvalidator 用 `Symbol.for(...)` 挂在 globalThis 上，跨 test 文件共享。
// 因此每个 test 必须自己清理（unregister）已注册的 invalidator——否则前一个 test 的
// invalidator 会污染后一个。每个 it() 里都通过 unregister fn 显式清掉。
//
// 这个共享状态本身是真正的产品行为（跨 Vite environments 复用注册表）——
// 不是 test smell，是 contract 验证。

async function freshCounter(label: 'path' | 'tag', counter: Counter<'kind'>): Promise<number> {
  const metric = await counter.get();
  const v = metric.values.find(x => x.labels.kind === label);
  return v?.value ?? 0;
}

describe('revalidate.ts —— Promise.allSettled + RevalidationError 语义', () => {
  let cleanup: Array<() => void> = [];

  beforeEach(() => {
    cleanup = [];
  });

  afterEach(() => {
    cleanup.forEach(fn => fn());
    cleanup = [];
  });

  it('无 invalidator 注册时静默 no-op，不报错', async () => {
    await expect(revalidatePath('/books')).resolves.toBeUndefined();
    await expect(revalidateTag('books')).resolves.toBeUndefined();
  });

  it('单个成功的 invalidator —— 调一次，无错', async () => {
    const fn: RevalidateInvalidator = vi.fn(async () => {});
    cleanup.push(registerInvalidator(fn));

    await revalidateTag('books');

    expect(fn).toHaveBeenCalledOnce();
    expect(fn).toHaveBeenCalledWith({ kind: 'tag', value: 'books' });
  });

  it('多个 invalidator 全部成功 —— 全部调用，不抛错', async () => {
    const a = vi.fn(async () => {});
    const b = vi.fn(async () => {});
    const c = vi.fn(async () => {});
    cleanup.push(registerInvalidator(a), registerInvalidator(b), registerInvalidator(c));

    await revalidatePath('/books/1');

    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
    expect(c).toHaveBeenCalledOnce();
  });

  it('一个 invalidator 失败 —— 其他仍然执行，最终抛 RevalidationError', async () => {
    const ok1 = vi.fn(async () => {});
    const fail = vi.fn(async () => {
      throw new Error('redis down');
    });
    const ok2 = vi.fn(async () => {});
    cleanup.push(registerInvalidator(ok1), registerInvalidator(fail), registerInvalidator(ok2));

    await expect(revalidateTag('books')).rejects.toMatchObject({
      name: 'RevalidationError',
      target: 'tag:books',
      successCount: 2,
      failureCount: 1,
    });

    // 关键不变量：失败的 invalidator 不能阻塞其他 invalidator 跑完
    expect(ok1).toHaveBeenCalledOnce();
    expect(fail).toHaveBeenCalledOnce();
    expect(ok2).toHaveBeenCalledOnce();
  });

  it('多个 invalidator 全部失败 —— RevalidationError.causes 含全部原始 Error', async () => {
    const e1 = new Error('redis down');
    const e2 = new Error('memory cache corrupted');
    cleanup.push(
      registerInvalidator(() => Promise.reject(e1)),
      registerInvalidator(() => Promise.reject(e2))
    );

    try {
      await revalidatePath('/books');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RevalidationError);
      const re = err as RevalidationError;
      expect(re.successCount).toBe(0);
      expect(re.failureCount).toBe(2);
      expect(re.causes).toHaveLength(2);
      expect(re.causes[0]).toBe(e1);
      expect(re.causes[1]).toBe(e2);
      expect(re.target).toBe('path:/books');
    }
  });

  it('非 Error 类型的 reject（字符串）—— 包成 Error', async () => {
    cleanup.push(registerInvalidator(() => Promise.reject('string error')));

    await expect(revalidateTag('books')).rejects.toMatchObject({
      name: 'RevalidationError',
      causes: expect.arrayContaining([expect.any(Error)]),
    });
  });

  it('同步抛错的 invalidator —— 也被 allSettled 捕获', async () => {
    cleanup.push(
      registerInvalidator(() => {
        throw new Error('sync throw');
      })
    );

    await expect(revalidateTag('books')).rejects.toBeInstanceOf(RevalidationError);
  });

  it('unregister 后不再被调用', async () => {
    const fn = vi.fn(async () => {});
    const unregister = registerInvalidator(fn);

    await revalidateTag('books');
    expect(fn).toHaveBeenCalledOnce();

    unregister();
    await revalidateTag('books');
    expect(fn).toHaveBeenCalledOnce(); // 还是 1 次，没增加
  });

  it('metric: invalidatorRunsTotal{kind=tag} 每次有 invalidator 时 +1', async () => {
    const before = await freshCounter('tag', invalidatorRunsTotal);

    cleanup.push(registerInvalidator(() => Promise.resolve()));
    await revalidateTag('books');

    const after = await freshCounter('tag', invalidatorRunsTotal);
    expect(after).toBe(before + 1);
  });

  it('metric: invalidatorRunsTotal 在无 invalidator 时不递增', async () => {
    const before = await freshCounter('path', invalidatorRunsTotal);
    await revalidatePath('/no-invalidator');
    const after = await freshCounter('path', invalidatorRunsTotal);
    expect(after).toBe(before);
  });

  it('metric: invalidatorFailuresTotal{kind=path} 每个失败 invalidator +1', async () => {
    const before = await freshCounter('path', invalidatorFailuresTotal);

    cleanup.push(
      registerInvalidator(() => Promise.reject(new Error('fail1'))),
      registerInvalidator(() => Promise.reject(new Error('fail2'))),
      registerInvalidator(() => Promise.resolve()) // 这个不计入 failures
    );

    await expect(revalidatePath('/books')).rejects.toBeInstanceOf(RevalidationError);

    const after = await freshCounter('path', invalidatorFailuresTotal);
    expect(after).toBe(before + 2);
  });

  it('RevalidationError.message 包含 target 与首个 cause', async () => {
    cleanup.push(registerInvalidator(() => Promise.reject(new Error('redis timeout'))));

    try {
      await revalidateTag('books');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('tag:books');
      expect((err as Error).message).toContain('redis timeout');
    }
  });
});
