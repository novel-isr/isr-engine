import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
/**
 * RenderMode —— 路由模式解析 + 通配符 / 动态路由 / fallback chain
 *
 * 零测试模块，但路由匹配逻辑直接决定每个请求走 isr / ssg / ssr，
 * 写错一个字符（比如 `/*` 前缀逻辑）就可能全站走错模式。
 */
import { describe, it, expect } from 'vitest';
import {
  resolveRenderMode,
  matchRoutePattern,
  getFallbackChain,
  getRouteFallbackChain,
} from '../RenderMode';
import type { RouteRule } from '../../types';

describe('matchRoutePattern', () => {
  it('`*` 匹配任何 URL', () => {
    expect(matchRoutePattern('/', '*')).toBe(true);
    expect(matchRoutePattern('/foo/bar/baz', '*')).toBe(true);
    expect(matchRoutePattern('', '*')).toBe(true);
  });

  it('精确字符串相等', () => {
    expect(matchRoutePattern('/about', '/about')).toBe(true);
    expect(matchRoutePattern('/about', '/About')).toBe(false); // 大小写敏感
    expect(matchRoutePattern('/about/', '/about')).toBe(false);
  });

  it('前缀通配 `/prefix/*`', () => {
    expect(matchRoutePattern('/books/1', '/books/*')).toBe(true);
    expect(matchRoutePattern('/books/1/reviews', '/books/*')).toBe(true);
    expect(matchRoutePattern('/books', '/books/*')).toBe(false);
    expect(matchRoutePattern('/bookstore/1', '/books/*')).toBe(false);
  });

  it('动态路由 `:id` —— 段数必须相等 + 字面段必须匹配', () => {
    expect(matchRoutePattern('/books/123', '/books/:id')).toBe(true);
    expect(matchRoutePattern('/books/abc-def', '/books/:id')).toBe(true);
    // 段数不等
    expect(matchRoutePattern('/books', '/books/:id')).toBe(false);
    expect(matchRoutePattern('/books/123/reviews', '/books/:id')).toBe(false);
    // 字面段不匹配
    expect(matchRoutePattern('/users/123', '/books/:id')).toBe(false);
  });

  it('多级 `:id` + 静态段混合', () => {
    expect(matchRoutePattern('/users/42/posts/99', '/users/:userId/posts/:postId')).toBe(true);
    expect(matchRoutePattern('/users/42/comments/99', '/users/:userId/posts/:postId')).toBe(false);
  });

  it('非匹配模式（既不是 *、精确、/*、也没有 :） → false', () => {
    // `/books` 模式对 `/books/1` 不应误匹配
    expect(matchRoutePattern('/books/1', '/books')).toBe(false);
  });
});

describe('resolveRenderMode', () => {
  it('无 overrides → 直接用 globalMode', () => {
    expect(resolveRenderMode('/', 'isr')).toBe('isr');
    expect(resolveRenderMode('/books/1', 'ssr')).toBe('ssr');
  });

  it('精确匹配优先', () => {
    const overrides: Record<string, RouteRule> = {
      '/about': 'ssg',
      '/books/*': 'ssr',
    };
    expect(resolveRenderMode('/about', 'isr', overrides)).toBe('ssg');
  });

  it('通配符匹配', () => {
    const overrides: Record<string, RouteRule> = { '/books/*': 'ssr' };
    expect(resolveRenderMode('/books/1', 'isr', overrides)).toBe('ssr');
    expect(resolveRenderMode('/about', 'isr', overrides)).toBe('isr'); // 未命中 → 回全局
  });

  it('RouteRuleObject 形态也识别', () => {
    const overrides: Record<string, RouteRule> = {
      '/books/*': {
        mode: 'isr',
        ttl: 60,
        staleWhileRevalidate: undefined,
      },
    };
    expect(resolveRenderMode('/books/42', 'ssr', overrides)).toBe('isr');
  });

  it('动态路由 `:id` 匹配', () => {
    const overrides: Record<string, RouteRule> = {
      '/users/:id': 'ssr',
    };
    expect(resolveRenderMode('/users/42', 'isr', overrides)).toBe('ssr');
    expect(resolveRenderMode('/users/42/posts', 'isr', overrides)).toBe('isr');
  });

  it('未命中任何规则 → globalMode 兜底', () => {
    const overrides: Record<string, RouteRule> = { '/books/*': 'ssr' };
    expect(resolveRenderMode('/contact', 'ssg', overrides)).toBe('ssg');
  });
});

