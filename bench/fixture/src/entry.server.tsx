/**
 * Bench fixture 服务端 entry —— 最小化的 defineSiteHooks 配置
 *
 * 故意不挂任何会写 Set-Cookie / 触发远端 fetch 的 hook
 * (i18n endpoint / SEO 远端 / Sentry / Redis / experiments)
 * —— bench 只测 engine 自身的中间件链路 + ISR cache 命中路径性能.
 *
 * 注：experiments 这种 hook 的正确性由 src/middlewares/__tests__/ 的单元测试
 * 覆盖, 不需要在 bench fixture 里再做集成测试 (那只会把响应弄成带 Set-Cookie,
 * 从而被 ISR 中间件按设计 skip 缓存, 污染 bench 数).
 */
import { defineSiteHooks } from '@novel-isr/engine/site-hooks';

export default defineSiteHooks({
  // SEO 全静态，无 endpoint —— 主测时不会触发任何 fetch
  seo: {
    '/': { title: 'Bench Home', description: 'fixture root' },
    '/about': { title: 'Bench About', description: 'fixture about' },
  },
});
