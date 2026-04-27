/**
 * ssr.config.ts —— isr-engine 完整配置参考
 *
 * 本文件覆盖 engine 当前所有公开字段, 用户拷过去后按需删/改即可.
 * 大多数字段都是可选, 没显式配置时 engine 用合理默认值.
 *
 * 字段分组:
 *   1. 必填:        renderMode, cache
 *   2. 路由级覆盖:  routeOverrides
 *   3. ISR / SSG:   isr, ssg
 *   4. SEO:         seo
 *   5. Server:      server (端口 / 超时 / HTTP2/3 / 管理端点 / 压缩)
 *   6. 入口 / API:  entry, apiUrl
 *   7. Dev:         dev
 *   8. 预留扩展:    tenants, sandbox (engine 当前不消费)
 */
import type { ISRConfig } from '@novel-isr/engine';

export default {
  // ─── 1. 必填 ─────────────────────────────────────────────────────
  /** 应用名（用于 csr-shell 降级页 <title> 等）*/
  appName: 'Hello, isr-engine',

  /**
   * 全局默认渲染模式
   *   'isr' ── 运行时缓存 + TTL + SWR（高读路径首选）
   *   'ssg' ── 构建期出磁盘 HTML，运行时 express.static 直发
   *   'ssr' ── 不缓存，每次请求都跑 RSC + SSR 管线
   */
  renderMode: 'isr',

  /**
   * 缓存后端（必填）
   *   strategy: 'memory' | 'redis' | 'filesystem' | 'no-cache'
   *   ttl:      秒，单条缓存条目存活时间
   */
  cache: {
    strategy: 'memory',
    ttl: 3600,
  },

  // ─── 2. 路由级覆盖 ────────────────────────────────────────────────
  /**
   * 仅当某些路由要不同于全局 renderMode 时配置
   * 支持 glob (`/posts/*`) 和动态参数 (`/post/:id`)
   * 值可以是 mode 字符串 shorthand，或对象 `{ mode, ttl, staleWhileRevalidate }`
   */
  routeOverrides: {
    '/about': 'ssg', // build-time 静态 HTML
    '/health': 'ssr', // 永不缓存
    // '/posts/*': { mode: 'isr', ttl: 60, staleWhileRevalidate: 300 },
    // '/admin/*': 'ssr',
  },

  // ─── 3. ISR / SSG ────────────────────────────────────────────────
  isr: {
    /** 默认 TTL（秒）。routeOverrides 里如果路由对象没设 ttl，用这个 */
    revalidate: 60,
    /** 后台 SWR 重渲。默认 true。关掉 = TTL 一过就阻塞回源 */
    backgroundRevalidation: true,
  },

  ssg: {
    // 显式 SSG 路由清单（可选，优先级高于 routeOverrides 中 mode=ssg 的条目）
    // routes: ['/about', '/terms', '/privacy'],

    /** spider 并发，默认 CPU-aware（min(8, max(2, cpus/2)）。也可用 ISR_SSG_CONCURRENCY env 覆盖 */
    concurrent: 4,

    /** 单页请求超时。防 hang 拖死整个 build。默认 30_000 */
    requestTimeoutMs: 30_000,

    /** 单页最大重试（timeout/network/5xx）。4xx 永不重试。默认 3 */
    maxRetries: 3,

    /** 重试初始退避 ms，指数 base*2^(N-1)。默认 200 */
    retryBaseDelayMs: 200,

    /**
     * 整体失败率阈值（0-1）。超过则 build 失败。默认 0.05（5%）
     * 设 1.0 关闭（不推荐——会 mask 真实问题）
     */
    failBuildThreshold: 0.05,
  },

  // ─── 4. SEO ──────────────────────────────────────────────────────
  /**
   * baseUrl 解析顺序：
   *   1) 此处显式 baseUrl
   *   2) env: SEO_BASE_URL → PUBLIC_BASE_URL → BASE_URL
   *   3) dev：http://localhost:${server.port||3000}
   *   4) prod 仍未拿到：报错并提示
   */
  seo: {
    enabled: true,
    generateSitemap: true,
    generateRobots: true,
    // baseUrl: 'https://your-domain.com',
  },

  // ─── 5. Server ───────────────────────────────────────────────────
  server: {
    port: 3000,
    // host: '0.0.0.0',                                // 默认 '0.0.0.0'，容器场景适配
    protocol: 'http1.1', // 'http1.1' | 'http2' | 'http3' | 'https'

    /**
     * Node origin 超时（防 slowloris / 卡死 SSR / keep-alive 耗尽）
     * 生产强烈建议在 CDN / Nginx / ALB 上配更短的前置超时
     */
    timeouts: {
      requestTimeoutMs: 60_000,
      headersTimeoutMs: 15_000,
      keepAliveTimeoutMs: 5_000,
      idleTimeoutMs: 30_000,
      shutdownTimeoutMs: 5_000,
      maxRequestsPerSocket: 1000,
    },

    /** HTTP/2。生产推荐：HTTP/2 在 CDN 终结，内部用 HTTP/1.1 */
    http2: {
      maxConcurrentStreams: 100,
      maxHeaderListSize: 16 * 1024,
    },

    /** HTTP/3 仅在真实 QUIC 实现可用时才发 Alt-Svc */
    http3: {
      enabled: false, // 生产建议在 CDN 终结 H3，origin 关掉
    },

    /**
     * 管理端点暴露策略。安全默认值：
     *   dev:  health/stats/clear/metrics 全开
     *   prod: 仅 health 公开；stats/clear/metrics 默认关
     *
     * 生产显式开启时：
     *   - public:true  会打印 warning（公开暴露）
     *   - public:false 必须同时配 authToken（Bearer 鉴权）
     */
    admin: {
      authToken: process.env.ISR_ADMIN_TOKEN,
      // tokenHeader: 'x-isr-admin-token',            // 默认 header 名
      // health:  { enabled: true,  public: true  },
      stats: { enabled: true, public: false },
      metrics: { enabled: true, public: false },
      clear: { enabled: false, public: false }, // 生产慎开
    },

    /**
     * Node 进程内压缩
     * Brotli 建议在 CDN/Edge 做（Node 端 br 会缓冲整包，破坏 RSC 流）
     */
    compression: {
      enabled: true,
      threshold: 1024,
      level: 6,
    },

    // ssl: { key: '...', cert: '...' },              // protocol 是 'https' 时填
  },

  // ─── 6. 入口 / API ───────────────────────────────────────────────
  /** 入口文件路径覆盖（可选）。默认 engine 找 src/entry.server.tsx + src/entry.tsx */
  // entry: {
  //   server: 'src/entry.server.tsx',
  //   client: 'src/entry.tsx',
  // },

  /** Server Component / Action 从此 URL 派生数据源（可选） */
  // apiUrl: process.env.API_BASE_URL ?? '',

  // ─── 7. Dev ─────────────────────────────────────────────────────
  dev: {
    verbose: false,
    hmr: true, // 默认 true。关掉只在调 RSC bundling 时才需要
  },

  // ─── 8. 预留扩展（engine 当前不消费）─────────────────────────────
  /**
   * 多租户。启用后 engine 给缓存 key 自动叠加 tenantId 前缀
   */
  // tenants: {
  //   enabled: false,
  //   resolveTenant: req => req.headers['x-tenant-id'] as string | null,
  //   knownTenants: ['t1', 't2'],
  // },

  /**
   * 沙箱。给"必须隔离执行不可信代码"的场景：CMS 模板 / 用户插件 / 表达式引擎
   * RSC 自身不需要（项目代码全可信），这是给上层业务用的
   */
  // sandbox: {
  //   enabled: false,
  //   strategy: 'node-vm',          // 'none' | 'node-vm' | 'isolate' | 'worker'
  //   memoryLimitMb: 64,
  //   timeoutMs: 1000,
  //   allowedGlobals: ['Date', 'Math', 'JSON'],
  // },
} satisfies ISRConfig;
