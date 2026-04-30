/**
 * ISR 引擎类型定义
 *
 */

/**
 * 渲染模式（用户级）—— 路由可选的**三种真实**缓存策略
 *
 *   isr  ── 运行时入缓存 + TTL；过期后 SWR 回放旧 + 后台重渲
 *   ssr  ── 不入缓存；每次请求都跑 RSC + SSR 管线
 *   ssg  ── 构建期 spider 预生成磁盘 HTML；运行时 express.static 直发
 *
 * **csr 不在用户级**——因为"绕过 RSC 跑纯客户端"在 plugin-rsc 模型下不是一个
 * 选择性的渲染策略，而是 server 跑不动时的**降级兜底**。详见下方 InternalStrategyType。
 */
export type RenderModeType = 'ssg' | 'isr' | 'ssr';

/**
 * 内部降级策略（fallback chain 的元素，不向用户暴露选择）
 *
 *   static       ── 直接 serve 构建期物化的 dist/client/<path>/index.html
 *   cached       ── 命中 ISR LRU 内存缓存
 *   regenerate   ── 缓存过期 / 不存在时重新跑管线，结果入缓存
 *   server       ── 实时跑 RSC + SSR 管线（不入缓存，等价 SSR）
 *   csr-shell    ── server 自身崩溃时的最后兜底：返回最小壳 HTML（无 Flight，
 *                   带 self.__NO_HYDRATE=1），浏览器走 createRoot 从零渲染并
 *                   通过 _.rsc 端点尝试自救拉数据 —— 体验降级但不是 5xx 白屏
 */
export type InternalStrategyType = 'static' | 'cached' | 'regenerate' | 'server' | 'csr-shell';
export type CacheStrategyType = 'no-cache' | 'memory' | 'redis' | 'filesystem';

/**
 * 路由级规则（对象形式）—— 允许精细控制 TTL 与 stale-while-revalidate 窗口
 */
export interface RouteRuleObject {
  mode: RenderModeType;
  /** TTL（秒），覆盖全局 isr.revalidate 默认值 */
  ttl?: number;
  /** stale-while-revalidate 窗口（秒）—— TTL 过期后继续回放旧内容的时长 */
  staleWhileRevalidate?: number;
}

/**
 * 路由规则 —— 字符串 shorthand 或完整对象
 *   'isr'                                        等价于 { mode: 'isr', ttl: 默认, swr: 默认 }
 *   { mode: 'isr', ttl: 60, staleWhileRevalidate: 300 }
 */
export type RouteRule = RenderModeType | RouteRuleObject;

export interface RuntimeRedisConfig {
  /** 完整 Redis URL（redis://[:pass@]host:port/db），优先级高于 host/port */
  url?: string;
  host?: string;
  port?: number;
  password?: string;
  /** 页面缓存 key 前缀，默认由 cache layer 使用 isr: */
  keyPrefix?: string;
  /** 跨实例 revalidate 广播频道 */
  invalidationChannel?: string;
}

export interface RuntimeSentryConfig {
  dsn: string;
  tracesSampleRate?: number;
  environment?: string;
}

export interface RuntimeExperimentConfig {
  variants: readonly string[];
  weights?: readonly number[];
}

export interface RuntimeRateLimitConfig {
  /**
   * 限流状态存储。
   * - memory：进程内 LRU，默认值；重启清空，不跨 pod 共享。
   * - redis：使用 runtime.redis / REDIS_URL / REDIS_HOST 创建 Redis store；缺配置时回退 memory 并告警。
   * - auto：检测到 Redis 配置就用 redis，否则 memory。
   */
  store?: 'memory' | 'redis' | 'auto';
  /** 固定窗口长度（毫秒）；默认 60_000 */
  windowMs?: number;
  /** 每个 key 在窗口内允许的最大请求数；默认 100 */
  max?: number;
  /** memory store 最大 key 数；默认 10_000 */
  lruMax?: number;
  /**
   * 是否信任上游代理头来提取真实客户端 IP。
   * 只有部署在可信 CDN/LB/Nginx 后面时才开启，否则客户端可伪造 X-Forwarded-For。
   */
  trustProxy?: boolean;
  /** 是否发送 RateLimit-* / Retry-After 响应头；默认 true */
  sendHeaders?: boolean;
  /** Redis rate-limit key 前缀；默认 `${runtime.redis.keyPrefix ?? 'isr:'}rate-limit:` */
  keyPrefix?: string;
}

export interface RuntimeI18nConfig {
  /** 支持的 locale 列表，用于 URL locale 前缀解析和请求协商 */
  locales?: readonly string[];
  /** 默认 locale；不配置时取 locales[0] */
  defaultLocale?: string;
  /** 默认 locale 是否带 URL 前缀 */
  prefixDefault?: boolean;
  /** 远端字典端点；相对路径会拼到 services.i18n/api 上 */
  endpoint?: string;
  /** 本地兜底字典；配置 API 不可用时使用 */
  fallbackLocal?: Record<string, Record<string, unknown>>;
  /** 字典缓存 TTL（毫秒） */
  ttl?: number;
  /** 远端请求超时（毫秒） */
  timeoutMs?: number;
  /** 响应头 / dev inspector 里显示的远端来源名 */
  remoteSource?: string;
  /** 响应头 / dev inspector 里显示的本地兜底来源名 */
  fallbackSource?: string;
}

