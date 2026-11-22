/**
 * resolveSeoConfig 单元测试
 *
 * 覆盖 baseUrl 解析顺序：
 *   1. runtime.site
 *   2. dev 兜底
 *   3. prod 未配置 → 空串
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  resolveSeoConfig,
  resolveSitemapLastModified,
  resolveSitemapLoader,
} from '../resolveSeoConfig';
import type { ISRConfig } from '../../../types';
import { SEOEngine } from '../SEOEngine';

const ORIG = process.env;

type DeepPartial<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

function config(extra: DeepPartial<ISRConfig> = {}): ISRConfig {
  const runtime: ISRConfig['runtime'] = {
    site: undefined,
    services: { api: undefined, telemetry: undefined },
    redis: undefined,
    experiments: {},
    i18n: undefined,
    seo: undefined,

    telemetry: false,
    ...(extra.runtime as Partial<ISRConfig['runtime']> | undefined),
  };

  return {
    renderMode: 'isr',
    revalidate: extra.revalidate ?? 3600,
    routes: (extra.routes as ISRConfig['routes'] | undefined) ?? {},
    runtime,
    ssg: {
      routes: (extra.ssg?.routes as ISRConfig['ssg']['routes'] | undefined) ?? [],
      concurrent: extra.ssg?.concurrent ?? 3,
      requestTimeoutMs: extra.ssg?.requestTimeoutMs ?? 30_000,
      maxRetries: extra.ssg?.maxRetries ?? 3,
      retryBaseDelayMs: extra.ssg?.retryBaseDelayMs ?? 200,
      failBuildThreshold: extra.ssg?.failBuildThreshold ?? 0.05,
    },
    server: {
      port: extra.server?.port ?? 3000,
      host: extra.server?.host ?? '127.0.0.1',
      strictPort: extra.server?.strictPort ?? true,
      ops: {
        authToken: extra.server?.ops?.authToken,
        tokenHeader: extra.server?.ops?.tokenHeader ?? 'x-isr-admin-token',
        health: {
          enabled: extra.server?.ops?.health?.enabled ?? true,
          public: extra.server?.ops?.health?.public ?? true,
        },
        metrics: {
          enabled: extra.server?.ops?.metrics?.enabled ?? false,
          public: extra.server?.ops?.metrics?.public ?? false,
        },
        inventory: {
          enabled: extra.server?.ops?.inventory?.enabled ?? false,
          public: extra.server?.ops?.inventory?.public ?? false,
        },
      },
    },
  };
}

beforeEach(() => {
  process.env = { ...ORIG };
  delete process.env.SEO_BASE_URL;
  delete process.env.PUBLIC_BASE_URL;
  delete process.env.BASE_URL;
});

afterEach(() => {
  process.env = ORIG;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  SEOEngine.resetInstance();
});

describe('resolveSeoConfig', () => {
  it('runtime.site 优先级最高', () => {
    const r = resolveSeoConfig(config({ runtime: { site: 'https://from-runtime.com' } }));
    expect(r.baseUrl).toBe('https://from-runtime.com');
    expect(r.baseUrlSource).toBe('runtime.site');
  });

  it('生产域名只从 runtime.site 读取，不暗读 SEO_BASE_URL', () => {
    process.env.SEO_BASE_URL = 'https://seo.com';
    process.env.PUBLIC_BASE_URL = 'https://public.com';
    process.env.BASE_URL = 'https://base.com';
    vi.stubEnv('NODE_ENV', 'production');
    const r = resolveSeoConfig(config());
    expect(r.baseUrl).toBe('');
    expect(r.baseUrlSource).toBe('unset');
  });

  it('dev 模式无 env 时回退到 localhost', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const r = resolveSeoConfig(config({ server: { port: 4000 } }));
    expect(r.baseUrl).toBe('http://localhost:4000');
    expect(r.baseUrlSource).toBe('dev-default');
  });

  it('dev 模式无 server.port 时用 process.env.PORT 或 3000', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const r = resolveSeoConfig(config());
    expect(r.baseUrl).toMatch(/^http:\/\/localhost:\d+$/);
    expect(r.baseUrlSource).toBe('dev-default');
  });

  it('prod 模式无任何配置 → 空串 + unset 标志', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const r = resolveSeoConfig(config());
    expect(r.baseUrl).toBe('');
    expect(r.baseUrlSource).toBe('unset');
  });

  it('SEO 开关不再暴露，engine 始终解析 baseUrl', () => {
    const r = resolveSeoConfig(config());
    expect(r).toHaveProperty('baseUrl');
    expect(r).not.toHaveProperty('enabled');
    expect(r).not.toHaveProperty('generateSitemap');
    expect(r).not.toHaveProperty('generateRobots');
  });
});

it('uses timestamps only for the matching localized sitemap URL', () => {
  const timestamps = resolveSitemapLastModified(
    config({
      runtime: {
        i18n: { locales: ['en', 'ja'], defaultLocale: 'en' },
        seo: {
          fallbackLocal: [
            { path: '/about', modifiedTime: '2024-01-01' },
            { path: '/about', locale: 'ja', modifiedTime: '2024-01-02' },
            { path: '/about', locale: 'en', modifiedTime: '2024-01-03' },
            { path: '/about', locale: 'en', modifiedTime: '2024-01-04' },
            { path: '/about', locale: 'unsupported', modifiedTime: '2024-01-05' },
            { path: '/legacy', modifiedTime: '2024-01-06' },
          ],
        },
      },
    })
  );

  expect(timestamps).toEqual(
    new Map([
      ['/about', '2024-01-03'],
      ['/ja/about', '2024-01-02'],
      ['/legacy', '2024-01-06'],
    ])
  );
});

it('loads an absolute catalog endpoint with the SEO timeout and propagates timeouts', async () => {
  const endpoint = 'https://metadata.example.com/catalog';
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    expect(url).toBe(endpoint);
    expect(new Headers(options?.headers).get('accept')).toBe('application/json');
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    await new Promise<void>(resolve => {
      options?.signal?.addEventListener('abort', () => resolve(), { once: true });
    });
    options?.signal?.throwIfAborted();
    throw new Error('Expected an aborted request');
  });
  const source = resolveSitemapLoader(
    config({
      runtime: { site: 'https://example.com', seo: { sitemap: { endpoint }, timeoutMs: 10 } },
    })
  );

  await expect(source?.load()).rejects.toMatchObject({ name: 'TimeoutError' });
  expect(fetch).toHaveBeenCalledTimes(1);
});
