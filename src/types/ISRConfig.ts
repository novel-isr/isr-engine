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
/**
 * 路由级规则（对象形式）—— 允许精细控制 TTL 与 stale-while-revalidate 窗口
 */
export interface RouteRuleObject {
  mode: RenderModeType;
  /** TTL（秒），覆盖全局 revalidate 默认值；不覆盖时显式写 undefined */
  ttl: number | undefined;
  /** stale-while-revalidate 窗口（秒）；不覆盖时显式写 undefined */
  staleWhileRevalidate: number | undefined;
}

/**
 * 路由规则 —— 字符串 shorthand 或完整对象
 *   'isr'                                        使用全局 revalidate
 *   { mode: 'isr', ttl: 60, staleWhileRevalidate: 300 }
 */
export type RouteRule = RenderModeType | RouteRuleObject;

export interface RuntimeRedisConfig {
  /** 完整 Redis URL（redis://[:pass@]host:port/db），优先级高于 host/port */
  url: string | undefined;
  host: string | undefined;
  port: number | undefined;
  password: string | undefined;
  /** 页面缓存 key 前缀，默认由 cache layer 使用 isr: */
  keyPrefix: string | undefined;
  /** 跨实例 revalidate 广播频道 */
  invalidationChannel: string | undefined;
}

export interface RuntimeExperimentConfig {
  variants: readonly string[];
  weights: readonly number[] | undefined;
}

/**
 * 实验定义动态拉取（manifest）
 *
 * admin-server 暴露 GET /api/experiments/manifest，返回 { version, experiments }
 * engine 启动 + 60s 轮询，运营改 weights/status 不重启 server 即生效。
 *
 * fallbackOnError 三档：
 *   'cache'  → 用上一次拉成功的快照（默认；推荐）
 *   'static' → 退回 runtime.experiments 静态配置
 *   'empty'  → 关闭所有实验，回 control
 *
 * 不配 endpoint → 完全跳过 manifest 拉取，仅用静态 experiments；行为同当前。
 */
export interface RuntimeExperimentManifestConfig {
  endpoint: string;
  refreshIntervalMs: number | undefined;
  fallbackOnError: 'cache' | 'static' | 'empty' | undefined;
  authHeader: { name: string; value: string } | undefined;
}

/**
 * 曝光上报（exposure tracking）
 *
 * engine ABVariantMiddleware 算完变体之后异步入队，批量 POST 给 admin-server。
 * 完全 fire-and-forget，业务渲染不等。失败丢弃 + 日志，不影响业务。
 *
 * 不配 endpoint → 完全跳过上报；本地开发 / 不需要数据时省心。
 */
export interface RuntimeExperimentTrackingConfig {
  endpoint: string;
  batchSize: number | undefined;
  flushIntervalMs: number | undefined;
  sampleRate: number | undefined;
  enabled: boolean | undefined;
}

export interface RuntimeI18nConfig {
  /** 支持的 locale 列表，用于 URL locale 前缀解析和请求协商 */
  locales: readonly string[];
  /** 默认 locale；不配置时取 locales[0] */
  defaultLocale: string;
  /** 默认 locale 是否带 URL 前缀 */
  prefixDefault: boolean;
  /** 远端字典端点；相对路径会拼到 services.api 上 */
  endpoint: string | undefined;
  /** 本地兜底字典；配置 API 不可用时使用 */
  fallbackLocal: Record<string, Record<string, unknown>> | undefined;
  /** 字典缓存 TTL（毫秒） */
  ttl: number;
  /** 远端请求超时（毫秒） */
  timeoutMs: number;
  /** 响应头 / dev inspector 里显示的远端来源名 */
  remoteSource: string;
  /** 响应头 / dev inspector 里显示的本地兜底来源名 */
  fallbackSource: string;
}

