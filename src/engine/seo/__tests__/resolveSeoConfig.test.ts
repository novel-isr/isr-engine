/**
 * resolveSeoConfig 单元测试
 *
 * 覆盖 baseUrl 解析顺序：
 *   1. runtime.site
 *   2. dev 兜底
 *   3. prod 未配置 → 空串
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolveSeoConfig } from '../resolveSeoConfig';

const ORIG = process.env;

beforeEach(() => {
  process.env = { ...ORIG };
  delete process.env.SEO_BASE_URL;
  delete process.env.PUBLIC_BASE_URL;
  delete process.env.BASE_URL;
});

afterEach(() => {
  process.env = ORIG;
  vi.unstubAllEnvs();
});

describe('resolveSeoConfig', () => {
  it('runtime.site 优先级最高', () => {
    const r = resolveSeoConfig({
      renderMode: 'isr',
      revalidate: 3600,
      runtime: { site: 'https://from-runtime.com' },
    });
    expect(r.baseUrl).toBe('https://from-runtime.com');
    expect(r.baseUrlSource).toBe('runtime.site');
  });

  it('生产域名只从 runtime.site 读取，不暗读 SEO_BASE_URL', () => {
    process.env.SEO_BASE_URL = 'https://seo.com';
    process.env.PUBLIC_BASE_URL = 'https://public.com';
    process.env.BASE_URL = 'https://base.com';
    vi.stubEnv('NODE_ENV', 'production');
    const r = resolveSeoConfig({ renderMode: 'isr', revalidate: 3600 });
    expect(r.baseUrl).toBe('');
    expect(r.baseUrlSource).toBe('unset');
  });

  it('dev 模式无 env 时回退到 localhost', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const r = resolveSeoConfig({
      renderMode: 'isr',
      revalidate: 3600,
      server: { port: 4000 },
    });
    expect(r.baseUrl).toBe('http://localhost:4000');
    expect(r.baseUrlSource).toBe('dev-default');
  });

  it('dev 模式无 server.port 时用 process.env.PORT 或 3000', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const r = resolveSeoConfig({ renderMode: 'isr', revalidate: 3600 });
    expect(r.baseUrl).toMatch(/^http:\/\/localhost:\d+$/);
    expect(r.baseUrlSource).toBe('dev-default');
  });

  it('prod 模式无任何配置 → 空串 + unset 标志', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const r = resolveSeoConfig({ renderMode: 'isr', revalidate: 3600 });
    expect(r.baseUrl).toBe('');
    expect(r.baseUrlSource).toBe('unset');
  });

  it('SEO 开关不再暴露，engine 始终解析 baseUrl', () => {
    const r = resolveSeoConfig({ renderMode: 'isr', revalidate: 3600 });
    expect(r).toHaveProperty('baseUrl');
    expect(r).not.toHaveProperty('enabled');
    expect(r).not.toHaveProperty('generateSitemap');
    expect(r).not.toHaveProperty('generateRobots');
  });
});
