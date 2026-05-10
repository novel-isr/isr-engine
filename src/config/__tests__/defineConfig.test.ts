import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, expectTypeOf, it } from 'vitest';

import { defineIsrConfig, defineRuntimeConfig } from '../defineConfig';

const baseConfig = {
  renderMode: 'isr',
  revalidate: 3600,
  routes: {},
  runtime: {
    site: undefined,
    services: { api: undefined, telemetry: undefined },
    redis: undefined,
    experiments: {},
    i18n: undefined,
    seo: undefined,

    telemetry: false,
  },
  server: {
    port: 3000,
    host: '127.0.0.1',
    strictPort: true,
    ops: {
      authToken: undefined,
      tokenHeader: 'x-isr-admin-token',
      health: { enabled: true, public: true },
      metrics: { enabled: false, public: false },
    },
  },
  ssg: {
    routes: [],
    concurrent: 3,
    requestTimeoutMs: 30_000,
    maxRetries: 3,
    retryBaseDelayMs: 200,
    failBuildThreshold: 0.05,
  },
} as const;

describe('defineConfig helpers', () => {
  it('defineIsrConfig 返回原对象并保留 ISRConfig 类型约束', () => {
    const config = {
      ...baseConfig,
      runtime: {
        ...baseConfig.runtime,
        telemetry: {
          app: undefined,
          release: undefined,
          environment: undefined,
          includeQueryString: false,
          events: {
            endpoint: '/events',
            sampleRate: 1,
            trackInitialPage: true,
          },
          errors: {
            endpoint: '/errors',
            sampleRate: 1,
            captureResourceErrors: true,
          },
          webVitals: false,
          exporters: [],
          integrations: { sentry: undefined },
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
      services: { api: undefined, telemetry: undefined },
      redis: undefined,
      experiments: {},
      i18n: undefined,
      seo: undefined,

      telemetry: {
        app: undefined,
        release: undefined,
        environment: undefined,
        includeQueryString: false,
        events: false,
        errors: false,
        webVitals: false,
        exporters: [],
        integrations: {
          sentry: {
            enabled: true,
            dsn: 'https://key@sentry.example/1',
            tracesSampleRate: undefined,
            environment: undefined,
            release: undefined,
          },
        },
      },
    });

    expect(runtime.site).toBe('https://novel.example.com');
    expectTypeOf(runtime.telemetry.integrations.sentry.enabled).toEqualTypeOf<true>();
  });

  it('defineIsrConfig 不再暴露业务级 cache 配置', () => {
    defineIsrConfig({
      ...baseConfig,
      // @ts-expect-error cache backend belongs to engine normalization; page TTL uses routes[*].ttl/revalidate.
      cache: { strategy: 'memory', ttl: 3600 },
    });
  });

  it('defineIsrConfig 不再暴露顶层 SEO 开关和旧 isr.revalidate', () => {
    // @ts-expect-error SEO sitemap/robots are core engine capabilities, not business toggles.
    defineIsrConfig({ ...baseConfig, seo: { enabled: false } });

    // @ts-expect-error default page TTL is now top-level revalidate.
    defineIsrConfig({ ...baseConfig, isr: { revalidate: 3600 } });
  });

  it('defineIsrConfig 只暴露最小 Node origin server 配置', () => {
    defineIsrConfig({
      ...baseConfig,
      server: {
        port: 3000,
        host: '127.0.0.1',
        strictPort: true,
        ops: {
          authToken: 'secret',
          tokenHeader: 'x-custom-token',
          health: { enabled: true, public: true },
          metrics: { enabled: true, public: false },
        },
      },
    });

    defineIsrConfig({
      ...baseConfig,
      server: {
        port: 3000,
        host: '127.0.0.1',
        strictPort: true,
        ops: baseConfig.server.ops,
        // @ts-expect-error protocol/TLS belongs to CDN or reverse proxy, not app config.
        protocol: 'https',
      },
    });

    // @ts-expect-error HTTP timeouts are engine-owned hardening defaults.
    defineIsrConfig({ ...baseConfig, server: { ...baseConfig.server, timeouts: {} } });

    defineIsrConfig({
      ...baseConfig,
      server: {
        ...baseConfig.server,
        // @ts-expect-error compression is an internal origin fallback, not business config.
        compression: {},
      },
    });

    // @ts-expect-error admin/clear/stats were removed from the public API; use server.ops.
    defineIsrConfig({ ...baseConfig, server: { ...baseConfig.server, admin: {} } });
  });

  it('defineIsrConfig 不再暴露 i18n/seo 独立服务源', () => {
    // @ts-expect-error runtime.api legacy fallback was removed; use runtime.services.api.
    defineRuntimeConfig({ api: 'https://api.example.com' });

    defineRuntimeConfig({
      services: {
        api: 'https://api.example.com',
        // @ts-expect-error i18n/seo 配置下发统一复用 runtime.services.api。
        i18n: 'https://i18n.example.com',
      },
    });

    defineRuntimeConfig({
      services: {
        api: 'https://api.example.com',
        // @ts-expect-error i18n/seo 配置下发统一复用 runtime.services.api。
        seo: 'https://seo.example.com',
      },
    });
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