export interface RuntimeSeoConfig {
  /** 远端 SEO 端点；支持 {pathname} */
  endpoint?: string;
  /** 本地兜底 SEO 路由表；配置 API 不可用时使用 */
  fallbackLocal?: readonly Record<string, unknown>[];
  /** SEO 元数据缓存 TTL（毫秒） */
  ttl?: number;
  /** 远端请求超时（毫秒） */
  timeoutMs?: number;
}

export interface RuntimeServicesConfig {
  /** 默认后端 API origin；业务数据、admin 配置、mock fixture 未拆服务时都走这里 */
  api?: string;
  /** i18n 字典下发 origin；不配置时回退到 api */
  i18n?: string;
  /** SEO 配置下发 origin；不配置时回退到 api */
  seo?: string;
}

/**
 * 平台运行时配置。
 *
 * 第一性原则：
 *   - 启动期 / 部署期 / 平台级能力放 ssr.config.ts 的 runtime
 *   - 请求期业务逻辑仍放 entry.server.tsx hooks
 */
export interface RuntimeConfig {
  /**
   * 旧的单 API base。新项目优先使用 services.api；
   * 保留该字段只作为低层 fallback。
   */
  api?: string;
  /** 站点公网 base URL，用于 SEO canonical / sitemap / robots */
  site?: string;
  /** 按职责拆开的后端服务 origin */
  services?: RuntimeServicesConfig;
  /** 分布式 ISR 缓存与跨实例失效广播 */
  redis?: RuntimeRedisConfig;
  /** 服务端错误监控 */
  sentry?: RuntimeSentryConfig;
  /**
   * 站点入口限流。
   *
   * 当前 runtime.rateLimit 默认接入 engine memory store。需要分布式限流时显式
   * 设置 rateLimit.store='redis' 或 'auto'，并配置 runtime.redis / REDIS_URL。
   * 多实例生产环境仍应优先使用 CDN/WAF/API Gateway 做第一层限流。
   */
  rateLimit?: RuntimeRateLimitConfig;
  /** A/B testing / experimentation 定义，供 getVariant() 在 Server Component 中读取 */
  experiments?: Record<string, RuntimeExperimentConfig>;
  /** i18n 字典源配置；请求期加载由 engine 默认 SiteHooks 消费 */
  i18n?: RuntimeI18nConfig;
  /** 页面 SEO 元数据源配置；不要和 ISRConfig 顶层 seo.baseUrl 混淆 */
  seo?: RuntimeSeoConfig;
}

export const RenderModes = {
  SSG: 'ssg' as const, // 构建期预生成磁盘文件
  ISR: 'isr' as const, // 运行时缓存 + TTL + SWR
  SSR: 'ssr' as const, // 不缓存，每次实时跑管线
} as const;

// 内部渲染策略 (不向用户暴露)
export const InternalStrategies = {
  STATIC: 'static' as const, // 服务预构建文件（SSG）
  CACHED: 'cached' as const, // 从 ISR 缓存服务
  REGENERATE: 'regenerate' as const, // ISR 重新生成
  SERVER: 'server' as const, // 实时跑管线（SSR / 中间兜底）
  CSR_SHELL: 'csr-shell' as const, // 最后兜底：返回壳 HTML，浏览器自救
} as const;

// 缓存策略
export const CacheStrategies = {
  NO_CACHE: 'no-cache' as const,
  MEMORY: 'memory' as const,
  REDIS: 'redis' as const,
  FILE_SYSTEM: 'filesystem' as const,
} as const;

/**
 * 自动降级链 —— 路由 mode 决定优先尝试哪些策略，失败逐级往下
 * 所有链路最末端都是 'csr-shell'，保证 server 完全崩溃时浏览器仍能拿到壳 HTML
 *
 * 例：mode=isr 的请求处理顺序
 *   1. cached     ── 命中 LRU → 直接回放
 *   2. regenerate ── miss / stale → 跑管线 + 入缓存
 *   3. server     ── 缓存层崩溃 → 实时跑管线（不入缓存）
 *   4. csr-shell  ── 管线本身抛异常 → 返回壳 HTML，浏览器接管
 */
export const FallbackChain: Record<RenderModeType, InternalStrategyType[]> = {
  isr: ['cached', 'regenerate', 'server', 'csr-shell'],
  ssg: ['static', 'regenerate', 'server', 'csr-shell'],
  ssr: ['server', 'csr-shell'],
};

// 配置接口定义
// 主配置接口
export interface ISRConfig {
  /** 全局默认渲染模式 */
  renderMode: RenderModeType;

