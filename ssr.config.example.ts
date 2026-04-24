/**
 * Novel ISR 引擎配置示例
 * 将此文件重命名为 ssr.config.ts 或 ssr.config.js 来使用
 */
// import type { ISRConfig } from '@novel-isr/engine';

import { ISRConfig } from './src/types/ISRConfig';

export default {
  /**
   * 全局默认渲染模式（用户可选的 3 种缓存策略）
   * - 'isr': 增量静态再生（推荐，自动缓存+按需更新）
   * - 'ssg': 静态站点生成（构建时生成，适合内容不常变的页面）
   * - 'ssr': 服务端渲染（每次请求都渲染，适合实时数据）
   *
   * 注：csr 不是用户级 mode，而是 server 崩溃时的内部 fallback 策略
   *     （FallbackChain 的最后一环 'csr-shell'：返回壳 HTML，浏览器自救）
   */
  renderMode: 'isr',

  /**
   * 路由级别覆盖配置（可选）
   * 仅当特定路由需要不同于全局 renderMode 时才配置
   * 支持通配符匹配：'/posts/*' 匹配所有 /posts/ 开头的路由
   * 支持动态路由：'/post/:id' 匹配 /post/123 等
   */
  routeOverrides: {
    '/': 'ssg', // 首页使用 SSG（构建时生成，访问最快）
    '/about': 'ssg', // 关于页面使用 SSG
    '/admin/*': 'ssr', // 管理后台使用 SSR（需要实时数据）
  },

  // 缓存策略
  cache: {
    strategy: 'memory', // 'memory' | 'redis' | 'filesystem'
    ttl: 3600, // 缓存生存时间(秒)
  },

  // SEO 配置
  seo: {
    enabled: true,
    generateSitemap: true,
    generateRobots: true,
  },

  // Server 相关能力：管理端点和压缩策略
  server: {
    port: 3000,
    protocol: 'http1.1',
    admin: {
      // 生产默认只公开 /health；metrics/stats/clear 默认关闭
      authToken: process.env.ISR_ADMIN_TOKEN,
      metrics: { enabled: true, public: false },
      stats: { enabled: true, public: false },
      clear: { enabled: false, public: false },
    },
    compression: {
      enabled: true,
      threshold: 1024,
      level: 6,
    },
  },
} satisfies ISRConfig;
