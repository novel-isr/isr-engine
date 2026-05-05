/**
 * 服务端 entry —— defineSiteHooks 是 isr-engine 唯一必填的 server 配置点.
 *
 * 这里你可以挂请求期逻辑:
 *   - beforeRequest：解析 userId / tenantId / requestSegment
 *   - onError：补充业务日志或审计
 *   - seo/intl：只有在不使用 ssr.config.ts runtime 默认 loader 时才自定义
 *
 * 部署地址、Redis、限流、telemetry、A/B 定义都放 ssr.config.ts runtime。
 */
import { defineSiteHooks } from '@novel-isr/engine/site-hooks';

export default defineSiteHooks({
  seo: {
    '/': { title: 'Hello, isr-engine', description: 'Minimal example' },
    '/about': { title: 'About', description: 'Static page' },
  },
});
