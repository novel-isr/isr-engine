/**
 * 服务端 entry —— defineSiteHooks 是 isr-engine 唯一必填的 server 配置点.
 *
 * 这里你可以挂:
 *   - i18n endpoint     (从远端 / admin-server 拉文案)
 *   - SEO endpoint      (运营改 meta 不发版)
 *   - Sentry / Datadog  (createSentryServerHooks 等 adapter)
 *   - rateLimit         (per-IP token bucket)
 *   - experiments       (A/B variant, cookie-sticky)
 *
 * 这个 hello-world 只配静态 SEO + site URL, 极简.
 */
import { defineSiteHooks } from '@novel-isr/engine';

export default defineSiteHooks({
  api: '', // 不远端取数据
  site: process.env.SEO_BASE_URL ?? 'http://localhost:3000',
  seo: {
    '/': { title: 'Hello, isr-engine', description: 'Minimal example' },
    '/about': { title: 'About', description: 'Static page' },
  },
});
