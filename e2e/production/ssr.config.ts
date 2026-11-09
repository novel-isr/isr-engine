import type { ISRConfig } from '@novel-isr/engine';

export default {
  renderMode: 'ssr',
  revalidate: 60,
  routes: {
    '/': 'ssr',
    '/static': 'ssg',
    '/article': 'ssr',
    '/cached': 'isr',
    '/regenerated': { mode: 'ssg', ttl: 1, staleWhileRevalidate: 30 },
  },
  runtime: {
    site: 'http://127.0.0.1:43138',
    services: { api: undefined, telemetry: undefined },
    redis: process.env.PLAYWRIGHT_REDIS_URL
      ? {
          url: process.env.PLAYWRIGHT_REDIS_URL,
          host: undefined,
          port: undefined,
          password: undefined,
          keyPrefix: 'e2e-production:',
          invalidationChannel: undefined,
        }
      : undefined,
    experiments: {},
    i18n: undefined,
    seo: undefined,
    telemetry: false,
  },
  ssg: {
    routes: ['/static', '/regenerated'],
    concurrent: 1,
    requestTimeoutMs: 30_000,
    maxRetries: 1,
    retryBaseDelayMs: 50,
    failBuildThreshold: 0,
  },
  server: {
    port: Number(process.env.PLAYWRIGHT_PRODUCTION_PORT ?? process.env.PORT ?? 43138),
    host: '127.0.0.1',
    strictPort: true,
    ops: {
      authToken: undefined,
      tokenHeader: 'x-isr-admin-token',
      health: { enabled: true, public: true },
      metrics: { enabled: false, public: false },
      inventory: { enabled: false, public: false },
    },
  },
} satisfies ISRConfig;
