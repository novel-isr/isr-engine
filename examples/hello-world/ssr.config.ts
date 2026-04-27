/**
 * 路由级渲染模式: 全局默认 ISR, 单条路由可覆盖成 SSG / SSR.
 * 启动时 engine 自动加载本文件; 改完不需要重启 dev (engine 内部 watch).
 */
import type { ISRConfig } from '@novel-isr/engine';

export default {
  renderMode: 'isr',
  routeOverrides: {
    '/about': 'ssg', // 完全静态: 构建时直接出 HTML 落到 dist/client/about/index.html
    '/health': 'ssr', // 永不缓存
  },
  isr: {
    revalidate: 60, // 默认 TTL 秒. 单路由可在 routeOverrides 里 { mode: 'isr', ttl: 30 } 单独配
  },
} satisfies ISRConfig;
