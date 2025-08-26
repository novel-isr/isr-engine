/**
 * Novel ISR 引擎配置示例
 * 将此文件重命名为 ssr.config.ts 或 ssr.config.js 来使用
 */
import type { NovelSSRConfig } from '@novel-isr/engine';

export default {
  // 默认渲染模式: 'isr' | 'ssg'
  mode: 'isr',

  // 服务器配置
  server: {
    port: 3000,
    host: 'localhost',
  },

  // 路由级别的渲染模式配置
  routes: {
    '/': 'ssg', // 首页使用静态生成
    '/about': 'ssg', // 关于页面使用静态生成
    '/posts/*': 'isr', // 文章列表使用 ISR
    '/post/*': 'isr', // 单篇文章使用 ISR
    '/search': 'isr', // 搜索页面使用 ISR
    '/user/*': 'isr', // 用户页面使用 ISR
  },

  // ISR 配置
  isr: {
    revalidate: 3600, // 重新验证间隔(秒) - 1小时
    backgroundRevalidation: true, // 启用后台重新验证
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
    baseUrl: 'https://your-domain.com',
  },

  // 开发模式配置
  dev: {
    verbose: true, // 详细日志
    hmr: true, // 热模块替换
  },

  // 路径配置 (可选)
  paths: {
    dist: './dist', // 构建输出目录
    server: './dist/server', // 服务端构建目录
    client: './dist/client', // 客户端构建目录
    static: './dist/static', // 静态文件目录
  },

  // 错误处理配置 (可选)
  errorHandling: {
    enableFallback: true, // 启用降级机制
    logErrors: true, // 记录错误日志
    customErrorPage: '/error', // 自定义错误页面
  },

  // 兼容性配置
  compression: true, // 启用 gzip 压缩
  verbose: true, // 详细日志 (已废弃，请使用 dev.verbose)
} satisfies NovelSSRConfig;