/**
 * 动态 SEO 解析器 —— 用于参数化路径（/books/:id / /u/:handle 等）。
 *
 * 设计目标：让业务页面**完全不写 SEO 代码**（不再需要 page export const seo /
 * generateSeo）。所有动态 SEO 在 ssr.config.ts 一处集中声明：
 *
 *   runtime.seo.dynamicResolvers = [
 *     { pattern: '/books/:id', resolve: async ({ params, services }) => {
 *         const r = await fetch(`${services.api}/books/${params.id}`);
 *         if (!r.ok) return null;
 *         const book = await r.json();
 *         return { title: book.title, description: book.synopsis, ... };
 *       }
 *     },
 *   ];
 *
 * 解析顺序（高 → 低）：
 *   1. admin endpoint 命中（运营在 dashboard 给具体 path 配过的覆盖）
 *   2. dynamicResolvers pattern 匹配（业务侧请求期数据驱动）
 *   3. fallbackLocal exact path 命中
 *   4. 都没 → null（前端 head 走默认）
 */
export interface DynamicSeoResolver {
  /**
   * 路径 pattern。支持 `:name` 命名参数（贪婪到 `/`）和 `*` 通配后缀。
   * 例：`/books/:id`、`/u/:handle`、`/dashboard/*`
   */
  pattern: string;
  /**
   * 命中后的 resolver。返回 PageSeoMeta（平铺）或 null。
   * 抛错会被引擎吞掉并写到 onError，不会导致 SSR 失败。
   *
   * input.params 包含 pattern 里 :name 解析出的值。
   * input.locale 是当前请求 locale（可能 undefined，特别是没启 i18n 时）。
   * input.services / input.runtime 给到完整 runtime context，可拿 api origin。
   */
  resolve: (input: {
    pathname: string;
    params: Record<string, string>;
    locale?: string;
    services: { api?: string; telemetry?: string };
  }) => Promise<Record<string, unknown> | null> | Record<string, unknown> | null;
}

export interface RuntimeSeoConfig {
  /** 远端 SEO 端点；支持 {pathname} */
  endpoint: string | undefined;
  /** 本地兜底 SEO 路由表；配置 API 不可用时使用 */
  fallbackLocal: readonly Record<string, unknown>[] | undefined;
  /** SEO 元数据缓存 TTL（毫秒） */
  ttl: number;
  /** 远端请求超时（毫秒） */
  timeoutMs: number;
  /**
   * 参数化路径的 SEO 解析器。
   * admin endpoint / fallbackLocal 是 path 完全匹配的，无法处理 /books/:id
   * 这种动态路径；这里集中声明所有动态路径的 SEO 拼装逻辑，业务页面不再写
   * generateSeo。详见 DynamicSeoResolver 注释。
   */
  dynamicResolvers: readonly DynamicSeoResolver[] | undefined;
}

export interface RuntimeServicesConfig {
  /** 默认后端 API origin；业务数据、配置中心、mock fixture 都走这里 */
  api: string | undefined;
  /** telemetry 上报 origin；不配置时回退到 api，同源部署可留空 */
  telemetry: string | undefined;
}

/**
 * 浏览器侧 telemetry endpoint 公共配置 ——
 *
 * 业务真正需要决定的只有两件事：
 *   - endpoint：往哪发（每个 app 自己的 admin / collector 地址）
 *   - sampleRate：采多少（成本 vs 可见度）
 *
 * 砍掉的 batchSize / flushIntervalMs / maxQueueSize / retryBaseDelayMs / retryMaxDelayMs：
 * 不是业务决策，是 SDK 内部参数。engine 在 client serializer 里给业界默认值
 * （batch=20/10、flush=3s、queue=500/200、retry=1s..30s 指数退避），跟 Sentry /
 * Datadog SDK 同档；要调整这些非业务侧关心，应该是 SDK 层面而不是 ssr.config.ts。
 */
export interface RuntimeTelemetryEndpointOptions {
  /** 远端上报地址；相对路径会拼到 services.telemetry/api 上 */
  endpoint: string | undefined;
  /** 采样率，0..1；1 = 全采 */
  sampleRate: number;
}

export interface RuntimeTelemetryEventsConfig extends RuntimeTelemetryEndpointOptions {
  /** 是否自动上报首屏 page_view；默认 true */
  trackInitialPage: boolean;
}