  /**
   * 路由级别覆盖配置（可选）
   * 仅当需要对特定路由使用不同于全局 renderMode 时才配置
   * 支持通配符匹配：'/posts/*' 匹配所有 /posts/ 开头的路由
   * 支持动态路由：'/post/:id' 匹配 /post/123 等
   *
   * @example
   * ```ts
   * routes: {
   *   '/': 'ssg',           // 首页使用 SSG
   *   '/admin/*': 'ssr',    // 管理后台使用 SSR
   * }
   * ```
   */
  routes?: Record<string, RouteRule>;

  /**
   * 平台运行时配置。
   *
   * 这些是稳定的部署/启动配置，成熟项目应放在 ssr.config.ts，而不是散落在
   * entry.server.tsx 里。entry.server.tsx 只负责如何在请求期使用这些配置。
   */
  runtime?: RuntimeConfig;

  cache: {
    strategy: CacheStrategyType;
    ttl: number;
  };
  /**
   * SEO 配置 —— 可选；缺省时 engine 启用默认行为：
   *   - enabled = true（dev/prod 都自动注入 sitemap.xml / robots.txt 路由）
   *   - baseUrl 解析顺序：
   *       1) 此处显式 baseUrl
   *       2) 环境变量 SEO_BASE_URL → PUBLIC_BASE_URL → BASE_URL
   *       3) dev 模式：http://localhost:${server.port||3000}
   *       4) prod 模式且仍未拿到：保留空串（生成 sitemap 时报错并提示）
   */
  seo?: {
    enabled?: boolean;
    generateSitemap?: boolean;
    generateRobots?: boolean;
    baseUrl?: string;
  };
  server?: {
    ssl?: {
      key: string;
      cert: string;
    };
    port: number;
    host?: string;
    /**
     * false 时端口占用自动尝试下一个端口。生产建议保持 true；dev 默认 false。
     */
    strictPort?: boolean;
    /**
     * Origin 协议。HTTP/2/HTTP/3 应该在 CDN / Nginx / Caddy / ALB 终结，
     * Node origin 只对接 HTTP/1.1（或 HTTPS 直连场景）。
     */
    protocol?: 'http1.1' | 'https';
    /**
     * Node server timeout limits. These protect the origin from slowloris,
     * stuck SSR/RSC requests, and long-lived keep-alive exhaustion. Put CDN /
     * reverse proxy timeouts in front as the first line of defense.
     */
    timeouts?: {
      requestTimeoutMs?: number;
      headersTimeoutMs?: number;
      keepAliveTimeoutMs?: number;
      idleTimeoutMs?: number;
      shutdownTimeoutMs?: number;
      maxRequestsPerSocket?: number;
    };
    /**
     * 管理端点（/health /metrics /__isr/*）暴露策略
     *
     * 安全默认值：
     *   - development：health/stats/clear/metrics 全开，便于本地调试
     *   - production：仅 health 默认公开；stats/clear/metrics 默认关闭
     *
     * 生产若显式开启 stats/clear/metrics：
     *   - `public: true` 代表公开暴露，会打印 warning
     *   - `public: false` 时要求同时配置 `authToken`
     */
    admin?: {
      /** 共享管理口令；接受 `Authorization: Bearer <token>` 或自定义 header */
      authToken?: string;
      /** 自定义 header 名，默认 `x-isr-admin-token` */
      tokenHeader?: string;
      health?: {
        enabled?: boolean;
        public?: boolean;
      };
      stats?: {
        enabled?: boolean;
        public?: boolean;
      };
      clear?: {
        enabled?: boolean;
        public?: boolean;
      };
      metrics?: {
        enabled?: boolean;
        public?: boolean;
      };
    };
    /**
     * Node 进程内压缩策略
     *
     * 默认启用 streaming-safe gzip；Brotli 建议放到 CDN / Nginx / Edge 层做，
     * 避免 Node 端为追求 br 而缓冲整包，破坏 SSR/RSC 流式输出。
     */
    compression?: {
      enabled?: boolean;
      threshold?: number;
      level?: number;
    };
  };

  /** ISR 相关配置 */
  isr?: {
    /** 默认 TTL（秒）—— 未在 routes 显式声明时使用 */
    revalidate?: number;
  };

  /** SSG 预生成配置 */
  ssg?: {
    /** 显式 SSG 路由列表（可选，优先级高于 routes 中 mode=ssg 的条目） */
    routes?: string[] | (() => Promise<string[]>);
    /** 并发度，默认 3 */
    concurrent?: number;
    /** 单页请求超时毫秒，默认 30_000；防 hang 拖死整个 build */
    requestTimeoutMs?: number;
    /** 单页最大重试次数（不含首次），默认 3；只重试 timeout/network/5xx，不重试 4xx */
    maxRetries?: number;
    /** 重试初始退避毫秒，默认 200；指数退避 = base * 2^(N-1) */
    retryBaseDelayMs?: number;
    /**
     * 整体失败率阈值（0-1），默认 0.05（5%）；超过则 build 失败。
     * 设 1.0 关闭（不推荐——会 mask 真实问题）。设 0 = 任何失败都 fail build。
     */
    failBuildThreshold?: number;
  };
}
