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
    // @ts-expect-error cache backend belongs to engine normalization; page TTL uses routes[*].ttl/isr.revalidate.
    defineIsrConfig({ renderMode: 'isr', cache: { strategy: 'memory', ttl: 3600 } });
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
