/**
 * Bench fixture 路由配置 —— 覆盖 ISR 引擎的所有关键路径
 *
 * 路由策略：
 *   /              → ISR (TTL=60s, SWR=300s)  → 测 HIT/MISS/STALE 全链路
 *   /about         → SSG                     → 测 express.static 直发
 *   /books/:id     → ISR (TTL=120s, SWR=600s) → 测动态参数 + cacheTag
 *   /api/health    → SSR                     → 测无缓存路径
 *
 * 这套路由是有意设计的：bench 测出的 QPS 同时反映 isr / ssg / ssr 三种
 * 渲染路径的性能，避免单点偏差。
 */
import type { ISRConfig } from '@novel-isr/engine';

const config: ISRConfig = {
  renderMode: 'isr',
  cache: {
    strategy: 'memory',
    ttl: 3600,
  },
  routeOverrides: {
    '/': { mode: 'isr', ttl: 60, staleWhileRevalidate: 300 },
    '/about': { mode: 'ssg' },
    '/books/:id': { mode: 'isr', ttl: 120, staleWhileRevalidate: 600 },
    '/api/health': { mode: 'ssr' },
  },
  ssg: {
    routes: ['/about'],
  },
  isr: {
    revalidate: 60,
  },
  seo: {
    enabled: false, // bench 不需要 sitemap
  },
  server: {
    port: 3000,
    timeouts: {
      // Bench reuses a small number of hot keep-alive sockets. Keep the
      // engine's production default, but prevent fixture runs from measuring
      // Node's max-requests-per-socket guard instead of ISR/SSG/SSR throughput.
      maxRequestsPerSocket: 1_000_000,
    },
  },
};

export default config;
