import { alternates, defineIsrConfig, withLocale, type I18nConfig } from 'isr-engine/config';
import { pageTitles } from './src/pages';

const i18n = { locales: ['en'], defaultLocale: 'en' } satisfies I18nConfig;

export default defineIsrConfig({
  renderMode: 'isr',
  revalidate: 60,

  routes: {
    '/about': 'ssg',
    '/guides/*': 'ssr',
  },

  runtime: {
    site: process.env.SITE_URL ?? 'http://localhost:3000',
    services: {
      api: undefined,
      telemetry: undefined,
    },
    redis: process.env.REDIS_URL
      ? {
          url: process.env.REDIS_URL,
          host: undefined,
          port: undefined,
          password: undefined,
          keyPrefix: 'hello-world:',
          invalidationChannel: 'hello-world:isr:invalidate',
        }
      : undefined,
    experiments: {},
    i18n: undefined,
    seo: {
      endpoint: undefined,
      fallbackLocal: undefined,
      ttl: 60_000,
      timeoutMs: 1200,
      dynamicResolvers: [
        {
          pattern: '/*',
          resolve: ({ params, pathname }) => {
            const title = pageTitles.get(params.wildcard);
            if (!title) return null;
            return {
              title,
              canonical: withLocale(pathname, i18n.defaultLocale, i18n),
              alternates: alternates(pathname, i18n),
            };
          },
        },
      ],
    },
    telemetry: false,
  },

  ssg: {
    // Explicit SSG route list. Keep [] if the app has no build-time pages.
    routes: ['/about'],
    concurrent: 4,
    requestTimeoutMs: 30_000,
    maxRetries: 3,
    retryBaseDelayMs: 200,
    failBuildThreshold: 0.05,
  },

  server: {
    port: Number(process.env.PORT ?? 3000),
    host: process.env.HOST,
    strictPort: process.env.NODE_ENV === 'production',
    ops: {
      authToken: process.env.ISR_OPS_TOKEN,
      tokenHeader: 'x-isr-admin-token',
      health: {
        enabled: true,
        public: true,
      },
      metrics: {
        enabled: process.env.ENABLE_METRICS === '1',
        public: false,
      },
      inventory: { enabled: false, public: false },
    },
  },
});
