import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, expectTypeOf, it } from 'vitest';

import { defineIsrConfig, defineRuntimeConfig } from '../defineConfig';

describe('defineConfig helpers', () => {
  it('defineIsrConfig 返回原对象并保留 ISRConfig 类型约束', () => {
    const config = {
      renderMode: 'isr',
      runtime: {
        telemetry: {
          events: { endpoint: '/events' },
          errors: { endpoint: '/errors' },
        },
      },
    } as const;

    const defined = defineIsrConfig(config);

    expect(defined).toBe(config);
    expectTypeOf(defined.renderMode).toEqualTypeOf<'isr'>();
    expectTypeOf(defined.runtime.telemetry.events.endpoint).toEqualTypeOf<'/events'>();
  });

  it('defineRuntimeConfig 让业务拆分 runtime 时不需要 NonNullable 类型技巧', () => {
    const runtime = defineRuntimeConfig({
      site: 'https://novel.example.com',
      telemetry: {
        errors: false,
        integrations: {
          sentry: {
            enabled: true,
            dsn: 'https://key@sentry.example/1',
          },
        },
      },
    });

    expect(runtime.site).toBe('https://novel.example.com');
    expectTypeOf(runtime.telemetry.integrations.sentry.enabled).toEqualTypeOf<true>();
  });

  it('defineIsrConfig 不再暴露业务级 cache 配置', () => {
    // @ts-expect-error cache backend belongs to engine normalization; page TTL uses routes[*].ttl/revalidate.
    defineIsrConfig({ renderMode: 'isr', cache: { strategy: 'memory', ttl: 3600 } });
  });

  it('defineIsrConfig 不再暴露顶层 SEO 开关和旧 isr.revalidate', () => {
    // @ts-expect-error SEO sitemap/robots are core engine capabilities, not business toggles.
    defineIsrConfig({ renderMode: 'isr', seo: { enabled: false } });

    // @ts-expect-error default page TTL is now top-level revalidate.
    defineIsrConfig({ renderMode: 'isr', isr: { revalidate: 3600 } });
  });

  it('defineIsrConfig 只暴露最小 Node origin server 配置', () => {
    defineIsrConfig({
      renderMode: 'isr',
      server: {
        port: 3000,
        host: '127.0.0.1',
        ops: {
          authToken: 'secret',
          tokenHeader: 'x-custom-token',
          metrics: { enabled: true, public: false },
        },
      },
    });

    // @ts-expect-error protocol/TLS belongs to CDN or reverse proxy, not app config.
    defineIsrConfig({ renderMode: 'isr', server: { port: 3000, protocol: 'https' } });

    // @ts-expect-error strict port is an internal engine default.
    defineIsrConfig({ renderMode: 'isr', server: { port: 3000, strictPort: true } });

    // @ts-expect-error HTTP timeouts are engine-owned hardening defaults.
    defineIsrConfig({ renderMode: 'isr', server: { port: 3000, timeouts: {} } });

    // @ts-expect-error compression is an internal origin fallback, not business config.
    defineIsrConfig({ renderMode: 'isr', server: { port: 3000, compression: {} } });

    // @ts-expect-error admin/clear/stats were removed from the public API; use server.ops.
    defineIsrConfig({ renderMode: 'isr', server: { port: 3000, admin: {} } });
  });

  it('package exposes a lightweight config subpath for ssr.config.ts', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8')
    ) as {
      exports?: Record<string, { import?: string; require?: string; types?: string }>;
    };

    expect(pkg.exports?.['./config']).toEqual({
      types: './dist/config/defineConfig.d.ts',
      import: './dist/config/defineConfig.js',
      require: './dist/config/defineConfig.cjs',
    });
  });
});
