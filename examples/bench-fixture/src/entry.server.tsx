/**
 * Bench fixture 服务端 entry —— 最小化的 defineSiteHooks 配置
 *
 * 故意不挂 i18n endpoint / SEO 远端 / Sentry / Redis ——
 * 这些都是业务侧关注点，bench 只关心 engine 自身的中间件链路性能。
 *
 * 但仍挂上 rateLimit + experiments，因为：
 *   - rateLimit 验证 BENCH_DISABLE_RATE_LIMIT env 真的能绕过限流
 *   - experiments 验证 A/B variant 不破坏 ISR cache key 的设计
 */
import { defineSiteHooks } from '@novel-isr/engine';

export default defineSiteHooks({
  api: '', // 不远端取数据
  site: process.env.SEO_BASE_URL ?? 'http://localhost:3000',

  // 限流必须挂上 —— 验证 BENCH_DISABLE_RATE_LIMIT 真的会跳过
  // 普通模式下 200 req/min 会让 autocannon 100% 进 429（这正是要排除的污染源）
  rateLimit: { windowMs: 60_000, max: 200 },

  // A/B 实验挂上 —— 验证 variant cookie 不污染 ISR cache key
  experiments: {
    'bench-experiment': { variants: ['a', 'b'], weights: [50, 50] },
  },

  // SEO 全静态，无 endpoint —— 主测时不会触发任何 fetch
  seo: {
    '/': { title: 'Bench Home', description: 'fixture root' },
    '/about': { title: 'Bench About', description: 'fixture about' },
  },
});
