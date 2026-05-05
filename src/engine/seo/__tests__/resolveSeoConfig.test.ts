/**
 * resolveSeoConfig 单元测试
 *
 * 覆盖 baseUrl 解析顺序：
 *   1. runtime.site
 *   2. SEO_BASE_URL > PUBLIC_BASE_URL > BASE_URL 环境变量
 *   3. dev 兜底
 *   4. prod 未配置 → 空串
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
    process.env.SEO_BASE_URL = 'https://from-env.com';
    const r = resolveSeoConfig({
      renderMode: 'isr',
      runtime: { site: 'https://from-runtime.com' },
    });
    expect(r.baseUrl).toBe('https://from-runtime.com');
    expect(r.baseUrlSource).toBe('runtime.site');
  });

  it('SEO_BASE_URL 优先 PUBLIC_BASE_URL', () => {
    process.env.SEO_BASE_URL = 'https://seo.com';
    process.env.PUBLIC_BASE_URL = 'https://public.com';
    const r = resolveSeoConfig({ renderMode: 'isr' });
    expect(r.baseUrl).toBe('https://seo.com');
    expect(r.baseUrlSource).toBe('env:SEO_BASE_URL');
  });

  it('PUBLIC_BASE_URL 优先 BASE_URL', () => {
    process.env.PUBLIC_BASE_URL = 'https://public.com';
    process.env.BASE_URL = 'https://base.com';
    const r = resolveSeoConfig({ renderMode: 'isr' });
    expect(r.baseUrl).toBe('https://public.com');
    expect(r.baseUrlSource).toBe('env:PUBLIC_BASE_URL');
  });

  it('BASE_URL 兜底', () => {
    process.env.BASE_URL = 'https://base.com';
    const r = resolveSeoConfig({ renderMode: 'isr' });
    expect(r.baseUrl).toBe('https://base.com');
    expect(r.baseUrlSource).toBe('env:BASE_URL');
  });

  it('dev 模式无 env 时回退到 localhost', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const r = resolveSeoConfig({
      renderMode: 'isr',
      server: { port: 4000 },
    });
    expect(r.baseUrl).toBe('http://localhost:4000');
    expect(r.baseUrlSource).toBe('dev-default');
  });

  it('dev 模式无 server.port 时用 process.env.PORT 或 3000', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const r = resolveSeoConfig({ renderMode: 'isr' });
    expect(r.baseUrl).toMatch(/^http:\/\/localhost:\d+$/);
    expect(r.baseUrlSource).toBe('dev-default');
  });

  it('prod 模式无任何配置 → 空串 + unset 标志', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const r = resolveSeoConfig({ renderMode: 'isr' });
    expect(r.baseUrl).toBe('');
    expect(r.baseUrlSource).toBe('unset');
  });

  it('enabled 默认 true', () => {
    const r = resolveSeoConfig({ renderMode: 'isr' });
    expect(r.enabled).toBe(true);
    expect(r.generateSitemap).toBe(true);
    expect(r.generateRobots).toBe(true);
  });

  it('用户可显式禁用', () => {
    const r = resolveSeoConfig({
      renderMode: 'isr',
      seo: { enabled: false },
    });
    expect(r.enabled).toBe(false);
  });
});
