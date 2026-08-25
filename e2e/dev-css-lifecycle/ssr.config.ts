import type { ISRConfig } from '@novel-isr/engine';

export default {
  renderMode: 'ssr',
  revalidate: 60,
  routes: {
    '/': 'ssr',
    '/article': 'ssr',
    '/server-only': 'ssr',
  },
  runtime: {
    site: 'http://127.0.0.1:43137',
    services: { api: undefined, telemetry: undefined },
    redis: undefined,
    experiments: {},
    i18n: undefined,
    seo: undefined,
    telemetry: false,
  },
  ssg: {
    routes: [],
    concurrent: 1,
    requestTimeoutMs: 30_000,
    maxRetries: 1,
    retryBaseDelayMs: 50,
    failBuildThreshold: 0,
  },
  server: {
    port: Number(process.env.PLAYWRIGHT_DEV_PORT ?? process.env.PORT ?? 43137),
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