export interface RuntimeTelemetryErrorsConfig extends RuntimeTelemetryEndpointOptions {
  /** 是否采集 script/link/img 等资源加载失败；默认 true */
  captureResourceErrors: boolean;
}

export interface RuntimeTelemetryWebVitalsConfig {
  /** 是否自动采集 Web Vitals；覆盖 FCP/LCP/CLS/INP/TTFB 等前端体验指标 */
  enabled: boolean;
}

export interface RuntimeTelemetrySentryIntegrationConfig {
  /** 是否启用 Sentry integration；默认 false，避免仅配置环境变量就隐式接入第三方平台 */
  enabled: boolean;
  /** Sentry DSN；enabled=true 但不配置时 engine 会跳过 adapter 并记录 warn */
  dsn: string | undefined;
  tracesSampleRate: number | undefined;
  environment: string | undefined;
  release: string | undefined;
}

export interface RuntimeTelemetryDatadogExporterConfig {
  type: 'datadog';
  name: string | undefined;
  required: boolean | undefined;
  service: string | undefined;
}

export interface RuntimeTelemetryOtelExporterConfig {
  type: 'otel';
  name: string | undefined;
  required: boolean | undefined;
  endpoint: string | undefined;
  serviceName: string | undefined;
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
  sentry: RuntimeTelemetrySentryIntegrationConfig | undefined;
}

export interface RuntimeTelemetryConfig {
  /** 应用名；不配置时读取 package.json name */
  app: string | undefined;
  /** 发布版本，用于错误归因和发布影响分析 */
  release: string | undefined;
  /** 当前环境：development/staging/production */
  environment: string | undefined;
  /** 是否把 query string 纳入 URL；默认 false，避免采集敏感参数 */
  includeQueryString: boolean;
  /** 前端事件/PV 埋点配置；false 表示关闭 events */
  events: false | RuntimeTelemetryEventsConfig;
  /** 前端错误上报配置；false 表示关闭 errors */
  errors: false | RuntimeTelemetryErrorsConfig;
  /** Web Vitals 配置；false 表示关闭性能指标 */
  webVitals: false | RuntimeTelemetryWebVitalsConfig;
  /**
   * 额外 collector 出口。第一方 HTTP 上报不放这里，唯一真值源是
   * events.endpoint / errors.endpoint，避免同一个地址配置两遍。
   * 当前没有 Datadog/OTel collector 时应保持 []；Sentry 这类完整 SDK 平台放
   * integrations，不降级为普通 exporter。
   */
  exporters: readonly RuntimeTelemetryExporterConfig[];
  /** 第三方平台集成，和第一方 endpoint telemetry 并列挂在 telemetry 下面 */
  integrations: RuntimeTelemetryIntegrationsConfig;
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
  site: string | undefined;
  /**
   * Cookie 跨子域共享的 Domain 属性。
   *
   * 用法：
   *   - **子域分发部署**（www.x / admin.x / api.x）：设 `.your-domain.com`
   *     —— engine 写 anon cookie 时带 `Domain=.your-domain.com`，浏览器自动
   *     带到所有子域；SSR 在 www 写、API 在 api 读、客户端在 www 读都拿得到。
   *   - **单一域名**（path-based routing）：留空 undefined，cookie 关联当前 host
   *     即可，更严格的 same-origin。
   *   - **localhost**：留空。浏览器对 `Domain=localhost` 处理不一致，反而出问题
   */
  cookieDomain?: string;
  /** 按职责拆开的后端服务 origin */
  services: RuntimeServicesConfig;
  /** 分布式 ISR 缓存与跨实例失效广播 */
  redis: RuntimeRedisConfig | undefined;
  /** A/B testing / experimentation 定义，供 getVariant() 在 Server Component 中读取 */
  experiments: Record<string, RuntimeExperimentConfig>;
  /** 实验定义从 admin-server 动态拉取（manifest）；不配则只用 experiments 静态配置 */
  experimentManifest?: RuntimeExperimentManifestConfig;
  /** 曝光事件上报（server-side fire-and-forget）；不配则不上报 */
  experimentTracking?: RuntimeExperimentTrackingConfig;
  /** i18n 字典源配置；请求期加载由 engine 默认 SiteHooks 消费 */
  i18n: RuntimeI18nConfig | undefined;
  /** 页面 SEO 元数据源配置；站点 canonical/sitemap base URL 统一来自 runtime.site */
  seo: RuntimeSeoConfig | undefined;
  /**
   * telemetry 上报配置。engine 会把浏览器安全子集序列化到 client entry，
   * 自动接入 page_view、Web Vitals、全局错误、资源加载失败、Server Action 错误；
   * 服务端渲染异常会通过同一个 errors endpoint 非阻塞上报。
   */
  telemetry: false | RuntimeTelemetryConfig;
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
   * 路由级别覆盖配置。
   * 没有覆盖时显式写 `{}`，这样 ssr.config.ts 不存在隐藏默认值。
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
  routes: Record<string, RouteRule>;