describe('getFallbackChain', () => {
  it('isr → [cached, regenerate, server, csr-shell]', () => {
    expect(getFallbackChain('isr')).toEqual(['cached', 'regenerate', 'server', 'csr-shell']);
  });

  it('ssg → [static, regenerate, server, csr-shell]', () => {
    expect(getFallbackChain('ssg')).toEqual(['static', 'regenerate', 'server', 'csr-shell']);
  });

  it('ssr → [server, csr-shell]', () => {
    expect(getFallbackChain('ssr')).toEqual(['server', 'csr-shell']);
  });

  it('未知 mode → 回退到 isr 链（兜底）', () => {
    // @ts-expect-error 传入非法字符串测试兜底
    expect(getFallbackChain('bogus')).toEqual(['cached', 'regenerate', 'server', 'csr-shell']);
  });

  it('所有链末端都是 csr-shell（最后防线保证）', () => {
    for (const mode of ['isr', 'ssg', 'ssr'] as const) {
      const chain = getFallbackChain(mode);
      expect(chain[chain.length - 1]).toBe('csr-shell');
    }
  });
});

describe('getRouteFallbackChain 集成', () => {
  it('路由命中 → 用命中的 mode 对应的链', () => {
    const overrides: Record<string, RouteRule> = { '/about': 'ssg' };
    expect(getRouteFallbackChain('/about', 'isr', overrides)).toEqual([
      'static',
      'regenerate',
      'server',
      'csr-shell',
    ]);
  });

  it('路由未命中 → 用 globalMode 的链', () => {
    expect(getRouteFallbackChain('/nothing', 'ssr')).toEqual(['server', 'csr-shell']);
  });
});

describe('shared route selection contract', () => {
  const cases: [string, string, string][] = [
    ['/posts/a', '*', '/posts/*'],
    ['/posts/a', '/posts/*', '/posts/:id'],
    ['/posts/a', '/:extremelyLongParameter/:anotherLongParameter', '/posts/*'],
    ['/posts/a/detail', '/posts/*', '/posts/:id/*'],
    ['/posts/a/detail', '/posts/*', '/posts/*/detail'],
    ['/posts/a', '/posts/:id', '/posts/a'],
  ];
  it.each(cases)('%s selects %s < %s regardless of declaration order', (path, broad, specific) => {
    for (const entries of [
      [
        [broad, 'ssr'],
        [specific, 'isr'],
      ],
      [
        [specific, 'isr'],
        [broad, 'ssr'],
      ],
    ]) {
      expect(resolveRenderMode(path, 'ssg', Object.fromEntries(entries))).toBe('isr');
    }
  });
  it('uses declaration order only for equal semantic specificity', () => {
    expect(
      resolveRenderMode('/posts/a', 'ssg', { '/posts/:x': 'ssr', '/posts/:veryLongName': 'isr' })
    ).toBe('ssr');
  });
  it.each([
    ['/posts/a/detail', '/posts/:id/*', true],
    ['/posts//detail', '/posts/:id/*', false],
    ['/posts/a/detail', '/posts/*/detail', true],
    ['/file/a.json', '/file/*.json', true],
    ['/file/aXjson', '/file/*.json', false],
    ['/a+b/x', '/a+b/*', true],
    ['/ab/x', '/a+b/*', false],
    ['/posts/', '/posts/:id', false],
    ['/posts/', '/posts/*', true],
    ['/posts/a/', '/posts/:id', false],
  ])('matches %s against %s = %s', (path, pattern, expected) => {
    expect(matchRoutePattern(path, pattern)).toBe(expected);
  });
});

describe('bounded route matching', () => {
  it('finishes adversarial wildcard failures without blocking the caller', async () => {
    const { outputFiles } = buildSync({
      entryPoints: [fileURLToPath(new URL('../RenderMode.ts', import.meta.url))],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      write: false,
      logLevel: 'error',
    });
    const worker = new Worker(
      outputFiles[0].text +
        `
      const { parentPort } = require('node:worker_threads');
      const path = '/' + 'a'.repeat(80);
      const pattern = '/' + '*a'.repeat(14) + 'b';
      parentPort.postMessage([
        module.exports.matchRoutePattern(path, pattern),
        module.exports.resolveRenderMode(path, 'ssr', { [pattern]: 'isr' }),
      ]);
    `,
      { eval: true }
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await new Promise((resolve, reject) => {
        worker.once('message', resolve);
        worker.once('error', reject);
        timer = setTimeout(() => reject(new Error('wildcard matching exceeded 500ms')), 500);
      });
      expect(result).toEqual([false, 'ssr']);
    } finally {
      clearTimeout(timer);
      // Worker termination remains effective when matching never yields its thread.
      await worker.terminate();
    }
  });
  it.each([
    ['/文/😀', '/文/*', true],
    ['/文/😀', '/文/😀', true],
    ['/文/😀', '/文/😃', false],
    ['/a%2Fb/item', '/:encoded/item', true],
    ['/a%2Fb/item', '/a%2Fb/*', true],
    ['/a/b/item', '/a%2Fb/*', false],
    ['/posts/a', '/posts/:id*', true],
    ['/posts/', '/posts/:id*', false],
  ])('preserves literal and parameter semantics: %s / %s', (path, pattern, expected) => {
    expect(matchRoutePattern(path, pattern)).toBe(expected);
  });
});
