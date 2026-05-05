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
  /** TTL（秒），覆盖全局 revalidate 默认值 */
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

export interface RuntimeExperimentConfig {
  variants: readonly string[];
  weights?: readonly number[];
}

export interface RuntimeRateLimitConfig {
  /**
   * 限流状态存储。**默认 'auto'：开箱即用**——
   * 已配置 runtime.redis.url/host 就自动用 Redis，
   * 否则进程内 memory。消费方一般无需显式设置 store。
   *
   * - 'auto'（默认）：检测到 Redis 配置 → redis backend；否则 memory backend。
   * - 'memory'：强制进程内 LRU。重启清空，不跨 pod 共享。本地 burn-in / 单实例适用。
   * - 'redis'：强制使用 runtime.redis 配置的 Redis；缺配置时 warn + 回落 memory（fail-open）。
   *
   * 非法值（拼错 / 类型错）engine 会 warn 一次并按 'auto' 处理，不静默吞。
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
  /**
   * 精确跳过的请求 path。engine 默认已跳过 /health、/metrics、OPTIONS、静态资源扩展名；
   * 业务只在确有内部探针或自定义资源路径时补充。
   */
  skipPaths?: readonly string[];
  /** 按 path 前缀跳过限流，例如 ['/internal/static/'] */
  skipPathPrefixes?: readonly string[];
  /** 额外静态资源扩展名，例如 ['.wasm']；默认已覆盖 js/css/image/font/map 等常见资源 */
  skipExtensions?: readonly string[];
}

export interface RuntimeI18nConfig {
  /** 支持的 locale 列表，用于 URL locale 前缀解析和请求协商 */
  locales?: readonly string[];
  /** 默认 locale；不配置时取 locales[0] */
  defaultLocale?: string;
  /** 默认 locale 是否带 URL 前缀 */
  prefixDefault?: boolean;
  /** 远端字典端点；相对路径会拼到 services.api 上 */
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
  /** 默认后端 API origin；业务数据、配置中心、mock fixture 都走这里 */
  api?: string;
  /** telemetry 上报 origin；不配置时回退到 api，同源部署可留空 */
  telemetry?: string;
}

export interface RuntimeTelemetryEndpointOptions {
  /** 远端上报地址；相对路径会拼到 services.telemetry/api 上 */
  endpoint?: string;
  /** 采样率，0..1；默认 1 */
  sampleRate?: number;
  /** 批量上报条数；analytics 默认 20，error-reporting 默认 10 */
  batchSize?: number;
  /** 定时 flush 间隔，毫秒；默认 3000 */
  flushIntervalMs?: number;
  /** 失败后内存队列上限；analytics 默认 500，error-reporting 默认 200 */
  maxQueueSize?: number;
  /** 失败重试初始退避，毫秒；默认 1000 */
  retryBaseDelayMs?: number;
  /** 失败重试最大退避，毫秒；默认 30000 */
  retryMaxDelayMs?: number;
}

export interface RuntimeTelemetryEventsConfig extends RuntimeTelemetryEndpointOptions {
  /** 是否自动上报首屏 page_view；默认 true */
  trackInitialPage?: boolean;
}

export interface RuntimeTelemetryErrorsConfig extends RuntimeTelemetryEndpointOptions {
  /** 是否采集 script/link/img 等资源加载失败；默认 true */
  captureResourceErrors?: boolean;
}

export interface RuntimeTelemetryWebVitalsConfig {
  /** 是否自动采集 Web Vitals；默认 true */
  enabled?: boolean;
}

export interface RuntimeTelemetrySentryIntegrationConfig {
  /** 是否启用 Sentry integration；默认 false，避免仅配置环境变量就隐式接入第三方平台 */
  enabled?: boolean;
  /** Sentry DSN；enabled=true 但不配置时 engine 会跳过 adapter 并记录 warn */
  dsn?: string;
  tracesSampleRate?: number;
  environment?: string;
  release?: string;
}

export interface RuntimeTelemetryDatadogExporterConfig {
  type: 'datadog';
  name?: string;
  required?: boolean;
  service?: string;
}

export interface RuntimeTelemetryOtelExporterConfig {
  type: 'otel';
  name?: string;
  required?: boolean;
  endpoint?: string;
  serviceName?: string;
}

export type RuntimeTelemetryExporterConfig =
  | RuntimeTelemetryDatadogExporterConfig
  | RuntimeTelemetryOtelExporterConfig;

export interface RuntimeTelemetryIntegrationsConfig {
  /**
   * Sentry 是完整第三方监控平台 integration，不是普通 HTTP endpoint。
   *
   * 语义：
   * - events/errors endpoint 是第一方 HTTP 上报的唯一真值源。
   * - integration 和 exporters 可同时启用，用于迁移、双写或第一方数据仓库 + Sentry 排障并存。
   * - 如果只想二选一，显式关闭不需要的 exporter 或 integration；engine 不做隐式替换。
   *
   * SDK / issue grouping / source map / release health / performance 都在这一层。
   */
  sentry?: RuntimeTelemetrySentryIntegrationConfig;
}

