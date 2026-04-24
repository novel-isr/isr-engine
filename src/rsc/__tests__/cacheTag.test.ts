/**
 * cacheTag / markUncacheable / runWithTagStore 单元测试
 *
 * 覆盖：
 *   - 多次 cacheTag 调用合并去重
 *   - 跨 await 边界保留作用域（AsyncLocalStorage 行为）
 *   - 无作用域时 cacheTag 静默忽略（不抛错）
 *   - markUncacheable 标志位
 *   - 多次 markUncacheable 幂等
 */
import { describe, it, expect } from 'vitest';
import {
  cacheTag,
  collectTags,
  runWithTagStore,
  markUncacheable,
  isUncacheable,
} from '../cacheTag';

describe('cacheTag', () => {
  it('在作用域内收集 tag', async () => {
    const tags = await runWithTagStore(async () => {
      cacheTag('books');
      cacheTag('books:fantasy');
      return collectTags();
    });
    expect(tags).toEqual(['books', 'books:fantasy']);
  });

  it('多次同名 tag 自动去重', async () => {
    const tags = await runWithTagStore(async () => {
      cacheTag('books');
      cacheTag('books');
      cacheTag('books');
      return collectTags();
    });
    expect(tags).toEqual(['books']);
  });

  it('一次调用多个 tag', async () => {
    const tags = await runWithTagStore(async () => {
      cacheTag('a', 'b', 'c');
      return collectTags();
    });
    expect(tags).toEqual(['a', 'b', 'c']);
  });

  it('过滤空字符串和非 string 值', async () => {
    const tags = await runWithTagStore(async () => {
      cacheTag('valid', '', null as unknown as string, undefined as unknown as string);
      return collectTags();
    });
    expect(tags).toEqual(['valid']);
  });

  it('跨 await 边界保留作用域', async () => {
    const tags = await runWithTagStore(async () => {
      cacheTag('before');
      await new Promise(r => setTimeout(r, 10));
      cacheTag('after-await');
      return collectTags();
    });
    expect(tags).toContain('before');
    expect(tags).toContain('after-await');
  });

  it('不同作用域互不污染', async () => {
    const [a, b] = await Promise.all([
      runWithTagStore(async () => {
        cacheTag('a-tag');
        return collectTags();
      }),
      runWithTagStore(async () => {
        cacheTag('b-tag');
        return collectTags();
      }),
    ]);
    expect(a).toEqual(['a-tag']);
    expect(b).toEqual(['b-tag']);
  });

  it('无作用域时静默忽略，不抛错', () => {
    expect(() => cacheTag('no-scope')).not.toThrow();
    expect(collectTags()).toEqual([]);
  });
});

describe('markUncacheable', () => {
  it('默认 false', async () => {
    await runWithTagStore(async () => {
      expect(isUncacheable()).toBe(false);
    });
  });

  it('调用后变 true', async () => {
    await runWithTagStore(async () => {
      markUncacheable();
      expect(isUncacheable()).toBe(true);
    });
  });

  it('多次调用幂等', async () => {
    await runWithTagStore(async () => {
      markUncacheable();
      markUncacheable();
      markUncacheable();
      expect(isUncacheable()).toBe(true);
    });
  });

  it('与 cacheTag 共存', async () => {
    const result = await runWithTagStore(async () => {
      cacheTag('books');
      markUncacheable();
      return { tags: collectTags(), uncacheable: isUncacheable() };
    });
    expect(result.tags).toEqual(['books']);
    expect(result.uncacheable).toBe(true);
  });

  it('无作用域时返回 false', () => {
    expect(isUncacheable()).toBe(false);
  });

  it('不同作用域 uncacheable 互不污染', async () => {
    const [a, b] = await Promise.all([
      runWithTagStore(async () => {
        markUncacheable();
        return isUncacheable();
      }),
      runWithTagStore(async () => {
        return isUncacheable();
      }),
    ]);
    expect(a).toBe(true);
    expect(b).toBe(false);
  });
});