  /**
   * 平台运行时配置。
   *
   * 这些是稳定的部署/启动配置，成熟项目应放在 ssr.config.ts，而不是散落在
   * entry.server.tsx 里。entry.server.tsx 只负责如何在请求期使用这些配置。
   */
  runtime: RuntimeConfig;

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

  server: {
    /** Node origin 监听端口；缺省 3000。 */
    port: number;
    /** Node origin 监听地址；通常本地留空，容器/内网按部署平台注入。 */
    host: string | undefined;
    /**
     * 端口严格模式。
     *
     * - true：端口被占用时启动失败，适合生产 / 容器 / CI，避免服务悄悄跑到错误端口。
     * - false：端口被占用时最多尝试后续 20 个端口，适合本地 dev。
     *
     * 不配置时 engine 默认 dev=false、prod=true；成熟业务建议在 ssr.config.ts 显式写出。
     */
    strictPort: boolean;
    /**
     * 运维端点暴露策略。
     *
     * 公开配置保留稳定运维边界：
     *   - /health：健康检查，默认启用且公开
     *   - /metrics：Prometheus 文本指标，默认关闭；生产开启时建议配置 authToken
     *   - /__isr/cache/inventory：当前 L1 缓存条目元数据 + 最近 invalidate 时间。
     *     dev 默认 public 开放；prod 默认 enabled + 强制 authToken（故障诊断工具
     *     事故来时才用，常驻必要 —— 没 token 时 resolveOpsConfig 自动 disable 且出 warning）。
     *
     * 长期指标 / 报警 / 可视化由 Prometheus + Grafana 承担，engine 不做。
     */
    ops: {
      /** 共享运维口令；接受 `Authorization: Bearer <token>` 或 tokenHeader 指定 header */
      authToken: string | undefined;
      /** 自定义 header 名，默认 `x-isr-admin-token` */
      tokenHeader: string;
      health: {
        enabled: boolean;
        public: boolean;
      };
      metrics: {
        enabled: boolean;
        public: boolean;
      };
      inventory: {
        enabled: boolean;
        public: boolean;
      };
    };
  };

  /** SSG 预生成配置 */
  ssg: {
    /** 显式 SSG 路由列表（可选，优先级高于 routes 中 mode=ssg 的条目） */
    routes: readonly string[] | (() => readonly string[] | Promise<readonly string[]>);
    /** 并发度，默认 3 */
    concurrent: number;
    /** 单页请求超时毫秒，默认 30_000；防 hang 拖死整个 build */
    requestTimeoutMs: number;
    /** 单页最大重试次数（不含首次），默认 3；只重试 timeout/network/5xx，不重试 4xx */
    maxRetries: number;
    /** 重试初始退避毫秒，默认 200；指数退避 = base * 2^(N-1) */
    retryBaseDelayMs: number;
    /**
     * 整体失败率阈值（0-1），默认 0.05（5%）；超过则 build 失败。
     * 设 1.0 关闭（不推荐——会 mask 真实问题）。设 0 = 任何失败都 fail build。
     */
    failBuildThreshold: number;
  };
}
