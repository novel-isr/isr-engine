import { describe, expect, expectTypeOf, it } from 'vitest';

import { defineIsrConfig, defineRuntimeConfig } from '../defineConfig';

describe('defineConfig helpers', () => {
  it('defineIsrConfig 返回原对象并保留 ISRConfig 类型约束', () => {
    const config = {
      renderMode: 'isr',
      cache: { strategy: 'memory', ttl: 3600 },
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
});