export interface RuntimeTelemetryConfig {
  /** 应用名；不配置时读取 package.json name */
  app?: string;
  /** 发布版本，用于错误归因和发布影响分析 */
  release?: string;
  /** 当前环境：development/staging/production */
  environment?: string;
  /** 是否把 query string 纳入 URL；默认 false，避免采集敏感参数 */
  includeQueryString?: boolean;
  /** 前端事件/PV 埋点配置；false 表示关闭 events */
  events?: false | RuntimeTelemetryEventsConfig;
  /** 前端错误上报配置；false 表示关闭 errors */
  errors?: false | RuntimeTelemetryErrorsConfig;
  /** Web Vitals 配置；false 表示关闭性能指标 */
  webVitals?: false | RuntimeTelemetryWebVitalsConfig;
  /**
   * 额外 collector 出口。第一方 HTTP 上报不放这里，唯一真值源是
   * events.endpoint / errors.endpoint，避免同一个地址配置两遍。
   * Sentry 这类完整 SDK 平台放 integrations，不降级为普通 exporter。
   */
  exporters?: readonly RuntimeTelemetryExporterConfig[];
  /** 第三方平台集成，和第一方 endpoint telemetry 并列挂在 telemetry 下面 */
  integrations?: RuntimeTelemetryIntegrationsConfig;
}

/**
 * 平台运行时配置。
 *
 * 第一性原则：
 *   - 启动期 / 部署期 / 平台级能力放 ssr.config.ts 的 runtime
 *   - 请求期业务逻辑仍放 entry.server.tsx hooks
 */
export interface RuntimeConfig {
  /** 站点公网 base URL，用于 SEO canonical / sitemap / robots */
  site?: string;
  /** 按职责拆开的后端服务 origin */
  services?: RuntimeServicesConfig;
  /** 分布式 ISR 缓存与跨实例失效广播 */
  redis?: RuntimeRedisConfig;
  /**
   * 站点入口限流。
   *
   * 默认 store='auto'：检测到 Redis 连接时自动用 Redis 做分布式限流，
   * 否则用进程内 memory。消费方一般无需显式设置 store。
   * 多实例生产环境仍应优先使用 CDN/WAF/API Gateway 做第一层限流。
   */
  rateLimit?: RuntimeRateLimitConfig;
  /** A/B testing / experimentation 定义，供 getVariant() 在 Server Component 中读取 */
  experiments?: Record<string, RuntimeExperimentConfig>;
  /** i18n 字典源配置；请求期加载由 engine 默认 SiteHooks 消费 */
  i18n?: RuntimeI18nConfig;
  /** 页面 SEO 元数据源配置；站点 canonical/sitemap base URL 统一来自 runtime.site */
  seo?: RuntimeSeoConfig;
  /**
   * telemetry 上报配置。engine 会把浏览器安全子集序列化到 client entry，
   * 自动接入 page_view、Web Vitals、全局错误、资源加载失败、Server Action 错误；
   * 服务端渲染异常会通过同一个 errors endpoint 非阻塞上报。
   */
  telemetry?: false | RuntimeTelemetryConfig;
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

  /*
   * No public `cache` field by design.
   *
   * Page cache backend selection is derived from explicit runtime.redis:
   *   - runtime.redis.url/host => L1 memory + L2 Redis
   *   - no Redis connection => in-process memory
   *
   * Page TTL belongs to routes[*].ttl or top-level revalidate. Keeping backend and TTL
   * in separate product-level fields avoids asking every business app to know
   * cache-store internals.
   */

  /**
   * 全局默认页面缓存 TTL（秒）。
   *
   * routes[*].ttl 优先；未声明路由级 TTL 时使用这里。
   * 这是产品层缓存新鲜度，不是 Redis/memory 后端配置。
   */
  revalidate: number;

  server?: {
    /** Node origin 监听端口；缺省 3000。 */
    port?: number;
    /** Node origin 监听地址；通常本地留空，容器/内网按部署平台注入。 */
    host?: string;
    /**
     * 运维端点暴露策略。
     *
     * 公开配置只保留稳定运维边界：
     *   - /health：健康检查，默认启用且公开
     *   - /metrics：Prometheus 文本指标，默认关闭；生产开启时建议配置 authToken
     *
     * Cache debug JSON 不作为产品配置面；生产观测使用 Prometheus /metrics。
     */
    ops?: {
      /** 共享运维口令；接受 `Authorization: Bearer <token>` 或 tokenHeader 指定 header */
      authToken?: string;
      /** 自定义 header 名，默认 `x-isr-admin-token` */
      tokenHeader?: string;
      health?: {
        enabled?: boolean;
        public?: boolean;
      };
      metrics?: {
        enabled?: boolean;
        public?: boolean;
      };
    };
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

export interface ResolvedISRConfig extends ISRConfig {
  renderMode: RenderModeType;
  routes: Record<string, RouteRule>;
  cache: {
    strategy: CacheStrategyType;
    ttl: number;
  };
}
