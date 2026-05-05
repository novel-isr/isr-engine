/**
 * ssr.config.ts —— isr-engine production-style template
 *
 * Business apps describe product/deployment intent only:
 *   - render mode and page freshness
 *   - routes and SSG spider list
 *   - runtime services such as API/Redis/telemetry
 *   - minimal Node origin address and ops auth
 *
 * Engine-owned defaults such as HTTP listener details, port fallback, timeouts, compression,
 * sitemap/robots switches and cache backend are intentionally not public config.
 */
import type { ISRConfig } from '@novel-isr/engine';

export default {
  renderMode: 'isr',
  revalidate: 60,

  routes: {
    '/about': 'ssg',
    '/health': 'ssr',
    // '/posts/*': { mode: 'isr', ttl: 60, staleWhileRevalidate: 300 },
    // '/admin/*': 'ssr',
  },

  runtime: {
    site: process.env.SITE_URL ?? 'http://localhost:3000',
    redis: {
      url: process.env.REDIS_URL,
      keyPrefix: 'hello-world:',
    },
  },

  ssg: {
    // Explicit SSG route list. If omitted, mode=ssg entries from routes are used.
    // routes: ['/about', '/terms', '/privacy'],
    concurrent: 4,
    requestTimeoutMs: 30_000,
    maxRetries: 3,
    retryBaseDelayMs: 200,
    failBuildThreshold: 0.05,
  },

  server: {
    port: Number(process.env.PORT ?? 3000),
    host: process.env.HOST,
    ops: {
      authToken: process.env.ISR_OPS_TOKEN,
      // tokenHeader: 'x-isr-admin-token',
      metrics: {
        enabled: process.env.ENABLE_METRICS === '1',
        public: false,
      },
    },
  },
} satisfies ISRConfig;
